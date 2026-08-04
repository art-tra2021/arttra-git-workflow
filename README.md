# ART-TRA Git Workflow

人間には短いTUI、AIと自動化には非対話引数を提供するGitワークフロー実験場です。

## セットアップ

必要なのはGitと[mise](https://mise.jdx.dev/)だけです。
`mise.lock`に固定した`gh`、`hk`、lint/security toolは`mise run setup-ar`が揃えます。

```console
git clone git@github.com:art-tra2021/arttra-git-workflow.git
cd arttra-git-workflow
mise trust
mise run setup-ar
```

通常利用者が実行するのは、clone、`mise trust`、`mise run setup-ar`の3段階です。
`setup-ar`は全toolを正確なversionで導入し、外部CLIには`mise.lock`のURL/checksumを利用します。
core runtimeのRustはversion固定ですが、miseのlock対象外なのでartifact lockは行いません。
`mise run setup-ar`はRust CLIをインストールし、mise経由の`hk`とClaude/Codexのローカルhookを有効にします。
presenceが有効なrepositoryではOS標準の定期共有も導入します。macOSのDesktop等でバックグラウンドアクセスが制限される場合、次の操作は`git ar`のまま維持し、任意の`mise run presence:watch`を別Terminalで常駐させる案内へ切り替わります。`presence:watch`は終了する処理ではないため、不要になったら`Ctrl-C`で停止します。
見た目だけを確認する場合は`mise run setup-demo`を実行します。環境を変更せず、`--width 112 --height 30`のように通常UIの仮想viewportを指定してレスポンシブ表示も確認できます。失敗表示だけを確認する場合は`mise run setup-demo-failure`を実行します。失敗位置は`mise run setup-demo -- --fail-at toolchain`のように、1から5または`toolchain`、`git-ar`、`integrations`、`presence`、`diagnostics`で非対話指定できます。通常実行では端末寸法を自動取得し、実行中にリサイズした場合も次の描画から再配置します。横幅が88列以上、縦が22行以上、かつ列数が行数の2倍以上ならfastfetch/lazygit風の左右ペイン、それ以外は縦積みまたはminimal表示です。TTYではalternate screenの同じ画面を毎フレーム消去・再描画し、通常UIの最大148列canvasを物理画面の上下左右中央へ置くため、アニメーション履歴はスクロールしません。起動時は通常UIをまだ描かず、仮想viewport指定にかかわらず物理TTYの全行・全列へ半角ASCIIのMatrix rainを表示します。画面全体に混在する緑・黄・コーラル・青の`A`、`R`、`T`を含む文字群が、対応する領域へ流れ込み、`ART`の反復模様として画面比率に応じた38×18または50×24のロゴへ凝縮します。ロゴは3×3グリッドの中央1マスだけを空け、残り8マスを四つの2×1長方形で隙間なく構成します。四枚が揃った後にだけ、各長方形が持つ外周側の1角へ端末セルの縦横比を補正した四分円マスクを適用し、中央を向く角は四角いまま通常UIへ切り替わります。巨大ロゴでは四分円の縦半径を3×3セルの短辺いっぱいに取り、形成を12 frameかけて見せた後、完成形を320ms保持します。形成アニメーション、実行中ヘッダー、完了・失敗画面は同じ比率計算を使うため、画面サイズを切り替えても角丸率は変わりません。operation完了後はinstaller画面を残さず、`NEXT COMMAND`とNotionガイドを強調した専用の完了画面へ遷移します。alternate screenを抜けた後はその完了画面を通常bufferへ一度描き戻すため、shellへ戻っても結果が残ります。静止表示は`ARTTRA_SETUP_MOTION=0 mise run setup-demo`で確認できます。
通常UIの枠線は白で統一し、landscape上段を2列の余白で分離したロゴ、環境情報、ジャンル別積立進捗の3ブロックに分けます。セットアップはRuntime、Build、Integration、Validationに属する15個のoperationとして表示し、進行中はcommand、pipeline、install trace、signal、packetに加えて4方向を時計回りに周回するrotary coreを強調し、完了したoperationはジャンル別collectionへ集約します。正常終了時はprogress、flux、signal、trustが100%へ収束し、`NEXT`とセットアップ手順のNotionリンクを表示します。必須処理が失敗した場合は完了扱いにせず、失敗した処理、実行command、exit code、再実行方法、処理ジャンルに対応するNotionリンクを赤いfailure画面へ固定します。同時にcommand outputをローカルで決定的にマスクし、所有者だけが読める`.arttra/local/setup-logs/`のsupport logへ保存します。failure画面には実在するログの絶対パスと「これを実行し、エラーメッセージを見る、またはAIに渡してください」という案内を表示します。`mise run setup-log:show`は`.arttra/local/setup-logs/latest.log`を表示し、`mise run setup-log:copy`はmacOSの`pbcopy`、Linux Waylandの`wl-copy`、Linux X11の`xclip`、WindowsまたはWSLの`clip.exe`、PowerShellの`Set-Clipboard`、SSH terminalのOSC52を順に利用します。利用可能なclipboardがないheadless環境では、正しい絶対パスと`setup-log:show`を案内します。`latest.log`はsymlinkではなく所有者だけが読める実ファイルなので、Windowsでも同じ導線を使えます。生ログは保存せず破棄し、共有前にはマスク済みログを人間が確認してください。この経路はUbuntu、macOS、Windows Git BashのCIでも検証します。任意のpresence schedulerだけはmanual modeへ切り替えますが、次の操作は`git ar`と表示します。`mise run presence:watch`は`OPTIONAL BACKGROUND WATCHER`として別Terminalで常駐させ、`Ctrl-C`で停止するものだと明記します。起動Matrixは46 frameで、1列ごとに色を固定した細いstreamと長いtailを約4分の1の文字密度で描画します。落下は1 frameあたり3行、描画後の待機は12msに抑え、30fps前後の滑らかさを保ったまま流速を落とします。
画面構成はApache-2.0のGemini CLI、animation frameはMITのCharmbracelet Bubbles、ロゴ復号はMITのTerminalTextEffects、横幅によるペイン切替はMITのlazygit、進捗計はMITのcli-tracker、Matrix rainはCC0のfakesteakから移植しています。改変箇所とライセンスは[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)に記録しています。
既存の`core.hooksPath=.githooks`だけは自動移行し、それ以外の独自hook設定は上書きせず日本語で停止します。
Claude向けの`CLAUDE.md`も共有templateから生成します。
`CLAUDE.md`、Claude/Codexの端末別設定、telemetryはGit管理外なので、個人調整が共有差分へ混ざりません。
Codexではセットアップ後に`/hooks`を一度開き、リポジトリhookを信頼します。

## 人間向け

```console
git ar
```

メニューからIssue、branch、commit、push、Pull Request作成までを順に進められます。
各選択肢には`feat`などの意味と具体例が表示され、必須項目は空白のまま進めません。
branch作成では種類、Issue番号、内容、担当者を選ぶだけで、英数字の規則準拠名を生成します。
作成時は`gh issue develop`を使うため、branchとIssueの関係もGitHubへ記録されます。

```console
git ar status
git ar branch
git ar push --dry-run
git ar pr
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
git ar push --dry-run --json
git ar pr --issue 123 --title "ログイン画面を追加する" --draft --json
git ar issue \
  --title "非対話commitを検証する" \
  --background "AIは対話TUIを安定して操作できない" \
  --goal "引数だけで同じ処理を実行できるようにする" \
  --done "dry-runの出力がTUIと一致する" \
  --json
```

実際にcommitやpushをする場合は、完全な引数に加えて`--yes`を指定します。
IssueをGitHubへ登録する場合は`--create`を指定します。
Pull Requestは`--create --yes`を両方指定した場合だけ作成します。
pushの`--json`、Pull Requestの`--json`は、書き込み確認がない限りプレビューだけなので安全に試せます。

ClaudeとCodexは、shell commandの実行前に同じ`arttra.toml`を評価します。
たとえば`npm install`は日本語の修正案付きで拒否され、`bun install`へ誘導されます。
判定結果には安定したerror codeが含まれます。

`git ar check`は全検査を実行し、人間には通常の診断と日本語の再実行コマンドを表示します。
`git ar check --json`は同じ検査のexit code、stdout、stderrと、現在のWork / Businessに対する非ブロッキングの`issue_diagnostics`を一つのschemaで返します。
直属Taskが10件以上なら分割粒度の見直し、20件超なら強い分割警告、閉じた親に未完了Taskが残る場合は再openまたは親の付け替えを案内します。
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
