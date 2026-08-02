# AGENTS.md

このリポジトリでは、人間・Claude・Codexが同じGitワークフローと検証規則を使用する。

## 作業開始

1. `mise trust`後、`mise run ready`を実行する。
2. `git ar context --json`でRepositoryの規則を確認する。
3. `git ar status --json`で担当Issue、依存関係、次の行動を確認する。
4. `git ar presence check --json`で他の作業者との変更ファイル重複を確認する。

## 実装と検証

- runtimeと補助CLIはmiseから使用する。
- JavaScript／TypeScriptはbun、Pythonはuvを使用する。
- 対話操作には、AIが利用できる同等の非対話引数またはJSON入出力を用意する。
- AI出力をそのまま強制判定へ使わず、schemaと決定的validatorで検証する。
- 変更後は`mise run verify`を実行する。
- 意図したファイルだけをstageし、commit前に`git ar commit --dry-run`で検証する。
- commitとbranch作成は`git ar`を入口とし、hookやRulesetを迂回しない。

## 安全性

- secret、token、credential、顧客データをIssue、ログ、AI入力へ貼らない。
- repository、Slackメッセージ、cloud project、データを削除しない。
- force push、破壊的なclean/reset、infrastructure destroyを自動実行しない。
- 利用者本人の権限を確認できない外部資源は安全側で拒否する。
- 個人用のClaude/Codex設定と生成skillはGit管理へ含めない。
