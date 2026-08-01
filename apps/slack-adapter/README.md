# Slack adapter

GitHub の生イベントを Slack へ転送せず、GitHub と Projects から再取得した現在状態を人間向け read model に変換する境界である。

## 原則

- Webhook は表示データではなく再取得のきっかけとして扱う。
- Slack の即時通知は、blocker、急ぎの未割当、CI 失敗、conflict、review 依頼に限定する。
- 通常の進行中作業は digest と Canvas に集約し、完了済み項目は通知しない。
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

```sh
mise run slack:dev
```

## Canvasを同期する

`AR_SLACK_CANVAS_CHANNEL_ID`へ同期先channel IDを設定し、次を実行する。

```sh
mise run slack:canvas
```

初回はchannel Canvasを作成し、Canvas IDをGit管理外の`.state`へ保存する。
2回目以降は同じCanvasを全体更新する。
起動中のadapterでは、同期先channelから`/ar canvas sync`を実行しても同じ処理を呼び出せる。

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

GitHub App IDとinstallation IDは`GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`へ設定する。
private keyは改行を含むPEM文字列、または改行を`\\n`に置換したSecret Managerの値を受け付ける。
GitHub Appには対象repositoryに対するMetadata read、Contents read、Issues read/writeを与える。

Cloud Runへのdeploy pipelineは各projectのCDが担当する。
本repositoryはcontainer、health contract、環境変数、永続化境界までを提供する。
