import { describe, expect, test } from "bun:test";
import { toHumanWorkItem } from "../src/read-model.ts";
import { snapshot } from "./fixtures.ts";

describe("人間向けread model", () => {
  test("通常の進行中Issueは即時通知せず日次一覧へ送る", () => {
    const item = toHumanWorkItem(snapshot(), "reviewer");
    expect(item.delivery).toBe("digest");
    expect(item.reasonCode).toBe("ACTIVE_WORK");
    expect(item.nextAction).toBe("次の完了条件を進める");
  });

  test("blockerがある現在状態は即時通知する", () => {
    const item = toHumanWorkItem(
      snapshot({
        relationships: {
          blockedBy: [
            {
              number: 9,
              title: "認証方式を決める",
              url: "https://github.com/example/repo/issues/9",
            },
          ],
        },
      }),
      "reviewer",
    );
    expect(item.delivery).toBe("immediate");
    expect(item.reasonCode).toBe("BLOCKED");
    expect(item.reason).toContain("#9 認証方式を決める");
  });

  test("自分へのreview依頼は即時通知する", () => {
    const item = toHumanWorkItem(
      snapshot({
        pullRequest: {
          number: 24,
          url: "https://github.com/example/repo/pull/24",
          checks: "passed",
          mergeState: "clean",
          requestedReviewers: ["reviewer"],
        },
      }),
      "reviewer",
    );
    expect(item.delivery).toBe("immediate");
    expect(item.reasonCode).toBe("REVIEW_REQUESTED");
    expect(item.nextActor).toBe("reviewer");
  });
});
