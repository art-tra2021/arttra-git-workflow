# Slack adapter

GitHub の生イベントを Slack へ転送せず、GitHub と Projects から再取得した現在状態を人間向け read model に変換する境界である。

## 原則

- Webhook は表示データではなく再取得のきっかけとして扱う。
- Slack の即時通知は、blocker、急ぎの未割当、CI 失敗、conflict、review 依頼に限定する。
- 同じIssueに関する作業状態とPRライフサイクルの通知は一つのSlackスレッドへ集約する。
- 通常の進行中作業は digest と Slack List に集約し、完了済み項目は通知しない。
- Slack は操作窓口であり、正本は GitHub Issue と Projects に置く。
- Slack ユーザーと GitHub ユーザーの対応を推測しない。
- `/ar new` のmodalとAIは、同じversion付きIssue作成commandを使う。

## 開発

```sh
mise run slack:check
```

`slack-app-manifest.yml` の URL は公開エンドポイント決定後に置き換える。Bot token、Signing secret、GitHub App の秘密情報はリポジトリへ保存しない。

## Socket Modeで試す

`.env.example`を`.env`へコピーし、SlackのBot token、`connections:write`を持つApp token、GitHub repositoryとloginを設定する。
CLI backendは単一利用者のローカル検証専用であり、`AR_SLACK_CLI_USER_ID`へ設定したSlack利用者だけが個人の仕事とCalendar同期を利用できる。
複数利用者の運用ではGitHub App backendを使用する。
`AR_GITHUB_OWNERS`には、Slackから選択を許可するOrganizationまたは個人ownerをカンマ区切りで設定する。

最初に各利用者が`/ar connect github`を実行し、GitHub OAuthで本人確認する。
署名済みstateをSlack team/user IDへ結び付け、検証したGitHub user IDとloginだけをstate storeへ保存する。
OAuth access tokenは本人確認直後に破棄し、メール、表示名、同名userからmappingを推測しない。
連携解除は`/ar disconnect github`で行う。
Issue modalでは実在するSlackメンバーを担当者と予定レビュワーに選択でき、未連携者がいれば本人へのmentionと連携commandを返す。

```sh
mise run slack:dev
```

## Project Listを同期する

`AR_GITHUB_PROJECT_OWNER`と`AR_GITHUB_PROJECT_NUMBER`を設定すると、単一repositoryのIssue一覧ではなくOrganization Projectを正本として複数repositoryの項目を取得する。

共有Slack channelへListや通知を出す場合は、`AR_SLACK_SHARED_REPOSITORY`でそのchannelへの公開を許可する単一repositoryを必ず指定する。
未指定のまま共有channelを設定するとadapterは起動を拒否する。
利用者ごとの全repository投影は共有channelへ出さず、本人のGitHub連携を確認した個人List／Canvasだけに作成する。
ART-TRAではownerを`art-tra2021`、Project番号を`8`とする。

`AR_SLACK_PROJECT_LIST_CHANNEL_ID`へ同期先channel IDを設定する。
CLIから初回作成する場合は、`AR_SLACK_PROJECT_LIST_MANAGER_ID`へタブを設定する管理者のSlack user IDを任意で設定する。`/ar project sync`では実行者へ自動で閲覧権限を付ける。
Appは初回同期で専用のSlack Listを作成し、`lists:read`と`lists:write`でGitHub Projectsの現在状態を反映する。
作成したListは対象channelへread権限で共有し、Slack側を第二の正本にしない。
Listの列はタスク、担当者、期限、状態、詳細の5列である。
P0、P1、P3だけはタスク名の先頭へ優先度を表示し、通常値のP2は表示しない。
リポジトリ名はタスク名へ含め、GitHub loginや次の行動はIssueで確認する。

```sh
mise run slack:list
```

AIや運用scriptは、同じ処理のversion付きJSON結果を取得する。

```sh
mise run slack:list:json
```

初回はList IDと列IDをGit管理外の`.state`へ保存する。
ローカル実行では`AR_LOCAL_STATE_DIR=../../.state`としてrepository rootの状態を共有し、実行directoryによるListの二重作成を防ぐ。
2回目以降はGitHub Issue URLを安定キーとして、既存行の更新、新規行の追加、Projectから外れた行の削除を行う。
GitHub OAuthで対応付け済みの担当者はSlackのnative user列へ反映する。
未連携者の担当者欄は空欄とし、表示名やメールから推測しない。
旧版のList本体は削除せず`ART-TRA Work（旧表示）`へ改名する。
scope導入前の共有Listは、過去のprivate項目を残さないようchannel accessと全行を除去してから、Slack標準の担当者・期限日を使う5列版の`仕事一覧`へ切り替える。
起動中のadapterでは、同期先channelから`/ar project sync`を実行しても同じ処理を呼び出せる。
`/ar list sync`と従来の`/ar canvas sync`も移行用aliasとして同じ処理を呼ぶ。
同じchannelへの同期はleaseで直列化し、Webhook、定期同期、人間の手動操作が重なって行を重複作成しない。

