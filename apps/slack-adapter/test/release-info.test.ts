import { describe, expect, test } from "bun:test";
import { buildHealthResponse } from "../src/release-info.ts";

describe("buildHealthResponse", () => {
  test("build時のcommitをhealth contractへ含める", () => {
    expect(buildHealthResponse("a67f9d3f85f602a96f0e10276a2c88bde982fee7")).toEqual({
      ok: true,
      schemaVersion: 1,
      commit: "a67f9d3f85f602a96f0e10276a2c88bde982fee7",
    });
  });

  test("revision未指定のlocal起動はdevelopmentを返す", () => {
    expect(buildHealthResponse("  ")).toEqual({
      ok: true,
      schemaVersion: 1,
      commit: "development",
    });
  });
});
