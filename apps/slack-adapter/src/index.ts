export { createSlackApp } from "./app.ts";
export { CanvasProjectionService, syncCanvasProjection } from "./canvas-service.ts";
export { GitHubCliDependencies } from "./github-cli.ts";
export { buildCreateIssueCommand } from "./issue-command.ts";
export { workItemBlocks } from "./presentation.ts";
export { createProjectList, syncProjectList } from "./project-list.ts";
export {
  allAccessibleScope,
  projectionStateKey,
  repositoryScope,
  validateProjectionBinding,
} from "./project-scope.ts";
export { toHumanWorkItem } from "./read-model.ts";
export { SlackWorkNotifier } from "./slack-work-notifier.ts";
export type { CreatedIssue, CreateIssueCommand, HumanWorkItem, WorkItemSnapshot } from "./types.ts";
export { WorkNotificationService } from "./work-notification-service.ts";