非公開channelで新規作成・通知を行うには、channel管理権限を持つ利用者が次を実行する。

```text
/invite @ART-TRA Work Lab
```

初回同期後、作成された`仕事一覧` Listをchannel tabへ一度だけ追加する。
SlackのLists APIはpaid planでのみ利用できるため、未対応planでは同期を開始しない。

Issue modalの担当者と予定レビュワーはSlackのネイティブなメンバー選択を使う。
検証済みGitHub user IDへ変換したうえで、担当者はAssignee、予定レビュワーはIssue内の`@login`と構造化ID、PR作成時はGitHubのReview Requestへ反映する。
表示名、同名ユーザー、メールアドレスから対応を推測しない。

`/ar new`の作業チケットでは、repository側のIssue templateに依存せず「通常レビュー」「自分でマージ可」「緊急マージ」を明示選択する。
選択値はAIと共通のversion付きIssue作成commandへ保存し、対応する`merge/*`ラベルを正本とする。
`AR_SLACK_APPROVER_IDS`には、`merge/self`または`merge/emergency`を許可できるSlack user IDをカンマ区切りで設定する。
申請者本人による直通を許すPL等は、`AR_SLACK_SELF_APPROVER_IDS`にも明示する。
通知上の追加権限は`AR_GITHUB_CAPABILITY_GRANTS_JSON`でGitHub loginへ明示的に付与する。
`suppress_self_merge_channel_broadcast`はセルフマージ初回警告を親WorkまたはBusiness thread内だけに留める権限であり、Task警告と停止ボタンは残る。
この権限はrepositoryのadmin権限や`AR_SLACK_SELF_APPROVER_IDS`から暗黙には付与しない。
直通にはこのSlack設定に加え、OAuthで確認したGitHub loginが対象repositoryで`write`、`maintain`、`admin`のいずれかを持つことを要求する。
未設定者、GitHub未連携者、権限不足者、権限を確認できない場合は拒否せず、理由と申請者・repository・マージ方針を示したnative mentionと承認ボタンを承認者へ送る。
承認時にも申請者のGitHub連携とrepository accessを再確認し、申請後に失効した権限を流用しない。
別のGitHubアカウントへ再連携する場合は、新しい対応付けを保存する前に旧アカウント用の個人List／Canvas accessとstateを失効させる。
通常レビューのIssueは即時作成する。

承認待ちと監査eventは共通state storeへ保存する。
本番のFirestoreでは原子的なrevision更新により、Slackのボタンが二重実行されてもIssueを一度だけ作成する。
有効期限は`AR_APPROVAL_TTL_MINUTES`で設定し、既定は24時間である。
申請・処理開始・承認・却下・失効・失敗を追記型監査eventとして記録する。
承認ボタンを押した時点でGitHub Appまたは`gh`の権限とIssue templateを再検証する。

Slackでは`/ar approval <approval-id>`、AIや運用scriptでは次のcommandから、同じversion付きJSON statusを確認できる。

```sh
mise run slack:approval -- <approval-id>
```

## 通知outboxを監査・復旧する

Slackへ送るライフサイクル通知、レビュー依頼、作業通知、期限通知、日次digestは、送信前にFirestoreまたはlocal stateへversion付きintentとして保存する。
状態は`intent`、`sending`、`sent`、`needs_review`、`failed`の5種類である。
同じintentを複数workerが同時に処理しても、revisionの原子的更新に成功した1workerだけがSlack APIを呼ぶ。
Slack APIの応答が不明な場合は`needs_review`、送信前の拒否と判断できる場合は`failed`にし、自動再送しない。

通常の監査では、要確認intentと、旧実装の`effects_started`／`failed` GitHub deliveryだけを表示する。

```sh
mise run slack:outbox:audit
```

AIや運用scriptは同じ監査結果をversion付きJSONで取得する。

```sh
mise run slack:outbox:audit:json
```

再送前には必ずdry-runを行う。
コマンドはSlack Conversations APIで対象channelの時間帯またはWork / Business threadを最後まで読み、メッセージmetadataに埋め込んだintent IDを照合する。

