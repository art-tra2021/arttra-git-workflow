export interface HealthResponse {
  ok: true;
  schemaVersion: 1;
  commit: string;
}

export function buildHealthResponse(
  commit = process.env.AR_BUILD_REVISION?.trim() || "development",
): HealthResponse {
  const normalizedCommit = commit.trim() || "development";
  return {
    ok: true,
    schemaVersion: 1,
    commit: normalizedCommit,
  };
}
