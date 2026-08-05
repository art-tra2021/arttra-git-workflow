import { WebClient } from "@slack/web-api";
import {
  DelegatingNotificationPayloadSender,
  NotificationOutboxError,
  NotificationOutboxService,
  type NotificationReplayCommand,
} from "./notification-outbox.ts";
import { SlackDirectLifecycleNotifier, SlackDirectWorkNotifier } from "./slack-direct-notifier.ts";
import { SlackLifecycleNotifier } from "./slack-lifecycle-notifier.ts";
import {
  type SlackConversationClient,
  SlackNotificationReconciler,
} from "./slack-notification-reconciler.ts";
import { SlackWorkNotifier } from "./slack-work-notifier.ts";
import { createStateStoreFromEnvironment } from "./state-store-factory.ts";

const command = process.argv[2] ?? "audit";
const arguments_ = process.argv.slice(3);
const json = arguments_.includes("--json");

try {
  const store = createStateStoreFromEnvironment();

  if (command === "audit") {
    rejectUnknown(arguments_, new Set(["--json", "--all"]));
    flag(arguments_, "--json");
    const outbox = new NotificationOutboxService(
      store,
      { send: async () => ({ messageTs: null }) },
      {
        channelId: workChannelId() ?? "COUTBOXAUDIT",
      },
    );
    const result = await outbox.audit(flag(arguments_, "--all"));
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      printAudit(result);
    }
  } else if (command === "replay") {
    rejectUnknown(
      arguments_,
      new Set([
        "--intent",
        "--expected-revision",
        "--operator",
        "--command-json",
        "--dry-run",
        "--yes",
        "--json",
      ]),
    );
    flag(arguments_, "--json");
    const commandJson = optionalArgument(arguments_, "--command-json");
    const replayCommand = commandJson
      ? parseReplayCommand(commandJson, arguments_)
      : {
          schemaVersion: 1 as const,
          intentId: requiredArgument(arguments_, "--intent"),
          expectedRevision: positiveInteger(
            requiredArgument(arguments_, "--expected-revision"),
            "--expected-revision",
          ),
          operatorId: requiredArgument(arguments_, "--operator"),
          dryRun: flag(arguments_, "--dry-run"),
          confirmed: flag(arguments_, "--yes"),
        };
    const channelId = requiredWorkChannelId();
    const slack = new WebClient(required("SLACK_BOT_TOKEN"));
    const lifecycle = new SlackLifecycleNotifier(slack, channelId);
    const work = new SlackWorkNotifier(slack, channelId);
    const outbox = new NotificationOutboxService(
      store,
      new DelegatingNotificationPayloadSender(lifecycle, work, (slackUserId) => ({
        lifecycle: new SlackDirectLifecycleNotifier(slack, slackUserId),
        work: new SlackDirectWorkNotifier(slack, slackUserId),
      })),
      {
        channelId,
        replayOperatorIds: csv("AR_NOTIFICATION_REPLAY_OPERATOR_IDS"),
        reconciler: new SlackNotificationReconciler(
          slack as unknown as SlackConversationClient,
          store,
        ),
      },
    );
    const result = await outbox.replay(replayCommand);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      console.log(result.reason);
      console.log(
        `intent=${result.intentId} action=${result.action} status=${result.status} revision=${result.afterRevision}`,
      );
    }
  } else {
    throw new NotificationOutboxError(
      "notification_outbox_command_invalid",
      "auditまたはreplayを指定してください。",
    );
  }
} catch (error) {
  const code = error instanceof NotificationOutboxError ? error.code : "notification_outbox_error";
  const message = error instanceof Error ? error.message : "通知outboxの操作に失敗しました。";
  if (json) {
    console.error(
      JSON.stringify({ ok: false, schemaVersion: 1, error: { code, message } }, null, 2),
    );
  } else {
    console.error(`エラー: ${message}`);
  }
  process.exitCode = 1;
}

function printAudit(result: Awaited<ReturnType<NotificationOutboxService["audit"]>>): void {
  console.log(
    `通知outbox: 要対応${result.summary.actionable}件 / intent ${result.summary.notificationIntents}件 / 旧delivery ${result.summary.legacyDeliveries}件`,
  );
  if (result.items.length === 0) {
    console.log("要対応の通知はありません。");
    return;
  }
  for (const item of result.items) {
    console.log(
      `- ${item.kind} ${item.id} status=${item.status} revision=${item.revision ?? "-"}: ${item.reason}`,
    );
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new NotificationOutboxError(
      "notification_outbox_environment_required",
      `${name}が未設定です。apps/slack-adapter/.env.exampleを確認してください。`,
    );
  }
  return value;
}

