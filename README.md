# ART-TRA Git Workflow

人間には短いTUI、AIと自動化には非対話引数を提供するGitワークフロー実験場です。

## セットアップ

必要なのはGitと[mise](https://mise.jdx.dev/)だけです。
`mise.lock`に固定した`gh`、`hk`、lint/security toolは`mise install`で揃います。

```console
git clone git@github.com:art-tra2021/arttra-git-workflow.git
cd arttra-git-workflow
mise trust
mise install
mise run setup
```

`mise install`は全toolを正確なversionで導入し、外部CLIには`mise.lock`のURL/checksumを利用します。
core runtimeのRustはversion固定ですが、miseのlock対象外なのでartifact lockは行いません。
`mise run setup`はRust CLIをインストールし、mise経由の`hk`とClaude/Codexのローカルhookを有効にします。
既存の`core.hooksPath=.githooks`だけは自動移行し、それ以外の独自hook設定は上書きせず日本語で停止します。
Claude向けの`CLAUDE.md`も共有templateから生成します。
`CLAUDE.md`、Claude/Codexの端末別設定、telemetryはGit管理外なので、個人調整が共有差分へ混ざりません。
Codexではセットアップ後に`/hooks`を一度開き、リポジトリhookを信頼します。

## 人間向け

```console
git ar
```

メニューからcommit、Issue作成、診断、AI向けコンテキスト確認を選べます。
branch作成では種類、Issue番号、内容、担当者を選ぶだけで、英数字の規則準拠名を生成します。
作成時は`gh issue develop`を使うため、branchとIssueの関係もGitHubへ記録されます。

```console
git ar status
git ar branch
mise run tasks
```

`git ar status`は現在のbranchに紐づくIssue本文、blocked-by、PR、check、作業ツリー、upstreamを読み、次に行う操作とその理由を表示します。
branch名からIssue番号を判定できない場合は、`git ar status --issue 123`で明示できます。
`mise run tasks`は任意導入の`gh-dash`を開き、未導入・起動失敗時は組み込みの簡易表示へ戻ります。
AIは常に`git ar tasks --json`を使い、TUIやextensionの有無に依存しません。

## AI・自動化向け

TUIを操作する必要はありません。

```console
git ar status --json
git ar context --json
git ar check --json
git ar presence check --json
git ar presence publish --yes
git ar tasks --json
git ar telemetry --json
git ar rules --json
git ar properties --organization art-tra2021 --dry-run --json
git ar branch \
  --type feature \
  --issue 123 \
  --slug "login screen" \
  --owner roz
git ar guard command --command "npm install" --agent codex --json
git ar commit --type feat --scope cli --summary "add deterministic input" --issue 1 --dry-run
git ar issue \
  --title "非対話commitを検証する" \
  --background "AIは対話TUIを安定して操作できない" \
  --goal "引数だけで同じ処理を実行できるようにする" \
  --done "dry-runの出力がTUIと一致する" \
  --json
```

実際にcommitする場合は、完全な引数に加えて`--yes`を指定します。
IssueをGitHubへ登録する場合は`--create`を指定します。
どちらも明示しなければプレビューだけなので、安全に試せます。

ClaudeとCodexは、shell commandの実行前に同じ`arttra.toml`を評価します。
たとえば`npm install`は日本語の修正案付きで拒否され、`bun install`へ誘導されます。
判定結果には安定したerror codeが含まれます。

`git ar check`は全検査を実行し、人間には通常の診断と日本語の再実行コマンドを表示します。
`git ar check --json`は同じ検査のexit code、stdout、stderrを一つのschemaで返します。
編集途中は`--quick`を付けて短い検査だけを実行できます。

GitHub CLI 2.94以降を固定しているため、Issueの親子・blocked-by関係はGitHub本体の構造として扱えます。
`git ar issue --blocked-by 123 --create`は本文だけでなくnative relationshipも登録します。
`--parent`は1件、`--blocked-by`と`--blocking`は繰り返し可能な非対話入力として利用でき、
TUIでは「依存関係や目標日も設定する」を選んだ場合だけ表示されます。

## 共通toolchain

`mise`がversionと実行入口、`hk`が変更ファイルに応じたhook実行、各専用toolが実際の判定を担当します。
hookは自動stash・自動stage・自動fixを行いません。

| 対象 | tool |
| --- | --- |
| GitHub | `gh` |
| hook | `hk` |
| JSON / YAML | `jq` / `yq` |
| Actions / shell / TOML / Markdown | `actionlint` / `shellcheck` / `shfmt` / `taplo` / `rumdl` |
| secret / Actions security | `gitleaks` / `zizmor` |
| 依存脆弱性（明示実行） | `osv-scanner` |

```console
mise run lint
mise run security
mise run security:dependencies
```

人間向けのGitHub拡張は必須基盤から分離しています。
利用する場合だけ、レビュー済みversionを固定した`mise run extensions:install`を実行します。
導入対象はタスクTUIの`gh-dash`と、squash merge後のlocal branchを掃除する`gh-poi`です。

## 変更ファイルの共有

GitLive等の非公開APIには依存せず、GitHubの専用branchへ変更ファイルのメタデータだけを定期送信します。
diff本文、ファイル内容、secretは送信しません。

```console
# 送信内容をローカルで確認
mise run presence:snapshot

# 1回送信して、他の作業との重複を確認
mise run presence:publish
mise run presence:check

# 現在のterminalで5分ごとに送信（intervalはarttra.tomlで変更可能）
mise run presence:watch

# OS標準の定期実行へ登録
mise run presence:install
mise run presence:status
mise run presence:uninstall
mise run tasks
mise run telemetry
```

共有refは`refs/heads/ar-presence/<actor>/<device>`です。
端末ごとにrefを分け、履歴を積まず毎回置き換えます。
受信側は`max_age_minutes`を超えた情報を無視するため、停止処理に失敗しても作業中表示が永久には残りません。
macOSではlaunchd、WindowsではTask Scheduler、Linuxとsystemd対応WSLではuser timerを使います。
macOSのDesktop、Documents、Downloadsはバックグラウンドアクセスの保護対象なので、自動登録するリポジトリは`~/Developer`等へ配置します。
保護対象にあるリポジトリでは、Terminal上の`mise run presence:watch`を利用します。
WSLのsystemd timerはWSL自体を常時起動するものではなく、ディストリビューションが動作中の間に実行されます。

## Branch命名

通常branchは`type/issue-slug-owner`形式です。

```console
git ar branch \
  --type feature \
  --issue 123 \
  --slug login-screen \
  --owner roz \
  --create
```

`hk`の`pre-push` hookが送信対象の全branch名を検証します。
違反時は`AR-BRANCH-001`と日本語の理由を表示し、Issue番号を判別できる場合は実行可能な`git branch -m ...`を提示します。
既存リポジトリへの導入時だけ`branch.mode = "warn"`で観測期間を設け、新規リポジトリでは`block`を使います。

## 開発

```console
mise run quick
mise run verify
git ar check
git ar check --json
mise run lint
mise run security
mise run doctor
mise run context
mise run policy
mise run ai:setup
mise run presence:snapshot
mise run presence:publish
mise run presence:check
mise run presence:watch
mise run presence:install
mise run presence:status
mise run presence:uninstall
```

miseはruntime、CLI、短い入口を管理し、hkはmise環境内で実行します。
Issue、Task、PR、担当、期限等の正本はGitHub Projectsとし、`git ar tasks`は担当IssueをTUIまたはJSONで表示します。
現在の作業で次に行うことは`git ar status`、AIからは`git ar status --json`で確認します。
Projectsを読むにはGitHub CLIへ`read:project` scopeが必要です。

Rulesetの実効結果は`mise run rules`、AIや集計は`mise run rules:json`で確認します。
個別のRule Suiteは`git ar rules --suite <ID> --json`で各規則の合否まで取得できます。
Organization Custom Propertiesは宣言ファイルから管理し、まず`mise run properties:plan`で差分を確認します。
適用はOrganization管理者が`mise run properties:apply`を明示実行した場合だけ行い、宣言外のpropertyは削除しません。

設計原則と実験記録は[`docs/architecture.md`](docs/architecture.md)と
[`docs/experiments.md`](docs/experiments.md)にあります。
運用の正本は[`docs/workflow-v2.md`](docs/workflow-v2.md)、新規リポジトリへの展開は
[`docs/repository-template.md`](docs/repository-template.md)です。
