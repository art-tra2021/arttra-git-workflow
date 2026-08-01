# Slack adapter

GitHub の生イベントを Slack へ転送せず、GitHub と Projects から再取得した現在状態を人間向け read model に変換する境界である。

## 原則

- Webhook は表示データではなく再取得のきっかけとして扱う。
- Slack の即時通知は、blocker、急ぎの未割当、CI 失敗、conflict、review 依頼に限定する。
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
ART-TRAではownerを`art-tra2021`、Project番号を`8`とする。

`AR_SLACK_PROJECT_LIST_CHANNEL_ID`へ同期先channel IDを設定する。
CLIから初回作成する場合は、`AR_SLACK_PROJECT_LIST_MANAGER_ID`へタブを設定する管理者のSlack user IDを任意で設定する。`/ar project sync`では実行者へ自動で閲覧権限を付ける。
Appは初回同期で専用のSlack Listを作成し、`lists:read`と`lists:write`でGitHub Projectsの現在状態を反映する。
作成したListは対象channelへread権限で共有し、Slack側を第二の正本にしない。
Listの列はタスク、状態、優先度、Slack担当者、GitHub担当者、期限日、次の行動、リポジトリ、GitHubリンクである。

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
GitHub OAuthで対応付け済みの担当者はSlackのnative user列へ反映し、未連携者はGitHub担当者列だけを表示する。
起動中のadapterでは、同期先channelから`/ar project sync`を実行しても同じ処理を呼び出せる。
`/ar list sync`と従来の`/ar canvas sync`も移行用aliasとして同じ処理を呼ぶ。
同じchannelへの同期はleaseで直列化し、Webhook、定期同期、人間の手動操作が重なって行を重複作成しない。

非公開channelで新規作成・通知を行うには、channel管理権限を持つ利用者が次を実行する。

```text
/invite @ART-TRA Work Lab
```

初回同期後、作成された`ART-TRA Work` Listをchannel tabへ一度だけ追加する。
SlackのLists APIはpaid planでのみ利用できるため、未対応planでは同期を開始しない。

Issue modalの担当者と予定レビュワーはSlackのネイティブなメンバー選択を使う。
検証済みGitHub user IDへ変換したうえで、担当者はAssignee、予定レビュワーはIssue内の`@login`と構造化ID、PR作成時はGitHubのReview Requestへ反映する。
表示名、同名ユーザー、メールアドレスから対応を推測しない。

`AR_SLACK_APPROVER_IDS`には、`merge/self`または`merge/emergency`を許可できるSlack user IDをカンマ区切りで設定する。
申請者本人による承認を許すPL等は、`AR_SLACK_SELF_APPROVER_IDS`にも明示する。
通常レビューのIssueは即時作成し、権限昇格を伴うIssueだけをSlackの承認ボタンへ送る。

承認待ちと監査eventは共通state storeへ保存する。
本番のFirestoreでは原子的なrevision更新により、Slackのボタンが二重実行されてもIssueを一度だけ作成する。
有効期限は`AR_APPROVAL_TTL_MINUTES`で設定し、既定は24時間である。
申請・処理開始・承認・却下・失効・失敗を追記型監査eventとして記録する。
承認ボタンを押した時点でGitHub Appまたは`gh`の権限とIssue templateを再検証する。

Slackでは`/ar approval <approval-id>`、AIや運用scriptでは次のcommandから、同じversion付きJSON statusを確認できる。

```sh
mise run slack:approval -- <approval-id>
```

依存管理とtestにはBunを使い、Socket Modeの実行にはmise管理のNode.jsを使う。
テスト時のGitHub操作には認証済みの`gh`を使う。本番では同じdependency interfaceをGitHub App実装へ差し替える。
`/ar new`はrepositoryを選択した後、そのrepositoryの`.github/ISSUE_TEMPLATE/*.yml`を読み、実際のfieldからmodalを生成する。

## Cloud Run runtime

本番では`AR_SLACK_TRANSPORT=http`を指定し、`/slack/events`でSlash Commandとinteractionを受信する。
`AR_GITHUB_BACKEND=app`を指定し、GitHub Appのinstallation token経由でGitHub REST APIを利用する。
production imageに`gh`は含めず、個人のGitHub tokenにも依存しない。
`/healthz`はCloud Runのstartup、liveness、readiness確認に利用できる。
Slackのrequest署名は`SLACK_SIGNING_SECRET`で検証する。

