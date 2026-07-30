# arttra-git-lab

人間には短いTUI、AIと自動化には非対話引数を提供するGitワークフロー実験場です。

## セットアップ

必要なのはGitと[mise](https://mise.jdx.dev/)だけです。

```console
git clone git@github.com:rozwer/arttra-git-lab.git
cd arttra-git-lab
mise trust
mise install
mise run setup
```

`mise run setup`はRust CLIをインストールし、Git hookとClaude/Codexのローカルhookを有効にします。
Claude向けの`CLAUDE.md`も共有templateから生成します。
`CLAUDE.md`、Claude/Codexの端末別設定、telemetryはGit管理外なので、個人調整が共有差分へ混ざりません。
Codexではセットアップ後に`/hooks`を一度開き、リポジトリhookを信頼します。

## 人間向け

```console
git ar
```

メニューからcommit、Issue作成、診断、AI向けコンテキスト確認を選べます。
branch作成では種類、Issue番号、内容、担当者を選ぶだけで、英数字の規則準拠名を生成します。

```console
git ar branch
```

## AI・自動化向け

TUIを操作する必要はありません。

```console
git ar context --json
git ar presence check --json
git ar presence publish --yes
git ar tasks --json
git ar telemetry --json
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

`pre-push` hookが命名を検証します。
違反時は`AR-BRANCH-001`と日本語の理由を表示し、Issue番号を判別できる場合は実行可能な`git branch -m ...`を提示します。
既存リポジトリへの導入時だけ`branch.mode = "warn"`で観測期間を設け、新規リポジトリでは`block`を使います。

## 開発

```console
mise run quick
mise run verify
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

miseはruntimeと短い入口を管理します。
Issue、Task、PR、担当、期限等の正本はGitHub Projectsとし、`git ar tasks`は担当IssueをTUIまたはJSONで表示します。
Projectsを読むにはGitHub CLIへ`read:project` scopeが必要です。

設計原則と実験記録は[`docs/architecture.md`](docs/architecture.md)と
[`docs/experiments.md`](docs/experiments.md)にあります。
運用の正本は[`docs/workflow-v2.md`](docs/workflow-v2.md)、新規リポジトリへの展開は
[`docs/repository-template.md`](docs/repository-template.md)です。
