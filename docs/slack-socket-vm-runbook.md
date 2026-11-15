# Slack Socket Mode常駐VM runbook

Slackの操作（`/ar`、ボタン、modal）を、常駐するSocket Modeのprocessで受けるための手順である。
同じprocessの中で、定期処理（一覧の同期、再通知、日次まとめなど）も動かす（[定期処理](#定期処理)）。
GitHub webhookとOAuth callbackは、これまでどおりCloud Run `arttra-work-slack`が受ける。

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
| 環境変数 | Cloud Runの非secret環境変数を引き継ぎ、`AR_SLACK_TRANSPORT=socket`へ置き換える。`PORT`は渡さない。VMだけの値（`AR_SCHEDULER=inprocess`）を`apps/slack-adapter/deploy/socket-vm/vm-overrides.conf`から足す |
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

## 定期処理

### なぜVMで動かすか

以前はCloud Schedulerの7つのjobが、Cloud Runの`/internal/*`を15分ごと、毎時、毎日に呼んでいた。
Cloud Runは`cpu-throttling=false`（起動している間はずっとCPUを確保し、その間ずっと課金する）で動いていた。
15分ごとの呼び出しで、インスタンスが止まる前に次の呼び出しが来るため、インスタンスが一度も止まらなかった。
Cloud Monitoringの`billable_instance_time`は1週あたり約605,000秒で、週の全時間（604,800秒）に当たる。
これが想定外のコストの主な原因だった。

Socket ModeのVMは、Slackの操作を受けるために常に起きている。
定期処理をこのprocessの中で動かせば、Cloud Runを定期的に起こす必要がなくなる。
Cloud Runは、GitHub webhookとOAuth callbackが来たときだけ起き、要求を処理している間だけ課金される設定（`--cpu-throttling`）にできる。

### 設定

環境変数`AR_SCHEDULER`で切り替える。

| 値 | 動き |
| --- | --- |
| `off`（未設定時の既定） | process内では定期処理を動かさない。`/internal/*`をHTTPで呼べば従来どおり実行する |
| `inprocess` | process内のtimerで定期処理を動かす。`socket`でも`http`でも動くが、本番ではVMだけに設定する |

これ以外の値では、adapterは起動を拒否する。

VMの値は`apps/slack-adapter/deploy/socket-vm/vm-overrides.conf`に書き、`slack:socket:deploy`がCloud Runから引き継いだ同名の値を置き換える。
Cloud Runには`AR_SCHEDULER`を設定しない。
Cloud Runは要求が無い間CPUを止めるので、process内のtimerは決まった時刻に動かない。
配備の前に`mise run slack:socket:preview`の`target.vmEnv`が`{"AR_SCHEDULER":"inprocess"}`であることを確かめる。

その配備だけ値を変えるときは、`--env`を渡す。次に`--env`なしで配備すると、ファイルの値へ戻る。

```sh
mise run slack:socket:deploy -- --env AR_SCHEDULER=off --yes
```

### 間隔

| ジョブ | 間隔 | 1回の枠 | 前提条件（無ければ登録しない） |
| --- | --- | --- | --- |
| `work-digest` | 毎日9:00（JST） | JSTの日付 | `AR_SLACK_WORK_CHANNEL_ID`または`AR_SLACK_PROJECT_LIST_CHANNEL_ID` |
| `deadline-reminders` | 毎日9:05（JST） | JSTの日付 | 同上 |
| `issue-metadata-sync` | 1時間ごと（毎時0分） | UTCの時刻 | なし |
| `project-list-sync` | 1時間ごと | UTCの時刻 | `AR_SLACK_PROJECT_LIST_CHANNEL_ID`と`AR_SLACK_SHARED_REPOSITORY` |
| `project-canvas-sync` | 1時間ごと | UTCの時刻 | なし |
| `calendar-sync` | 1時間ごと | UTCの時刻 | Google Calendar連携の設定 |
| `review-reminders` | 1時間ごと | UTCの時刻 | `AR_GITHUB_BACKEND=app`と通知channel |

以前は3つの同期を15分ごとに回していたが、1時間ごとにした。
GitHubの変更はwebhookで即時に反映されるので、定期同期は取りこぼしの修復だけを受け持つ。
間隔と時刻は`apps/slack-adapter/src/job-scheduler.ts`の`DEFAULT_JOB_CADENCES`にまとめてある。

ジョブは上の表の順に1つずつ実行し、同時に重ねない（e2-microのメモリは1GBのため）。
1つのジョブが失敗しても（例外を投げても）、次のジョブとSlackの操作処理は止まらない。
失敗した枠はその場で再試行せず、次の枠で実行する。

ジョブには制限時間がある（毎時ジョブ10分、日次ジョブ15分）。
制限時間を過ぎても終わらない（応答しないAPIを待ち続けるなど）ときは、その枠を失敗（`reason: "timeout"`）として記録し、次のジョブへ進む。
ただし、JavaScriptでは実行中の処理を外から止められないため、終わらない処理はprocessの中で動き続ける。
その処理が終わるまで、同じジョブは新しく始めない（次の枠も見送り、その旨をログに出す）。
終わった後は、まだ実行していない枠があれば、次に起きたとき（最長10分後）に実行する。タイムアウトした枠そのものは実行し直さない。
他のジョブとSlackの操作処理は、この間も動く。

起動した直後は、まだ実行されていない現在の枠を実行する。
たとえば10:30にVMが再起動した場合、その日の`work-digest`がまだなら10:30に送る。9:00より前に起動した場合は9:00まで待つ。
日次ジョブは、予定時刻から3時間を過ぎたらその日は実行しない（`status: "skipped"`、`reason: "too-late"`）。
たとえば23:50に起動しても、その日の日次まとめは送らず、翌日の9:00に送る。毎時ジョブにはこの上限はない。

制限時間、奪い直しの余裕と回数、遅延の上限、記録の保存期間は`job-scheduler.ts`の`DEFAULT_SCHEDULER_TIMING`にまとめてある。

### 同じ枠を一度だけ実行する仕組み

ジョブを実行する前に、「ジョブ名:枠」をkeyにした記録をFirestoreへ新規作成する。
Firestoreの新規作成は、同じkeyが既にあれば失敗する。
作成できたprocessだけが実行するので、VMの再起動、processの二重起動、HTTPからの呼び出しと重なっても、同じ枠は一度だけ実行される。

HTTPの`/internal/*`から呼んだ場合も、枠が空いていれば同じ記録を作る（`source: "http"`）。
このため、process内の定期処理は、HTTPで既に実行された枠を実行しない。
逆に、HTTPの呼び出しは明示の要求として扱い、既に実行済みの枠でも従来どおり実行する。
日次ジョブを予定時刻より前にHTTPで呼んだ場合は、その日の定期実行を止めないよう記録しない。

実行中にprocessが落ちると（配備の`instances reset`、OOM、VMの再起動）、記録は`running`のまま残る。
このままではその枠が二度と実行されないため、開始（`startedAt`）から「制限時間＋5分」を過ぎた`running`の記録は、止まった実行とみなす。
schedulerはこの記録を奪い直して実行し直す（`attempt`が1増える）。
奪い直しは記録の`revision`を条件にした書き換え（compareAndSet）で行うので、2つのprocessが同時に奪い直しても、実行し直すのは1つだけである。
同じ枠で3回実行しても終わらなかった場合は、諦めて失敗（`reason: "attempts-exhausted"`）にする。
日次ジョブで、予定時刻から3時間を過ぎていれば、実行し直さずに`skipped`（`reason: "too-late"`）にする。

### 実行の記録の見方

記録はFirestoreの`<AR_FIRESTORE_PREFIX>_scheduled_job_run` collectionにある。本番（`AR_FIRESTORE_PREFIX=arttra_prod`）では`arttra_prod_scheduled_job_run`である。
document IDは「ジョブ名:枠」をbase64urlにした文字列で、中身は`value`の下にある。

| field | 意味 |
| --- | --- |
| `value.job` | ジョブ名 |
| `value.window` | 枠。毎時は`2026-11-14T03Z`（UTCの3時台）、日次は`2026-11-14`（JSTの日付） |
| `value.source` | `inprocess`（VMのtimer）または`http`（`/internal/*`の呼び出し） |
| `value.owner` | 実行したprocess（`<hostname>:<pid>:<乱数>`、HTTPは`http:<pid>`） |
| `value.status` | `running`、`success`、`failed`、`skipped`（実行せずに見送った） |
| `value.startedAt`、`value.finishedAt` | 開始と終了の時刻（UTC）。奪い直した記録の`startedAt`は、奪い直した時刻 |
| `value.reason` | 失敗や見送りの理由（`timeout`、`attempts-exhausted`、`too-late`、ジョブのエラー） |
| `value.summary` | 件数などの要約（例：`itemCount=12 created=0 updated=1 deleted=0`） |
| `value.attempt` | この枠を実行し始めた回数。奪い直すたびに1増える。見送った記録は0 |
| `value.revision` | 記録を書き換えた回数。同時の書き換えを防ぐために使う |
| `expireAt` | 記録を消してよい時刻（作成または更新の30日後）。TTL policyが見るため、`value`の外にDate型で置く |

Firestoreの画面で`value.job`と`value.window`で絞り込む。
特定の記録のdocument IDは次で求められる。

```sh
printf '%s' 'work-digest:2026-11-14' | base64 | tr '+/' '-_' | tr -d '='
```

`running`のまま`finishedAt`が空の記録は、実行中か、実行中にprocessが止まったことを示す。
止まった場合は、上に書いたとおり制限時間＋5分の後に実行し直す。
`attempts-exhausted`や`too-late`で終わった枠を実行したいときは、`/internal/<ジョブ名>`を署名付きで呼んで手動で実行する。

#### 古い記録を消す（TTL policy）

記録は1日に約120件増える。
FirestoreのTTL policyを設定すると、`expireAt`を過ぎた記録をFirestoreが自動で消す（消えるまでに通常24時間ほどかかる）。
GCPの権限を持つ操作者が一度だけ設定する。schedulerやscriptは設定しない。

```sh
gcloud firestore fields ttls update expireAt \
  --collection-group=arttra_prod_scheduled_job_run \
  --enable-ttl --project bmarumado
```

設定の反映には10分以上かかる。状態は次で確かめる（`ttlConfig.state`が`ACTIVE`になればよい）。

```sh
gcloud firestore fields ttls list --collection-group=arttra_prod_scheduled_job_run --project bmarumado
```

TTL policyを設定する前に作られた記録も、`expireAt`があれば消える。

### ログの見方

VMのログはCloud Loggingの`resource.type="gce_instance"`にある。
定期処理の行はすべて「定期処理」で始まり、ジョブ名と枠を含む。

```sh
gcloud logging read 'resource.type="gce_instance" AND "定期処理"' \
  --project bmarumado --freshness 1d --limit 50 \
  --format 'value(timestamp,jsonPayload.message)'
```

| 行 | 意味 |
| --- | --- |
| `定期処理をprocess内で開始しました: work-digest, ...` | 起動時に1回。登録されたジョブの一覧 |
| `定期処理 <job> (<枠>) を実行しました: <要約> (<ms>ms)` | 成功 |
| `定期処理 <job> (<枠>) に失敗しました: <理由> (<ms>ms)` | 失敗。errorとして出る |
| `定期処理 <job> (<枠>) は実行済みのため見送りました。` | 別のprocessかHTTPで実行済み |
| `定期処理 <job> (<枠>) は別の実行（<owner>）が実行中のため見送りました。<時刻>に確かめ直します。` | 別のprocessかHTTPが実行中。止まった実行とみなす時刻にもう一度確かめる |
| `定期処理 <job> (<枠>) は<時刻>からrunningのまま止まっているため、実行し直します（<n>回目）。` | 実行中に落ちたprocessの枠を奪い直した。warningとして出る |
| `定期処理 <job> (<枠>) は<n>回実行しても終わらなかったため、諦めて失敗にしました。` | 試行回数の上限。errorとして出る |
| `定期処理 <job> (<枠>) は別のprocessが先に記録を更新したため見送りました。` | 奪い直しを他のprocessに先を越された |
| `定期処理 <job> (<枠>) が制限時間（<n>分）を過ぎても終わらないため、失敗として次へ進みます。` | タイムアウト。errorとして出る |
| `定期処理 <job> (<枠>) は、制限時間を過ぎた前の実行（<枠>）がまだ終わっていないため見送りました。` | タイムアウトした処理がまだ動いている。枠ごとに1回出る |
| `定期処理 <job> (<枠>) の、制限時間を過ぎた実行が終わりました: <要約>` | タイムアウトした処理が後から終わった。記録は書き換えない |
| `定期処理 <job> (<枠>) は予定時刻から3時間を過ぎたため、この日は実行しません。` | 日次ジョブの遅れすぎ。warningとして出る |
| `定期処理 <job> (<枠>) の結果を記録しませんでした。記録が別の実行に引き継がれています。` | 実行の間に他のprocessが奪い直していた |
| `定期処理 <job> (<枠>) の実行権を取れませんでした: <理由>` | Firestoreに書けなかった。5分後に同じ枠でもう一度試す |
| `SIGTERMを受けたため、定期処理のtimerを止めました。` | 停止時。新しいジョブを始めない |

失敗だけを見るときは、`AND severity>=ERROR`を足す。

### Cloud Runを要求時だけの課金にしてよいか

`--cpu-throttling`では、Cloud Runは要求を処理している間だけCPUを割り当てる。
応答を返した後に続く処理（待たずに走らせたPromise、`setTimeout`など）は、CPUが止まって進まないか、大きく遅れる。
そこで、Cloud Runに残るHTTPの経路が、応答の後の処理に頼っていないかをコードで確かめた（2026-11-14時点）。

| 経路 | 結果 | 根拠 |
| --- | --- | --- |
| `GET /health` | 問題なし。同期で応答する | `apps/slack-adapter/src/start.ts:465` |
| `GET /github/callback` | 問題なし。連携の完了を待ってから応答する | `start.ts:477` |
| `GET /google/callback` | 問題なし。連携と初回同期を待ってから応答する | `start.ts:510`、`google-calendar-callback.ts`の`completeGoogleCalendarCallback` |
| `POST /github/events` | 問題なし。Cloud Tasksへの登録を待ってから202を返す | `start.ts:556`、`job-queue.ts:62`、imageの既定`AR_JOB_QUEUE=cloud-tasks`（`apps/slack-adapter/Dockerfile:21`） |
| `POST /internal/github-events` | 問題なし。webhookの処理を待ってから応答する | `start.ts:788` |
| `POST /internal/*`（定期処理7件） | 問題なし。ジョブの完了と実行記録を待ってから応答する | `start.ts:564`〜`746` |

`apps/slack-adapter/src`で`setTimeout`を使うのは、`AR_SCHEDULER=inprocess`のときに動くschedulerだけである（`job-scheduler.ts`の`systemClock`。起床の予約とジョブの制限時間に使う）。
Cloud Runには`AR_SCHEDULER`を設定しないので、Cloud Runではschedulerもその`setTimeout`も動かない。
`setInterval`は使っていない。
待たれていないPromiseは、schedulerが制限時間を過ぎたジョブの終わりをログに出すためのもの（`job-scheduler.ts`の`execute`）だけで、これもschedulerの中にある。
scheduler以外の例外が2つある。

- `AR_JOB_QUEUE=local`の`LocalGitHubJobQueue`は、`setImmediate`でwebhookを応答の後に処理する（`job-queue.ts:89`）。手元の開発用であり、Cloud Runでは使わない。
- `POST /slack/events`（Socket Modeを無効にしたときだけCloud Runが受ける）は、Boltの`processBeforeResponse: false`で、受け付けの応答（ack）を返した後に処理を続ける（`start.ts:292`）。Slackの3秒制限があるため、応答前に終える形へは変えていない。Socket Modeをやめる切り戻しでは、先にCloud Runを`--no-cpu-throttling`へ戻す。

### 移行手順

GCPの権限を持つ操作者が行う。各手順の後に、次へ進んでよいかを確かめる。
VMの定期処理とCloud Schedulerを同時に動かさないよう、先にCloud Schedulerを止める。
HTTPの`/internal/*`は明示の要求として毎回実行するので、両方が動いていると毎時ジョブが2回ずつ走る。
手順1から2の間（数分から数十分）は定期処理が止まる。VMは起動した時点で、その時間の毎時ジョブと、予定時刻から3時間以内の日次ジョブを実行する。
手順2は、JSTの9:00から12:10の間には行わない。
移行前のCloud Runは実行記録を残さないため、その日の9:00にCloud Schedulerから送った日次まとめと期限通知を、VMがもう一度送ってしまう（12:05を過ぎれば、遅れすぎとして送らない）。

1. Cloud Schedulerの`arttra-*`ジョブを一時停止する。
   2026-11-15時点で、`arttra-*`ジョブは`asia-northeast1`にある。

   ```sh
   ar_location="asia-northeast1"
   ar_jobs=$(gcloud scheduler jobs list --location "${ar_location}" --project bmarumado \
     --filter 'name~/jobs/arttra-' --format 'value(name.basename())')
   for ar_job in ${ar_jobs}; do
     gcloud scheduler jobs pause "${ar_job}" --location "${ar_location}" --project bmarumado
   done
   gcloud scheduler jobs list --location "${ar_location}" --project bmarumado \
     --filter 'name~/jobs/arttra-' --format 'table(name.basename(),state)'
   ```

   すべて`PAUSED`になったことを確かめる。

2. PRをmainへmergeし、Cloud RunとVMへ配備する。VMには`AR_SCHEDULER=inprocess`が入る。

   ```sh
   mise run slack:release:deploy -- --commit <main-sha> --yes
   mise run slack:socket:preview
   ```

   previewの`target.vmEnv`が`{"AR_SCHEDULER":"inprocess"}`であることを確かめる。
   Cloud Runのtemplateに`AR_SCHEDULER`が無いことも確かめる（何も出なければよい）。

   ```sh
   gcloud run services describe arttra-work-slack --region asia-northeast1 --project bmarumado --format json \
     | jq '.spec.template.spec.containers[0].env[] | select(.name == "AR_SCHEDULER")'
   mise run slack:socket:deploy -- --yes
   mise run slack:socket:status
   ```

3. ログと実行記録で各ジョブの実行を確かめる。
   起動時の`定期処理をprocess内で開始しました`に7つのジョブ名が並ぶこと、毎時0分過ぎに5つの毎時ジョブの`を実行しました`が出ることを確かめる。
   翌朝9:00と9:05（JST）に`work-digest`と`deadline-reminders`が出ること、Slackに日次まとめが1件だけ届くことを確かめる。
   Firestoreの`arttra_prod_scheduled_job_run`で、各枠の記録が1件ずつ`success`になり、`source`が`inprocess`であることも見る。
   問題があれば[定期処理の切り戻し](#定期処理の切り戻し)に従う。

4. Cloud Schedulerの`arttra-*`ジョブの定義を保存してから削除する。

   ```sh
   ar_location="asia-northeast1"
   mkdir -p scheduler-backup
   for ar_job in $(gcloud scheduler jobs list --location "${ar_location}" --project bmarumado \
       --filter 'name~/jobs/arttra-' --format 'value(name.basename())'); do
     gcloud scheduler jobs describe "${ar_job}" --location "${ar_location}" --project bmarumado \
       --format yaml >"scheduler-backup/${ar_job}.yaml"
   done
   ls scheduler-backup
   ```

   保存した定義には署名headerが含まれる。リポジトリには入れず、安全な場所に保管する。
   保存できたことを確かめてから、1件ずつ削除する。

   ```sh
   gcloud scheduler jobs delete <job-id> --location "${ar_location}" --project bmarumado
   ```

5. Cloud Runを要求時だけの課金へ切り替える。

   ```sh
   gcloud run services update arttra-work-slack --region asia-northeast1 --project bmarumado --cpu-throttling
   ```

   切り替えた後、GitHubでIssueにコメントするなどしてwebhookを1件起こし、Slackへの通知が届くことを確かめる。
   1日後に、Cloud Monitoringの`run.googleapis.com/container/billable_instance_time`が大きく下がったことを確かめる。

6. 実行記録のTTL policyを設定する（[古い記録を消す](#古い記録を消すttl-policy)）。

### 定期処理の切り戻し

VMの定期処理に問題があるときは、まずVMの定期処理を止める。

```sh
mise run slack:socket:deploy -- --env AR_SCHEDULER=off --yes
```

この状態は次の`--env`なしの配備で元へ戻る。
続けて止めておくときは、`vm-overrides.conf`を`AR_SCHEDULER=off`にするPRを出す。

VMの定期処理を止めた後に、Cloud Schedulerを動かす。順序を逆にすると、その間は毎時ジョブが2回ずつ走る。

- 手順4より前（ジョブが一時停止のまま残っている）なら、再開する。

  ```sh
  for ar_job in ${ar_jobs}; do
    gcloud scheduler jobs resume "${ar_job}" --location "${ar_location}" --project bmarumado
  done
  ```

- 手順4の後（削除済み）なら、保存した定義から、同じ名前、schedule、本文、headerでジョブを作り直す。

`--cpu-throttling`のままでも、Cloud Schedulerから呼ばれた`/internal/*`は応答の前に処理を終えるので動く。
VMの定期処理とCloud Schedulerの両方を動かしたままにはしない。
同じ枠をprocess内で二重に実行することは無いが、HTTPの呼び出しは毎回実行されるので、Cloud Schedulerの回数だけ処理が増える。
VMの定期処理へ戻すときも、[移行手順](#移行手順)と同じく、先にCloud Schedulerを一時停止してから`AR_SCHEDULER=inprocess`で配備する。

Cloud RunのCPUを常時確保へ戻すときは次を実行する。

```sh
gcloud run services update arttra-work-slack --region asia-northeast1 --project bmarumado --no-cpu-throttling
```

## 切り戻し

前のimageへ戻すときは、digestを指定して配備する。

```sh
mise run slack:socket:deploy -- --image asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter@sha256:<digest> --yes
```

Socket Modeをやめて、Cloud RunのHTTP受信へ戻すときは次の順で行う。

1. Cloud Runのingressが`all`であることを確かめる。`internal`のままでは、Slackからの要求を受け付けない。
2. Cloud Runが`--cpu-throttling`なら、`--no-cpu-throttling`へ戻す。Slackの操作は受け付けの応答の後に処理を続けるため、要求時だけのCPUでは処理が止まる（[Cloud Runを要求時だけの課金にしてよいか](#cloud-runを要求時だけの課金にしてよいか)）。
3. Slack Appの設定画面で「Socket Mode」を無効にする。Slashコマンドとinteractivityの送り先が`AR_PUBLIC_BASE_URL/slack/events`であることを確かめる。
4. VMを止める。

   ```sh
   mise run slack:socket:stop -- --yes
   ```

5. VMを止めると定期処理も止まる。[定期処理の切り戻し](#定期処理の切り戻し)に従い、Cloud Schedulerのジョブを再開するか作り直す。VMを止めた後に行う。

## 障害時の確認先

- `mise run slack:socket:status`が`healthy: false`のとき：VMの状態と、Cloud Loggingの`resource.type="gce_instance"`のログを見る。
- secretを読めないとき：`arttra-work-slack-app-token`にENABLEDのversionがあるか、service accountに`secretmanager.secretAccessor`があるかを確かめる。
- imageを取得できないとき：service accountに`artifactregistry.reader`があるかを確かめる。
- Slack側で`/ar`が応答しないとき：Slack AppのSocket Modeが有効か、app-level tokenが失効していないかを確かめる。
