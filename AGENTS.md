# AGENTS.md

このリポジトリは、人間とAIが同じGitワークフローを再現できるか検証する実験場です。

## 必須手順

1. 作業前に`git ar context --json`、`git ar presence check --json`、`git status --short`を確認する。
2. 変更後に`mise run verify`を実行する。
3. commit候補は`git ar commit ... --dry-run`で検証する。
4. 対話入力が必要な処理を追加するときは、同等の非対話引数またはJSON入力も追加する。
5. AI出力を直接GitHubの強制判定に使わない。構造化した後、決定的なvalidatorで検証する。
6. JavaScriptはbun、Python環境はuv、runtimeのversion管理はmiseを使う。npm、npx、yarn、pnpm、pip、pyenv等を直接使わない。
7. 編集対象が決まった後とcommit前に`git ar presence publish --yes`を実行し、変更ファイルの担当情報を更新する。
8. branchは`git ar branch`または完全な非対話引数で作成する。命名規則を回避するためにhookを無効化しない。

## 安全性

- secret、token、未編集のdiff本文を外部AIへ自動送信しない。
- `--yes`、`--create`などの明示なしにcommitやGitHub書き込みを行わない。
- `arttra.toml`の規則を緩和する変更では、理由と観測結果をPRに記録する。
- hookを変更した場合はTUI経由と非対話経由の両方を検証する。

## 主要コマンド

- `mise run setup`: CLI導入とmise管理のhk共有hookの有効化
- `mise run verify`: format、check、test、clippy、共通lint、security
- `mise run ar -- <args>`: インストール前のCLI実行
- `git ar`: 人間向けTUI
- `git ar branch`: Issue、種別、内容、担当者から規則準拠branchを作成
- `git ar check --json`: AI向けに検査結果とdiagnosticsを一括取得
- `git ar context --json`: AI向けの安全なリポジトリ状態
- `git ar presence check --json`: 他の作業branchと変更ファイルの重複を確認
- `git ar presence publish --yes`: diff本文を含まない変更ファイル情報を共有
- `git ar guard command --command "<command>" --agent codex --json`: 実行予定コマンドの判定
- `git ar presence install --yes`: OS標準機構へ定期共有を登録
