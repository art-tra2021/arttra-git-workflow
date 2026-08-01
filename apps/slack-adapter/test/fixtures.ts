import type { WorkItemSnapshot } from "../src/types.ts";

export function snapshot(overrides: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot {
  return {
    schemaVersion: 1,
    issue: {
      number: 23,
      title: "Slack通知を人間向けにする",
      url: "https://github.com/example/repo/issues/23",
      type: "work",
    },
    project: { status: "in-progress", priority: "P1", owner: "rozwer", targetDate: null },
    relationships: { blockedBy: [] },
    pullRequest: null,
    ...overrides,
  };
}
