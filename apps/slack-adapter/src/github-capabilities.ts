export const GITHUB_CAPABILITIES = ["suppress_self_merge_channel_broadcast"] as const;

export type GitHubCapability = (typeof GITHUB_CAPABILITIES)[number];

export interface GitHubCapabilityAccess {
  has(githubLogin: string, capability: GitHubCapability): boolean;
}

export class GitHubCapabilityGrants implements GitHubCapabilityAccess {
  private readonly grants: Map<GitHubCapability, Set<string>>;

  private constructor(grants: Map<GitHubCapability, Set<string>>) {
    this.grants = grants;
  }

  static empty(): GitHubCapabilityGrants {
    return new GitHubCapabilityGrants(new Map());
  }

  static fromJson(value: string | undefined): GitHubCapabilityGrants {
    if (!value?.trim()) return GitHubCapabilityGrants.empty();

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("AR_GITHUB_CAPABILITY_GRANTS_JSONはJSON objectで指定してください。");
    }
    if (!isRecord(parsed)) {
      throw new Error("AR_GITHUB_CAPABILITY_GRANTS_JSONはJSON objectで指定してください。");
    }

    const grants = new Map<GitHubCapability, Set<string>>();
    for (const [capability, logins] of Object.entries(parsed)) {
      if (!isGitHubCapability(capability)) {
        throw new Error(`未定義のGitHub capabilityです: ${capability}`);
      }
      if (!Array.isArray(logins) || !logins.every((login) => typeof login === "string")) {
        throw new Error(`${capability}のgrantはGitHub loginの配列で指定してください。`);
      }
      grants.set(capability, new Set(logins.map(normalizeConfiguredGitHubLogin)));
    }
    return new GitHubCapabilityGrants(grants);
  }

  has(githubLogin: string, capability: GitHubCapability): boolean {
    return this.grants.get(capability)?.has(githubLogin.trim().toLowerCase()) ?? false;
  }
}

function isGitHubCapability(value: string): value is GitHubCapability {
  return (GITHUB_CAPABILITIES as readonly string[]).includes(value);
}

function normalizeConfiguredGitHubLogin(login: string): string {
  const normalized = login.trim().toLowerCase();
  if (!/^(?!-)[a-z0-9-]{1,39}(?<!-)$/u.test(normalized)) {
    throw new Error(`capability grantのGitHub loginが不正です: ${login}`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
