export type IssueTemplateId = string;

export interface IssueFieldSchema {
  id: string;
  label: string;
  kind: "input" | "textarea" | "select";
  required: boolean;
  options?: string[];
  initialValue?: string;
}

export interface IssueTemplateSchema {
  id: IssueTemplateId;
  name: string;
  titlePrefix: string;
  labels: string[];
  fields: IssueFieldSchema[];
}

export const ISSUE_TEMPLATES: IssueTemplateSchema[] = [
  {
    id: "intake",
    name: "相談・受付",
    titlePrefix: "[Intake] ",
    labels: ["type/intake", "status/triage"],
    fields: [
      { id: "summary", label: "何がありましたか", kind: "textarea", required: true },
      {
        id: "urgency",
        label: "急ぎですか",
        kind: "select",
        required: true,
        options: ["通常", "急ぎ・まだ誰も着手していない", "判断できない"],
      },
    ],
  },
  {
    id: "work",
    name: "作業チケット",
    titlePrefix: "[Work] ",
    labels: ["type/work", "status/todo"],
    fields: [
      { id: "background", label: "背景", kind: "textarea", required: true },
      { id: "outcome", label: "完成するとどうなるか", kind: "textarea", required: true },
      { id: "done", label: "完了条件", kind: "textarea", required: true, initialValue: "- [ ] " },
      {
        id: "merge",
        label: "マージ方式",
        kind: "select",
        required: true,
        options: ["通常レビュー（既定）", "自分でマージ可", "緊急マージ（事後レビュー必須）"],
      },
      { id: "blocked_by", label: "ブロック元", kind: "input", required: false },
      { id: "target_date", label: "目標日", kind: "input", required: false },
    ],
  },
  {
    id: "task",
    name: "小タスク",
    titlePrefix: "[Task] ",
    labels: ["type/task", "status/todo"],
    fields: [
      { id: "parent", label: "親の作業チケット", kind: "input", required: true },
      { id: "action", label: "やること", kind: "textarea", required: true },
      { id: "done", label: "完了条件", kind: "textarea", required: true, initialValue: "- [ ] " },
    ],
  },
  {
    id: "business",
    name: "営業・業務変更",
    titlePrefix: "[Business] ",
    labels: ["type/business", "status/todo", "merge/review"],
    fields: [
      { id: "current", label: "現状", kind: "textarea", required: true },
      { id: "change", label: "変更する文書・条件・運用", kind: "textarea", required: true },
      { id: "approval", label: "誰が何を確認すればよいか", kind: "textarea", required: true },
      { id: "target_date", label: "目標日", kind: "input", required: false },
    ],
  },
  {
    id: "experiment",
    name: "Git運用実験",
    titlePrefix: "[Experiment] ",
    labels: ["experiment"],
    fields: [
      { id: "hypothesis", label: "仮説", kind: "textarea", required: true },
      { id: "procedure", label: "試すこと", kind: "textarea", required: true },
      { id: "observation", label: "観測すること", kind: "textarea", required: true },
      { id: "result", label: "結果", kind: "textarea", required: false },
    ],
  },
];

export function issueTemplate(id: IssueTemplateId): IssueTemplateSchema {
  const schema = ISSUE_TEMPLATES.find((candidate) => candidate.id === id);
  if (!schema) {
    throw new Error(`未対応のIssue templateです: ${id}`);
  }
  return schema;
}
