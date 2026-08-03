import { describe, expect, test } from "bun:test";
import { GitHubCliDependencies, nativeIssueRelationshipArgs } from "../src/github-cli.ts";

describe("GitHub CLI adapter", () => {
  test("固定したSlack利用者以外へgh認証者の個人作業を返さない", async () => {
    const dependencies = new GitHubCliDependencies(
      "art-tra2021/work",
      "octocat",
      ["art-tra2021"],
      null,
      "U_ALLOWED",
    );

    await expect(dependencies.loadWorkItems("U_OTHER")).rejects.toThrow(
      "AR_SLACK_CLI_USER_IDで固定したSlack利用者だけ",
    );
  });

  test("Slack利用者を固定していないCLI backendは個人作業をfail-closedにする", async () => {
    const dependencies = new GitHubCliDependencies("art-tra2021/work", "octocat");

    await expect(dependencies.loadWorkItems("U_ANY")).rejects.toThrow(
      "AR_SLACK_CLI_USER_IDで固定したSlack利用者だけ",
    );
  });

  test("gh issue createへnative relation flagsを渡す", () => {
    expect(
      nativeIssueRelationshipArgs(
        {
          parent: { repository: "art-tra2021/work", number: 4 },
          blockedBy: [
            { repository: "art-tra2021/work", number: 5 },
            { repository: "art-tra2021/other", number: 6 },
          ],
          blocking: [{ repository: "art-tra2021/work", number: 7 }],
        },
        "art-tra2021/work",
      ),
    ).toEqual([
      "--parent",
      "4",
      "--blocked-by",
      "5,https://github.com/art-tra2021/other/issues/6",
      "--blocking",
      "7",
    ]);
  });
});