```sh
mise run slack:container
```

このtaskは非root userで動くproduction imageをbuildし、実際にcontainerを起動して`/healthz`を検証する。
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

GitHub App IDとinstallation IDは`GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`へ設定する。
GitHub AppのClient IDは`GITHUB_OAUTH_CLIENT_ID`へ、公開HTTPS URLは`AR_PUBLIC_BASE_URL`へ設定する。
GitHub Appのcallback URLは`AR_PUBLIC_BASE_URL/github/callback`である。
private keyは改行を含むPEM文字列、または改行を`\\n`に置換したSecret Managerの値を受け付ける。
GitHub Appには対象repositoryに対するMetadata read、Contents read、Issues read/write、Checks readを与える。
ProjectsのStatus、Priority、Target dateを読むため、Organization permissionsのProjects readも与える。
ローカルの`gh` backendでは`gh auth refresh -s read:project`で同等のscopeを追加する。
PR reviewer自動設定にはPull requests read/write、Ruleset確認にはAdministration readも与える。
Webhook URLは`AR_PUBLIC_BASE_URL/github/events`とし、`issues`、`projects_v2_item`、`pull_request`、`pull_request_review`、`check_run`、`check_suite`を購読する。
`GITHUB_WEBHOOK_SECRET`でGitHub署名を検証し、生payloadをSlackへ表示しない。

本番gatewayは検証済みwebhookをCloud Tasksへ積み、`/internal/github-events`のworker処理と分離する。
`AR_JOB_QUEUE=cloud-tasks`を指定し、project、location、queue、任意のOIDC service accountを設定する。
job本文は`AR_JOB_SECRET`でも署名し、GitHub delivery IDをCloud Tasks task IDに利用して重複投入を抑止する。
Project項目、Issue、PR、reviewの変更を処理したworkerはGitHub Projectsを再取得し、設定済みSlack Listへ反映する。
同じ再取得結果から、未着手・緊急、Blocked、CI失敗、conflictだけを`AR_SLACK_WORK_CHANNEL_ID`へ即時通知する。
通知済み状態はIssue URLと判定内容のfingerprintで重複排除し、通常の進行中作業は即時投稿しない。

Webhookの取りこぼしを修復する定期同期は、固定JSON `{"schemaVersion":1,"kind":"project-list.sync"}` を`/internal/project-list-sync`へ送る。
本文に対する`X-Ar-Job-Signature`を設定し、Cloud Scheduler等から定期実行する。
定期同期と`/ar project sync`は同じ同期serviceと決定的なrow変換を使用する。

日次作業一覧は、固定JSON `{"schemaVersion":1,"kind":"work.digest"}` を`/internal/work-digest`へ送る。
本文に対する`X-Ar-Job-Signature`を設定し、Cloud Scheduler等から一日一回実行する。
優先度、期限、次の行動で整列した未完了作業を一投稿へまとめ、生のGitHub eventを連続投稿しない。

PR作成・更新時は、linked Issueのversion付き予定reviewer、変更fileに最後に一致するCODEOWNERS、active Rulesetの必要承認数をGitHubから再取得する。
GitHubへ正式なuser/team review requestを設定した後、検証済みaccount mappingを持つ利用者だけSlackでmentionする。
通知にはPR、選定理由、目標日、必要承認数、次の操作を表示する。
同じreviewer・理由・期限では既定24時間再通知せず、未対応が続く場合だけ再通知する。
Cloud Schedulerは固定JSON `{"schemaVersion":1,"kind":"review.remind"}` を`/internal/review-reminders`へ定期送信する。
本文に対する`X-Ar-Job-Signature`を設定し、workerは保存済みread modelのPRだけをGitHubから再取得して未対応を判定する。

AIはSlackと同じread modelを次で取得できる。

```sh
mise run slack:review -- owner/repository#123
```

Cloud Runへのdeploy pipelineは各projectのCDが担当する。
本repositoryはcontainer、health contract、環境変数、永続化境界までを提供する。