```sh
mise run slack:outbox:replay -- \
  --intent notification-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --expected-revision 3 \
  --operator U0123456789 \
  --dry-run \
  --json
```

全候補を確認できなかった場合は`inconclusive`として停止する。
同じメッセージが見つかった場合、確認付き実行は再送せず既存message tsを`sent`として記録する。
見つからなかった場合だけ、`--dry-run`を`--yes`へ置き換えた確認付き実行で再送する。
dry-runと`--yes`は同時指定できず、どちらもない実行も拒否する。
監査JSONの各要対応intentには、`operatorId`だけを補うdry-run用`replayCommand`が含まれる。
AIは個別引数と同じvalidatorを通るversion付きJSONを`--command-json`へ渡せる。

```sh
mise run slack:outbox:replay -- \
  --command-json '{"schemaVersion":1,"intentId":"notification-...","expectedRevision":3,"operatorId":"U0123456789","dryRun":true,"confirmed":false}' \
  --json
```

`AR_NOTIFICATION_REPLAY_OPERATOR_IDS`にはreplayを許可するSlack user IDを明示する。
未設定者は監査だけ利用でき、replayは拒否される。
Slack Appには照合用の`channels:history`と`groups:history`を追加し、scope変更後にワークスペースへ再インストールする。
照合結果、operator、実行前後のrevision、失敗codeは追記型監査logへ保存する。
旧GitHub deliveryは再送payloadを持たないため監査だけを行い、自動変換や自動再送はしない。

## Google Calendarへ自分の仕事を同期する

各利用者はGitHub連携後に、Slackで`/ar connect google`を一度実行する。
Google OAuthは`calendar.app.created`だけを要求し、Appが作成した専用の`ART-TRA Work`カレンダーだけを管理する。
個人の既存カレンダーや既存予定は読み取らない。

同期対象は次の条件をすべて満たすProject項目に限定する。

- GitHub OAuthで検証した本人のloginがAssigneeに設定されている
- IssueとProject項目が未完了である
- `Target date`が設定されている

期限は終日予定として投影する。
予定には状態、次の行動、GitHub Issue URLを含める。
Issue URLから決定的なevent IDを生成するため、再実行しても予定を重複作成しない。
担当解除、完了、Projectからの除外、期限削除時はAppが管理する該当予定だけをカレンダーから除外する。

手動同期はSlackで`/ar calendar sync`を実行する。
AIまたはローカル運用scriptはSlack user IDを明示して同じserviceを呼ぶ。

```sh
mise run slack:calendar -- --user U0123456789
```

連携解除は`/ar disconnect google`で行う。
同期とtoken利用は停止するが、作成済みの専用カレンダーは履歴として残す。
Googleのrefresh tokenは`AR_GOOGLE_TOKEN_KEY`を用いたAES-256-GCM暗号文だけをstate storeへ保存する。
Google OAuthのcallback URLは`AR_PUBLIC_BASE_URL/google/callback`である。

依存管理とtestにはBunを使い、Socket Modeの実行にはmise管理のNode.jsを使う。
テスト時のGitHub操作には認証済みの`gh`を使う。本番では同じdependency interfaceをGitHub App実装へ差し替える。
`/ar new`はGitHub待ちなしで最初のmodalを開き、Repository欄のSlack external selectからFirestoreへ永続化した一覧を検索する。
Slash Commandへ応答した後のbackground処理へ依存しないため、Cloud Runのrequest終了後にCPUが停止してもloading画面で止まらない。
Repository決定後はFirestoreへ永続化したIssue templateを読み、実際のfieldからmodalを生成する。
Cloud Runのinstanceが切り替わっても同じcacheを利用し、操作のたびにGitHub APIの応答を待たない。
未登録repositoryのtemplateだけは初回選択時にGitHubから取得して永続化する。

## Cloud Run runtime

本番では`AR_SLACK_TRANSPORT=http`を指定し、`/slack/events`でSlash Commandとinteractionを受信する。
`AR_GITHUB_BACKEND=app`を指定し、GitHub Appのinstallation token経由でGitHub REST APIを利用する。
production imageに`gh`は含めず、個人のGitHub tokenにも依存しない。
`/health`はCloud Runのstartup、liveness、readiness確認に利用できる。
Cloud Runでは一部の末尾`z`パスが予約されるため、health endpointに`/healthz`を使わない。
Slackのrequest署名は`SLACK_SIGNING_SECRET`で検証する。

```sh
mise run slack:container
```

