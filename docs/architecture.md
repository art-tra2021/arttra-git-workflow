# アーキテクチャ

## 目的

操作方法だけを人間とAIで分け、実行するユースケースと検証規則は共有します。

```text
Human ── TUI ───────┐
                    ├─ Commit / Issue use case ─ Validator ─ Git / GitHub
AI ─── CLI / JSON ──┘
```

TUIは便利な入力手段であり、正本ではありません。
正本は引数または将来追加するJSONスキーマで表現できる構造化データです。

## 境界

- `git ar context --json`は、AIへ渡せる最小限の状態を決定的に生成する。
- `git ar commit`はTUIと引数から同じcommit候補を生成する。
- `git ar issue`はTUIと引数から同じIssue本文を生成する。
- `git ar branch`はTUIと引数から同じbranch名を生成し、`pre-push`も同じvalidatorを呼ぶ。
- `git ar presence`はdiff本文を送らず、branchと変更ファイルのメタデータだけを専用refへ共有する。
- `hk`は変更ファイルを専用linterへ振り分け、`commit-msg`と`pre-push`ではCLIと同じvalidatorを呼ぶ。
- hookは自動stash、自動stage、自動fixをせず、利用者の作業treeを暗黙に変更しない。
- GitHub操作は`gh`を正本とし、`git ar`は日本語の誘導と安定したJSONを加える薄いadapterにする。
- 人間向け`gh-dash`は任意extension、AI向け`git ar tasks --json`は必須の安定interfaceとする。
- Claude/Codexの`PreToolUse` hookは`git ar guard hook`を呼び、同じtoolchain validatorを使う。
- AIは候補を提案できるが、合否は`arttra.toml`とvalidatorが決める。

## AI hookとローカル状態

- `AGENTS.md`と`templates/ai/claude-instructions.md`を共有規約として追跡する。
- rootの`CLAUDE.md`は共有templateから生成し、個人調整を許すため追跡しない。
- `.claude/settings.local.json`と`.codex/hooks.json`は`git ar setup`が端末ごとに生成し、追跡しない。
- Codex/Claude固有のhookは薄いadapterに限定し、規則本体を持たない。
- telemetryは規則ID、agent、allow/warn/denyだけを記録し、command本文、diff、secretは記録しない。
- shell scriptに依存せずRust CLIを呼ぶことで、macOS、Windows、WSLで同じ判定を使う。

## Toolchain

- `mise.toml`と`mise.lock`が、macOS・Windows・WSLで使うCLIのversion、取得URL、提供されるchecksumを固定する。
- mise core runtimeはversionを固定し、CIでは外部CLIだけを`--locked`で導入する。
- `hk`、`gh`、`jq`、`yq`と共通linterはmiseからだけ解決する。
- Python profileは`uv + ruff`、TypeScript profileは`bun + Biome + tsc`、Rust profileはCargoを使う。
- GitHub extensionはGitHubによる検証済みとは限らないため、自動setupから外し、repositoryとversionをallowlistする。
- AIには各toolのJSON/SARIFと決定的なexit codeを渡し、人間には`git ar`が日本語の修正案を表示する。

## Presence

- 端末ごとに`refs/heads/ar-presence/<actor>/<device>`を1本使用する。
- snapshotの履歴は積まず、force pushで現在値だけを保持する。
- 各snapshotは時刻を持ち、期限切れ情報は受信側で無視する。
- 未commitの重複をbranch全体の重複より先に表示する。
- OS自動実行はmacOSのlaunchd、WindowsのTask Scheduler、Linux/WSLのsystemd user timerへ薄く接続する。
- macOSの保護対象ディレクトリではbackground登録を拒否し、Terminal上のwatchへ誘導する。

## 段階的な強制

既存リポジトリへ導入する規則は`warn`から開始します。
新規リポジトリのbranch命名など、移行対象がない規則は`block`から開始できます。
違反、離脱、修正回数を観測して強制レベルを変更します。
GitHub RulesetsとCIは、ローカルhookを回避した場合のサーバー側境界として後から接続します。
