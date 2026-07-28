# AGENTS.md

このリポジトリは、人間とAIが同じGitワークフローを再現できるか検証する実験場です。

## 必須手順

1. 作業前に`git ar context --json`と`git status --short`を確認する。
2. 変更後に`mise run verify`を実行する。
3. commit候補は`git ar commit ... --dry-run`で検証する。
4. 対話入力が必要な処理を追加するときは、同等の非対話引数またはJSON入力も追加する。
5. AI出力を直接GitHubの強制判定に使わない。構造化した後、決定的なvalidatorで検証する。

## 安全性

- secret、token、未編集のdiff本文を外部AIへ自動送信しない。
- `--yes`、`--create`などの明示なしにcommitやGitHub書き込みを行わない。
- `arttra.toml`の規則を緩和する変更では、理由と観測結果をPRに記録する。
- hookを変更した場合はTUI経由と非対話経由の両方を検証する。

## 主要コマンド

- `mise run setup`: CLI導入と共有hookの有効化
- `mise run verify`: format、check、test、clippy
- `mise run ar -- <args>`: インストール前のCLI実行
- `git ar`: 人間向けTUI
- `git ar context --json`: AI向けの安全なリポジトリ状態