このtaskは非root userで動くproduction imageをbuildし、実際にcontainerを起動して`/health`を検証する。
imageへ`.env`、local state、AI設定、文書を含めない。

本番の状態保存には`AR_STATE_BACKEND=firestore`を指定する。
Application Default Credentialsを利用し、Cloud Run service accountには対象collectionだけを読み書きできる権限を与える。
local開発では`AR_STATE_BACKEND=local`を指定し、Git管理外の`.state`を使う。

Secret ManagerからCloud Run環境変数へ次のsecretを注入する。

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `AR_OAUTH_STATE_SECRET`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `AR_GOOGLE_TOKEN_KEY`

GitHub App IDとinstallation IDは`GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`へ設定する。
GitHub AppのClient IDは`GITHUB_OAUTH_CLIENT_ID`へ、公開HTTPS URLは`AR_PUBLIC_BASE_URL`へ設定する。
GitHub Appのcallback URLは`AR_PUBLIC_BASE_URL/github/callback`である。
Google OAuth client IDは`GOOGLE_OAUTH_CLIENT_ID`へ設定し、Google Calendar APIを有効化する。
private keyは改行を含むPEM文字列、または改行を`\\n`に置換したSecret Managerの値を受け付ける。
GitHub Appには対象repositoryに対するMetadata read、Contents read、Issues read/write、Checks readを与える。
ProjectsのStatus、Priority、Target dateを読むため、Organization permissionsのProjects readも与える。
ローカルの`gh` backendでは`gh auth refresh -s read:project`で同等のscopeを追加する。
PR reviewer自動設定にはPull requests read/write、Ruleset確認にはAdministration readも与える。
Webhook URLは`AR_PUBLIC_BASE_URL/github/events`とし、`issues`、`issue_comment`、`projects_v2_item`、`pull_request`、`pull_request_review`、`pull_request_review_comment`、`check_run`、`check_suite`を購読する。
`GITHUB_WEBHOOK_SECRET`でGitHub署名を検証し、生payloadをSlackへ表示しない。

本番gatewayは検証済みwebhookをCloud Tasksへ積み、`/internal/github-events`のworker処理と分離する。
`AR_JOB_QUEUE=cloud-tasks`を指定し、project、location、queue、任意のOIDC service accountを設定する。
job本文は`AR_JOB_SECRET`でも署名し、GitHub delivery IDをCloud Tasks task IDに利用して重複投入を抑止する。
Project項目、Issue、PR、reviewの変更を処理したworkerはGitHub Projectsを再取得し、設定済みSlack Listへ反映する。
同じ再取得結果から、未着手・緊急、Blocked、CI失敗、conflictだけを`AR_SLACK_WORK_CHANNEL_ID`へ即時通知する。
通知済み状態はIssue URLと判定内容のfingerprintで重複排除し、通常の進行中作業は即時投稿しない。
Intakeの受付投稿とWorkまたはBusiness単位の親投稿tsを共通state storeへ保存する。
Task作成、期限、blocker、CI失敗、conflictなどの続報は親WorkまたはBusinessのthreadへ返信し、Task単位の親投稿をchannelへ増やさない。
日次digestはIssue別threadへ入れず、独立した一覧投稿とする。

PR作成時は、GitHubが`Closes`から解決したprimary closing Taskがちょうど1件であることを確認し、そのTask本文の予定reviewer、変更fileに対するCODEOWNERS、Rulesetを再取得する。
`Relates to`や単なるIssue番号は通知先にせず、primary closing Taskが0件、複数件、または`type/task`でない場合はchannel直下へfallbackしない。
GitHubへ正式なReview Requestを設定し、reviewerとIssue担当者をnative mentionする。
Issue作成モーダルで選択した担当者または予定reviewerがGitHub未連携の場合、Issue作成者だけへエラーを返して終わらせない。
対象のSlack user IDをnative mentionし、`🧩 GitHub連携が必要です`と`/ar connect github`を通知する。
同じ利用者への連携要求は24時間抑止し、表示名やメールアドレスからGitHubアカウントを推測しない。
Intakeは受付用の親投稿、WorkまたはBusinessは実行単位の親投稿を持ち、作成者本人を除いた担当者だけをnative mentionする。
子Taskは独立したSlack親投稿を作らず、種別固有の見出しと次の操作を親WorkまたはBusinessのthreadへ返信する。
PR作成、Issue・PRコメント、Approve、差し戻し、差し戻し後のpush、CI失敗、期限、blocker、マージ、Issue closeもprimary closing Taskの親WorkまたはBusinessのthreadへ集約する。
Task作成eventより続報が先に届いても親WorkまたはBusinessの概要を先に作り、続報をchannel直下へ平投稿しない。親を解決できないTaskは平投稿へfallbackしない。
セルフマージ対象になった最初の警告だけはthread返信をchannelにも展開し、CI通過後の通知はthread内だけにする。
コメント時はIssue担当者またはPR作成者と、コメント本文で明示された`@github-login`を通知対象とする。
差し戻し時はPR作成者、修正push時は差し戻したreviewer、マージとIssue close時は担当者を通知対象とする。
通知対象はGitHub OAuthで検証済みのaccount mappingだけをSlack user IDへ変換し、表示名やメールから推測しない。
Webhook delivery IDとイベント内容のfingerprintを保存し、再送された同一イベントを重複通知しない。
Slackメッセージは独立したHeader Blockの絵文字と短い日本語見出しで種類を示す。
Header Block、区切り線、詳細、次の操作の順で構成し、fallback textにも同じ見出しを含める。
レビューは`👀`、コメントは`💬`、差し戻しは`⚠️`、承認は`✅`、マージは`🎉`、完了は`🏁`、期限は`⏰`、要対応は`🧩`を使う。

