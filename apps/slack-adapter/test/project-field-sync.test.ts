import { describe, expect, test } from "bun:test";
import {
  type GraphqlRequest,
  normalizeProjectFieldInput,
  syncProjectFields,
} from "../src/project-field-sync.ts";

describe("GitHub Project field sync", () => {
  test("既存itemと同値fieldを再利用し、retryでitemや更新を重複させない", async () => {
    let itemId: string | null = null;
    const values = new Map<string, string>();
    let adds = 0;
    let updates = 0;
    const request: GraphqlRequest = async <T>(
      query: string,
      variables: Record<string, unknown>,
    ) => {
      if (query.includes("query ArttraProjectFieldState")) {
        return envelope(state(itemId, values, ["alice"])) as T;
      }
      if (query.includes("mutation ArttraAddProjectItem")) {
        adds += 1;
        itemId = "PVTI_item";
        return envelope({ addProjectV2ItemById: { item: { id: itemId } } }) as T;
      }
      if (query.includes("mutation ArttraUpdateProjectField")) {
        updates += 1;
        const field = fields.find((candidate) => candidate.id === variables.fieldId);
        const value = variables.value as { singleSelectOptionId?: string; date?: string };
        const selected =
          field && "options" in field
            ? field.options.find((option) => option.id === value.singleSelectOptionId)
            : undefined;
        if (!field || (!selected && !value.date)) throw new Error("invalid fake mutation");
        values.set(field.name, selected?.name ?? value.date ?? "");
        return envelope({ updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } }) as T;
      }
      throw new Error("unexpected GraphQL operation");
    };
    const input = {
      request,
      project: { owner: "art-tra2021", number: 8 },
      issue: { id: "I_issue", url: "https://github.example/issues/42" },
      values: {
        priority: "P1" as const,
        size: "M" as const,
        startDate: "2026-08-04",
        targetDate: "2026-08-10",
        status: "Ready" as const,
      },
      assignees: ["alice"],
    };

    const first = await syncProjectFields(input);
    const second = await syncProjectFields(input);

    expect(first.status).toBe("synced");
    expect(first.itemCreated).toBe(true);
    expect(first.fields.every((field) => field.actual !== null)).toBe(true);
    expect(second.status).toBe("synced");
    expect(second.itemCreated).toBe(false);
    expect(second.fields.every((field) => field.status === "unchanged")).toBe(true);
    expect(adds).toBe(1);
    expect(updates).toBe(5);
  });

  test("field単位の部分失敗と再実行方法を構造化する", async () => {
    const request: GraphqlRequest = async <T>(query: string) => {
      if (query.includes("query ArttraProjectFieldState")) {
        return envelope(state("PVTI_item", new Map([["Priority", "P2"]]), ["alice"])) as T;
      }
      if (query.includes("mutation ArttraUpdateProjectField")) {
        throw new Error("Resource not accessible by integration");
      }
      throw new Error("unexpected GraphQL operation");
    };
    const result = await syncProjectFields({
      request,
      project: { owner: "art-tra2021", number: 8 },
      issue: { id: "I_issue", url: "https://github.example/issues/42" },
      values: { priority: "P2", size: "L" },
      assignees: ["alice"],
    });

    expect(result.status).toBe("partial");
    expect(result.fields).toContainEqual(
      expect.objectContaining({ field: "Priority", status: "unchanged", actual: "P2" }),
    );
    expect(result.fields).toContainEqual(
      expect.objectContaining({
        field: "Size",
        status: "failed",
        message: "Resource not accessible by integration",
      }),
    );
    expect(result.recovery).toMatchObject({
      retryable: true,
      operation: "project-field-sync",
      issueUrl: "https://github.example/issues/42",
    });
    expect(result.recovery.instructions.join(" ")).toContain("新しいIssueを作らない");
  });

  test("Project #8の列挙値と実在日だけを受け付ける", () => {
    expect(
      normalizeProjectFieldInput({
        priority: "P0",
        size: "XL",
        startDate: "2026-08-04",
        targetDate: "2026-08-31",
        status: "In review",
      }),
    ).toEqual({
      priority: "P0",
      size: "XL",
      startDate: "2026-08-04",
      targetDate: "2026-08-31",
      status: "In review",
    });
    expect(() => normalizeProjectFieldInput({ startDate: "2026-02-30" })).toThrow("実在する日付");
  });
});

const fields = [
  selectField("F_priority", "Priority", ["P0", "P1", "P2", "P3"]),
  selectField("F_size", "Size", ["S", "M", "L", "XL"]),
  { id: "F_start", name: "Start date", dataType: "DATE" },
  { id: "F_target", name: "Target date", dataType: "DATE" },
  selectField("F_status", "Status", [
    "Intake",
    "Ready",
    "Urgent (unstarted)",
    "In progress",
    "Blocked",
    "In review",
    "Done",
  ]),
];

function selectField(id: string, name: string, names: string[]) {
  return {
    id,
    name,
    dataType: "SINGLE_SELECT",
    options: names.map((value) => ({ id: `${id}_${value}`, name: value })),
  };
}

function envelope<T>(data: T) {
  return { data };
}

function state(itemId: string | null, values: Map<string, string>, assignees: string[]) {
  return {
    organization: {
      projectV2: { id: "PVT_project", fields: { totalCount: fields.length, nodes: fields } },
    },
    node: {
      id: "I_issue",
      assignees: { nodes: assignees.map((login) => ({ login })) },
      projectItems: {
        totalCount: itemId ? 1 : 0,
        nodes: itemId
          ? [
              {
                id: itemId,
                project: { id: "PVT_project" },
                fieldValues: {
                  totalCount: values.size,
                  nodes: [...values].map(([name, value]) => ({
                    ...(name.endsWith("date") ? { date: value } : { name: value }),
                    field: { name },
                  })),
                },
              },
            ]
          : [],
      },
    },
  };
}
