import { IssueApprovalService } from "./approval.ts";
import { createStateStoreFromEnvironment } from "./state-store-factory.ts";

const approvalId = process.argv[2]?.trim();
if (!approvalId) {
  throw new Error("承認IDを指定してください。例: mise run slack:approval -- <approval-id>");
}

const approval = await new IssueApprovalService(createStateStoreFromEnvironment()).status(
  approvalId,
);
if (!approval) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, found: false, id: approvalId })}\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, found: true, approval }, null, 2)}\n`);
}