function workChannelId(): string | null {
  return (
    process.env.AR_SLACK_WORK_CHANNEL_ID?.trim() ||
    process.env.AR_SLACK_PROJECT_LIST_CHANNEL_ID?.trim() ||
    null
  );
}

function requiredWorkChannelId(): string {
  const value = workChannelId();
  if (!value) {
    throw new NotificationOutboxError(
      "notification_outbox_environment_required",
      "AR_SLACK_WORK_CHANNEL_IDまたはAR_SLACK_PROJECT_LIST_CHANNEL_IDを設定してください。",
    );
  }
  return value;
}

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requiredArgument(arguments_: string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index >= 0 ? arguments_[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new NotificationOutboxError(
      "notification_outbox_argument_required",
      `${name}を指定してください。`,
    );
  }
  if (arguments_.indexOf(name, index + 1) >= 0) {
    throw new NotificationOutboxError(
      "notification_outbox_argument_duplicated",
      `${name}は一度だけ指定してください。`,
    );
  }
  return value;
}

function optionalArgument(arguments_: string[], name: string): string | null {
  const index = arguments_.indexOf(name);
  if (index < 0) return null;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new NotificationOutboxError(
      "notification_outbox_argument_required",
      `${name}に値を指定してください。`,
    );
  }
  if (arguments_.indexOf(name, index + 1) >= 0) {
    throw new NotificationOutboxError(
      "notification_outbox_argument_duplicated",
      `${name}は一度だけ指定してください。`,
    );
  }
  return value;
}

function parseReplayCommand(value: string, arguments_: string[]): NotificationReplayCommand {
  for (const name of ["--intent", "--expected-revision", "--operator", "--dry-run", "--yes"]) {
    if (arguments_.includes(name)) {
      throw new NotificationOutboxError(
        "notification_outbox_argument_conflict",
        "--command-jsonと個別のreplay引数は同時に指定できません。",
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new NotificationOutboxError(
      "notification_replay_json_invalid",
      `通知replay JSONを解析できません: ${error instanceof Error ? error.name : "unknown_error"}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NotificationOutboxError(
      "notification_replay_json_invalid",
      "通知replay JSONはobjectで指定してください。",
    );
  }
  const object = parsed as Record<string, unknown>;
  const expectedKeys = [
    "confirmed",
    "dryRun",
    "expectedRevision",
    "intentId",
    "operatorId",
    "schemaVersion",
  ];
  if (Object.keys(object).sort().join(",") !== expectedKeys.join(",")) {
    throw new NotificationOutboxError(
      "notification_replay_json_invalid",
      `通知replay JSONのfieldは${expectedKeys.join("、")}だけを指定してください。`,
    );
  }
  if (
    object.schemaVersion !== 1 ||
    typeof object.intentId !== "string" ||
    !Number.isSafeInteger(object.expectedRevision) ||
    typeof object.operatorId !== "string" ||
    typeof object.dryRun !== "boolean" ||
    typeof object.confirmed !== "boolean"
  ) {
    throw new NotificationOutboxError(
      "notification_replay_json_invalid",
      "通知replay JSONの値または型が不正です。",
    );
  }
  return {
    schemaVersion: 1,
    intentId: object.intentId,
    expectedRevision: Number(object.expectedRevision),
    operatorId: object.operatorId,
    dryRun: object.dryRun,
    confirmed: object.confirmed,
  };
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new NotificationOutboxError(
      "notification_outbox_integer_invalid",
      `${name}には1以上の整数を指定してください。`,
    );
  }
  return number;
}

function flag(arguments_: string[], name: string): boolean {
  if (arguments_.filter((value) => value === name).length > 1) {
    throw new NotificationOutboxError(
      "notification_outbox_flag_duplicated",
      `${name}は一度だけ指定してください。`,
    );
  }
  return arguments_.includes(name);
}

function rejectUnknown(arguments_: string[], allowed: Set<string>): void {
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index] ?? "";
    if (!value.startsWith("--")) {
      throw new NotificationOutboxError(
        "notification_outbox_argument_unknown",
        `位置引数には対応していません: ${value}`,
      );
    }
    if (!allowed.has(value)) {
      throw new NotificationOutboxError(
        "notification_outbox_argument_unknown",
        `未対応の引数です: ${value}`,
      );
    }
    if (["--intent", "--expected-revision", "--operator", "--command-json"].includes(value)) {
      index += 1;
    }
  }
}
