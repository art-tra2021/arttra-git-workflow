# 新規リポジトリテンプレート

このリポジトリ自体をGitHub Repository Templateとして使います。
作成直後に次だけを選びます。

1. `governance/repository-values.json`の所有チーム、リスク、CI profileを変更する。
2. `.mise.toml`へPython、TypeScript、Rustの必要なruntimeと`verify`を定義する。
3. `mise trust && mise install && mise run setup`を実行する。
4. Custom Propertiesを組織リポジトリへ適用する。
5. baseline Rulesetを最初は管理者bypass付きで適用する。

各言語のコマンドは次に統一します。

| 領域 | 使用する入口 |
| --- | --- |
| runtime | mise |
| JavaScript / TypeScript | bun |
| Python | uv |
| 共通検証 | `mise run verify` |
| commit / branch / Issue | `git ar` |

CDはテンプレートに含めません。
デプロイ先とリリース戦略はプロジェクト固有です。
