export interface IssueRequesterIdentity {
  id: number;
  login: string;
}

const REQUESTER_MARKER = /<!--\s*ar:requester:v1\s+(\{[^\n]*\})\s*-->/;
const GITHUB_LOGIN = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;

export function issueRequesterMarker(identity: IssueRequesterIdentity): string {
  return `<!-- ar:requester:v1 ${JSON.stringify(identity)} -->`;
}

export function parseIssueRequester(body: string): IssueRequesterIdentity | null {
  const match = REQUESTER_MARKER.exec(body);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(value.id) ||
      (value.id as number) < 1 ||
      typeof value.login !== "string" ||
      !GITHUB_LOGIN.test(value.login)
    ) {
      return null;
    }
    return { id: value.id as number, login: value.login };
  } catch {
    return null;
  }
}