担当者、未完了、Target dateの3条件を満たす仕事には期限通知を行う。
`AR_DEADLINE_REMINDER_DAYS`日前、期限当日、期限超過の各段階で一度だけ、検証済みaccount mappingのSlack利用者をnative mentionする。
Target dateが変わった場合は新しい期限として再判定する。
定期実行は固定JSON `{"schemaVersion":1,"kind":"work.deadline-remind"}` を`/internal/deadline-reminders`へ送る。
本文に対する`X-Ar-Job-Signature`を設定し、Cloud Scheduler等から一日一回実行する。

Webhookの取りこぼしを修復する定期同期は、固定JSON `{"schemaVersion":1,"kind":"project-list.sync"}` を`/internal/project-list-sync`へ送る。
本文に対する`X-Ar-Job-Signature`を設定し、Cloud Scheduler等から定期実行する。
定期同期と`/ar project sync`は同じ同期serviceと決定的なrow変換を使用する。

Issue作成metadataの定期同期は、固定JSON `{"schemaVersion":1,"kind":"issue-metadata.sync"}` を`/internal/issue-metadata-sync`へ送る。
本文に対する`X-Ar-Job-Signature`を設定し、Cloud Scheduler等から定期実行する。
同期はrepository一覧、既定repository、一度利用されたrepositoryのIssue templateをGitHubから再取得し、Firestore cacheを更新する。
Slackの通常操作はこのcacheだけを読み、GitHubの一時的な遅延やCloud Runのcold startから分離する。

個人Calendarの定期同期は、固定JSON `{"schemaVersion":1,"kind":"calendar.sync"}` を`/internal/calendar-sync`へ送る。
本文に対する`X-Ar-Job-Signature`を設定し、Cloud Scheduler等から定期実行する。
接続済み利用者ごとに本人担当項目だけを再取得し、手動の`/ar calendar sync`と同じserviceで投影する。

日次作業一覧は、固定JSON `{"schemaVersion":1,"kind":"work.digest"}` を`/internal/work-digest`へ送る。
本文に対する`X-Ar-Job-Signature`を設定し、Cloud Scheduler等から一日一回実行する。
優先度、期限、次の行動で整列した未完了作業を一投稿へまとめ、生のGitHub eventを連続投稿しない。

PR作成・更新時は、唯一のprimary closing Taskにあるversion付き予定reviewer、変更fileに最後に一致するCODEOWNERS、active Rulesetの必要承認数をGitHubから再取得する。
GitHubへ正式なuser/team review requestを設定した後、検証済みaccount mappingを持つ利用者だけSlackでmentionする。
通知にはPR、選定理由、目標日、必要承認数、次の操作を表示し、primary closing Taskの親WorkまたはBusinessのthreadへ集約する。
同じreviewer・理由・期限では既定24時間再通知せず、未対応が続く場合だけ再通知する。
Cloud Schedulerは固定JSON `{"schemaVersion":1,"kind":"review.remind"}` を`/internal/review-reminders`へ定期送信する。
本文に対する`X-Ar-Job-Signature`を設定し、workerは保存済みread modelのPRだけをGitHubから再取得して未対応を判定する。

AIはSlackと同じread modelを次で取得できる。

```sh
mise run slack:review -- owner/repository#123
```

Cloud Runへのdeploy pipelineは各projectのCDが担当する。
本repositoryはcontainer、health contract、環境変数、永続化境界までを提供する。
