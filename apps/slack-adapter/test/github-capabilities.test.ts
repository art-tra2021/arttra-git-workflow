import { describe, expect, test } from "bun:test";
import { GitHubCapabilityGrants } from "../src/github-capabilities.ts";

describe("GitHubCapabilityGrants", () => {
  test("明示grantだけを大文字小文字を区別せず許可する", () => {
    const grants = GitHubCapabilityGrants.fromJson(
      JSON.stringify({ suppress_self_merge_channel_broadcast: ["example-user"] }),
    );

    expect(grants.has("EXAMPLE-USER", "suppress_self_merge_channel_broadcast")).toBe(true);
    expect(grants.has("admin-without-grant", "suppress_self_merge_channel_broadcast")).toBe(false);
  });

  test("未定義capabilityと不正なloginを拒否する", () => {
    expect(() => GitHubCapabilityGrants.fromJson('{"admin":["example-user"]}')).toThrow(
      "未定義のGitHub capability",
    );
    expect(() =>
      GitHubCapabilityGrants.fromJson(
        JSON.stringify({ suppress_self_merge_channel_broadcast: ["invalid login"] }),
      ),
    ).toThrow("capability grantのGitHub loginが不正");
  });
});
