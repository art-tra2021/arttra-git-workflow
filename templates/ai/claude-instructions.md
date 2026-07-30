# CLAUDE.md

このリポジトリでは、`AGENTS.md`を人間・Claude・Codex共通の作業規約として扱います。
作業前に`AGENTS.md`を読み、その手順に従ってください。

## ツールチェーン

- JavaScriptのpackage managerはbunです。npm、npx、yarn、pnpmを使いません。
- Pythonの環境・依存管理はuvです。pipやvenvを直接使いません。
- runtimeのversionはmiseで固定します。nvm、pyenv等を使いません。
- 判断に迷ったら`git ar policy --json`または`git ar doctor --json`を実行します。
- 作業開始時に`git ar presence check --json`で、他の作業branchと変更ファイルが重ならないか確認します。
- 編集対象が決まった後とcommit前に`git ar presence publish --yes`を実行し、担当ファイル情報を更新します。
- branchは`git ar branch --type <type> --issue <number> --slug <slug> --owner <owner> --create`で作成します。

このファイルは`git ar setup`が端末ごとに生成します。
個人設定、hookの信頼状態、session logと同様にGitでは追跡しません。
