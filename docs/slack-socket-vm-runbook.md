# Slack Socket Mode常駐VM runbook

Slackの操作（`/ar`、ボタン、modal）を、常駐するSocket Modeのprocessで受けるための手順である。
GitHub webhookと定期jobは、これまでどおりCloud Run `arttra-work-slack`が受ける。

## 分ける理由

Slackは、コマンドやボタンへの応答を3秒以内に求める。
Cloud Runは使われていないと止まり、止まった状態からの起動に4〜6秒かかる（2026-10〜11の実測で中央値4.2秒、95%点5.7秒）。
そのため、止まっている間に来た`/ar new`には応答できず、Slackには何も返らなかった。
Socket Modeでは、adapterがSlackへの接続を常に張っておき、操作をその接続で受け取る。
processが常に起きているので、起動を待つことがない。

GitHubは応答を10秒まで待ち、失敗した配送はCloud Tasksが再試行する。
そのため、GitHub webhookはCloud Runのままでよい。

## 構成

| 項目 | 値 |
|---|---|
| VM | `arttra-work-slack-socket`（`us-west1-b`、`e2-micro`、Container-Optimized OS） |
| service account | `arttra-work-runtime@bmarumado.iam.gserviceaccount.com`（Cloud Runと同じ） |
| image | Cloud Runのtemplateが参照するdigestと同じもの |
| 環境変数 | Cloud Runの非secret環境変数を引き継ぎ、`AR_SLACK_TRANSPORT=socket`へ置き換える。`PORT`は渡さない |
| secret | Cloud Runと同じSecret Managerの参照に、`SLACK_APP_TOKEN`（`arttra-work-slack-app-token`）を足す。`SLACK_SIGNING_SECRET`は使わない |
| 状態 | Cloud Runと同じFirestoreを使う |
| ログ | Cloud Loggingの`gce_instance`（docker `gcplogs` driver） |

VMの起動時に、cloud-init（`apps/slack-adapter/deploy/socket-vm/cloud-init.yaml`）がSecret Managerから秘密を読み、tmpfsの`/run/arttra-slack/env`へ書く。
秘密の値はmetadataにもディスクにも置かない。
containerはsystemdが監視し、止まれば10秒後に起動し直す。VMを再起動しても自動で立ち上がる。

e2-microは米国の3リージョンで1台まで無料枠に入る。
外部IPv4アドレスには別に料金がかかる見込みである（1時間あたり0.005ドル、月に約3.6ドル）。

## 初回の準備

GCPの権限を持つ操作者が、次を一度だけ実行する。

```sh
ar_sa="arttra-work-runtime@bmarumado.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding bmarumado \
  --member "serviceAccount:${ar_sa}" --role roles/logging.logWriter --condition None
gcloud artifacts repositories add-iam-policy-binding arttra-work \
  --location asia-northeast1 --project bmarumado \
  --member "serviceAccount:${ar_sa}" --role roles/artifactregistry.reader
gcloud secrets create arttra-work-slack-app-token \
  --replication-policy automatic --project bmarumado
gcloud secrets add-iam-policy-binding arttra-work-slack-app-token --project bmarumado \
  --member "serviceAccount:${ar_sa}" --role roles/secretmanager.secretAccessor
```

Slack Appの管理者が、Slack Appの設定画面で次を行う。

1. Basic Informationの「App-Level Tokens」で、scope `connections:write`のtokenを作る。
2. 作ったtoken（`xapp-`で始まる）を、端末の履歴に残さない形でSecret Managerへ登録する。

   ```sh
   gcloud secrets versions add arttra-work-slack-app-token --data-file=- --project bmarumado
   ```

   tokenを貼り付けた後、Enterを押してからCtrl-Dで入力を終える。
3. 「Socket Mode」を有効にする。有効にした時点から、Slackの操作はRequest URLではなくSocket Modeの接続へ送られる。

## 配備

まずpreviewで、作成か更新か、使うimage、引き継ぐ環境変数名とsecret名を確かめる。
previewは秘密の値を読まない。

```sh
mise run slack:socket:preview
```

内容がよければ配備する。
VMがなければ作成し、あればmetadataを更新してresetする（30秒〜1分ほど止まる）。

```sh
mise run slack:socket:deploy -- --yes
```

1〜2分待ってから状態を確かめる。
VMが`RUNNING`で、直近7日のログに`Socket Modeを起動しました`があれば`healthy: true`になる。
Slack側のSocket Modeが無効なまま起動した場合は、`slackSocketModeDisabled: true`となり`healthy: false`になる。
このときはSlack AppのSocket Modeを有効にしてから、もう一度`mise run slack:socket:deploy -- --yes`で起動し直す。

```sh
mise run slack:socket:status
```

最後にSlackで`/ar new`を実行し、Issue作成のmodalが開くことを確かめる。

## Cloud Run更新時の配備

Cloud Runへ新しいimageを配備した後は、同じimageをVMにも配備する。
`slack:socket:deploy`は、Cloud Runのtemplateが参照するdigestを使う。

```sh
mise run slack:release:deploy -- --commit <main-sha> --yes
mise run slack:socket:deploy -- --yes
```

Cloud Runの環境変数やsecret参照を変えた場合も、同じ手順でVMへ反映する。

## 切り戻し

前のimageへ戻すときは、digestを指定して配備する。

```sh
mise run slack:socket:deploy -- --image asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter@sha256:<digest> --yes
```

Socket Modeをやめて、Cloud RunのHTTP受信へ戻すときは次の順で行う。

1. Cloud Runのingressが`all`であることを確かめる。`internal`のままでは、Slackからの要求を受け付けない。
2. Slack Appの設定画面で「Socket Mode」を無効にする。Slashコマンドとinteractivityの送り先が`AR_PUBLIC_BASE_URL/slack/events`であることを確かめる。
3. VMを止める。

   ```sh
   mise run slack:socket:stop -- --yes
   ```

## 障害時の確認先

- `mise run slack:socket:status`が`healthy: false`のとき：VMの状態と、Cloud Loggingの`resource.type="gce_instance"`のログを見る。
- secretを読めないとき：`arttra-work-slack-app-token`にENABLEDのversionがあるか、service accountに`secretmanager.secretAccessor`があるかを確かめる。
- imageを取得できないとき：service accountに`artifactregistry.reader`があるかを確かめる。
- Slack側で`/ar`が応答しないとき：Slack AppのSocket Modeが有効か、app-level tokenが失効していないかを確かめる。
