export type IssueTemplateId = string;

export interface IssueFieldSchema {
  id: string;
  label: string;
  kind: "input" | "textarea" | "select";
  required: boolean;
  options?: string[];
  initialValue?: string;
}

/**
 * Repository側にIssue Formがまだ導入されていない場合に使う最小の共通schema。
 *
 * これはrepositoryのtemplate一覧に混ぜず、adapterが「未導入」を検知したときだけ
 * pickerへ提示する。したがって既存templateの表示や権限判定を置き換えない。
 */
export const GENERIC_ISSUE_TEMPLATE: IssueTemplateSchema = {
  id: "generic",
  name: "標準Issue（テンプレート未導入）",
  titlePrefix: "[Issue] ",
  labels: ["type/intake", "status/triage"],
  fields: [
    { id: "summary", label: "内容", kind: "textarea", required: true },
    {
      id: "done",
      label: "完了条件（任意）",
      kind: "textarea",
      required: false,
      initialValue: "- [ ] 内容を確認する",
    },
  ],
};

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
      {
        id: "hierarchy",
        label: "階層",
        kind: "select",
        required: true,
        options: ["トップレベル成果", "既存Issueの子"],
      },
      { id: "parent", label: "親Issue", kind: "input", required: false },
      { id: "background", label: "背景", kind: "textarea", required: true },
      { id: "outcome", label: "完成するとどうなるか", kind: "textarea", required: true },
      { id: "done", label: "完了条件", kind: "textarea", required: true, initialValue: "- [ ] " },
      { id: "scope", label: "対象・影響・触らない範囲", kind: "textarea", required: true },
      { id: "out_of_scope", label: "今回やらないこと", kind: "textarea", required: false },
      { id: "known_constraints", label: "既知の制約・懸念", kind: "textarea", required: false },
      { id: "verification", label: "確認方法", kind: "textarea", required: true },
      {
        id: "acceptance",
        label: "依頼者の受入確認（必要な場合）",
        kind: "textarea",
        required: false,
      },
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
      {
        id: "boundaries",
        label: "触ってよい範囲・触らない範囲",
        kind: "textarea",
        required: false,
      },
    ],
  },
  {
    id: "business",
    name: "営業・業務変更",
    titlePrefix: "[Business] ",
    labels: ["type/business", "status/todo", "merge/review"],
    fields: [
      {
        id: "hierarchy",
        label: "階層",
        kind: "select",
        required: true,
        options: ["トップレベル成果", "既存Issueの子"],
      },
      { id: "parent", label: "親Issue", kind: "input", required: false },
      { id: "current", label: "現状", kind: "textarea", required: true },
      { id: "change", label: "変更する文書・条件・運用", kind: "textarea", required: true },
      { id: "approval", label: "誰が何を確認すればよいか", kind: "textarea", required: true },
      { id: "scope", label: "対象・影響・触らない範囲", kind: "textarea", required: true },
      { id: "out_of_scope", label: "今回やらないこと", kind: "textarea", required: false },
      { id: "known_constraints", label: "既知の制約・懸念", kind: "textarea", required: false },
      { id: "verification", label: "確認方法", kind: "textarea", required: true },
      {
        id: "merge",
        label: "マージ方式",
        kind: "select",
        required: true,
        options: ["通常レビュー（既定）", "自分でマージ可", "緊急マージ（事後レビュー必須）"],
      },
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

/**
 * Remote templateが空のrepositoryでだけ共通fallbackを解決する。
 * remote templateが存在するのに未知のidを受け取った場合は、誤ったschemaでの作成を防ぐためnullを返す。
 */
export function resolveIssueTemplate(
  templates: IssueTemplateSchema[],
  id: IssueTemplateId,
): IssueTemplateSchema | null {
  return (
    templates.find((candidate) => candidate.id === id) ??
    (templates.length === 0 && id === GENERIC_ISSUE_TEMPLATE.id ? GENERIC_ISSUE_TEMPLATE : null)
  );
}

export function issueTemplate(id: IssueTemplateId): IssueTemplateSchema {
  const schema = ISSUE_TEMPLATES.find((candidate) => candidate.id === id);
  if (!schema) {
    throw new Error(`未対応のIssue templateです: ${id}`);
  }
  return schema;
}
