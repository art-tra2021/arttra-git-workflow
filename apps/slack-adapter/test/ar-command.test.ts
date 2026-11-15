import { describe, expect, test } from "bun:test";
import { arCommandHelp, isTaskCommand } from "../src/app.ts";

describe("/ar のコマンド振り分け", () => {
  test("自分の仕事を表示するのは /ar task だけ", () => {
    expect(isTaskCommand("task")).toBe(true);
    expect(isTaskCommand("")).toBe(false);
    expect(isTaskCommand("tasks")).toBe(false);
    expect(isTaskCommand("foo")).toBe(false);
  });

  test("/ar 単体では、使えるコマンドを種別ごとに示す", () => {
    const help = arCommandHelp("");
    expect(help).not.toContain("というコマンドはありません");
    for (const command of [
      "`/ar task`",
      "`/ar new`",
      "`/ar project`",
      "`/ar canvas`",
      "`/ar connect github`",
      "`/ar approval <ID>`",
    ]) {
      expect(help).toContain(command);
    }
  });

  test("解釈できない語には、その旨を先に書いて一覧を示す", () => {
    const help = arCommandHelp("  tsak ");
    expect(help.startsWith("`/ar tsak` というコマンドはありません。")).toBe(true);
    expect(help).toContain("`/ar task`");
  });
});
