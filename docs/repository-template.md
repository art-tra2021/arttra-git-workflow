# 新規リポジトリテンプレート

このリポジトリ自体をGitHub Repository Templateとして使います。
作成直後に次だけを選びます。

1. `governance/repository-values.json`の所有チーム、リスク、CI profileを変更する。
2. 共通toolを維持し、`.mise.toml`へPython、TypeScript、Rustの必要なruntimeと`verify`を追加する。
   同時に`arttra.toml`の`doctor.managed_commands`へ、Pythonなら`python`・`uv`、TypeScriptなら`node`・`bun`、Rustなら`rustc`・`cargo`を追加する。
3. 対象platformを含む`mise.lock`をcommitする。
4. `mise trust`の後に`mise run setup-ar`を実行する。tool導入、`git ar`、hooks、AI連携、診断、品質検査、次の行動表示はtaskが自動化し、本人の認証やshell設定だけをマニュアルへ誘導する。CIでは外部CLIだけ`--locked`で導入する。
5. Custom Propertiesを組織リポジトリへ適用する。
6. baseline Rulesetを最初は管理者bypass付きで適用する。

セットアップ後の完了確認は`mise run ready`だけを案内します。
このtaskが環境診断、必須検査、次の行動表示を順に実行します。

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

`mise run doctor`は、`doctor.managed_commands`の各コマンドについてPATH上の実体と`mise which`の結果を比較します。
個別に導入した`pip`、`npm`、`cargo`、`gh`などが先に見つかる場合は失敗し、日本語の修正コマンドを表示します。

`gh-dash`等のextensionはtemplateの必須依存にしません。
導入する場合はallowlistしたrepositoryとtagを固定し、AI向け経路はcore `gh`とJSONだけで成立させます。

CDはテンプレートに含めません。
デプロイ先とリリース戦略はプロジェクト固有です。
