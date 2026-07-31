# 新規リポジトリテンプレート

このリポジトリ自体をGitHub Repository Templateとして使います。
作成直後に次だけを選びます。

1. `governance/repository-values.json`の所有チーム、リスク、CI profileを変更する。
2. 共通toolを維持し、`.mise.toml`へPython、TypeScript、Rustの必要なruntimeと`verify`を追加する。
3. 対象platformを含む`mise.lock`をcommitする。
4. `mise trust && mise install && mise run setup`を実行する。CIでは外部CLIだけ`--locked`で導入する。
5. Custom Propertiesを組織リポジトリへ適用する。
6. baseline Rulesetを最初は管理者bypass付きで適用する。

各言語のコマンドは次に統一します。

| 領域 | 使用する入口 |
| --- | --- |
| runtime | mise |
| JavaScript / TypeScript | bun |
| Python | uv |
| 共通検証 | `mise run verify` |
| commit / branch / Issue | `git ar` |
| GitHub API / browser | `gh` |
| Git hooks | `hk` |

`gh-dash`等のextensionはtemplateの必須依存にしません。
導入する場合はallowlistしたrepositoryとtagを固定し、AI向け経路はcore `gh`とJSONだけで成立させます。

CDはテンプレートに含めません。
デプロイ先とリリース戦略はプロジェクト固有です。
