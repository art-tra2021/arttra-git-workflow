# Slack PR通知の保守手順

## 目的

この文書は、GitHub上のIssueとPRに起きた変更を、対応するSlackスレッドへ正しく投影できているか確認するための保守手順である。
Slackは正本ではなく、GitHub IssuesとGitHub Projectsを人間が追いやすくする投影先である。

## 本番構成

- GitHub Organization: `art-tra2021`
- active ingress: Organization webhook（hook ID `660129617`）
- inactive ingress: repository webhook（hook ID `660198095`）
- GitHub App: `ART-TRA Work`（App ID `4460459`、default eventsは空、App hookなし）
- GCP project: `bmarumado`
- Cloud Run service: `arttra-work-slack`（`asia-northeast1`）
- Slack workspace: `art-trahq`（team ID `T03T1GXHYH1`）
- 作業通知channel: `C0BK0RGD87J`

対応必須DMにはBot tokenの`im:write`が必要であり、DM outboxの照合には`im:history`が必要である。
manifest変更後はSlack Appを再インストールし、既存の`channels:history`と`groups:history`を含む4 scopeをread-backしてから本番へ反映する。

本番のGitHubイベントは、Organization webhook `660129617`だけが`/github/events`へ配信する。
`/github/events`は署名を検証した後、Cloud Tasksを介して`/internal/github-events`へ渡す。
生のWebhook payloadをSlackへ転送してはならない。
workerはGitHubから最新状態を再取得し、日本語の要約と検証済みアカウントのnative mentionだけを投稿する。

## 必須イベント

Organization webhook `660129617`は、次の8イベントを購読する。

- `check_run`
- `check_suite`
- `issues`
- `issue_comment`
- `projects_v2_item`
- `pull_request`
- `pull_request_review`
- `pull_request_review_comment`

repository webhook `660198095`はinactiveのまま維持する。
GitHub Appのdefault eventsを空とし、App hookを作成しない状態も維持する。
これらはOrganization webhookとの重複配信を防ぐための意図的な状態であり、障害と判定しない。
GitHub AppはAPI認証に利用するが、Webhook ingressとしては利用しない。
ingressを切り替える場合は、変更前後のdeliveryを確認し、同時にactiveとなる経路が一つだけになる手順を別途定める。

## Webhook ingressの確認

本番構成をread-backするときは、GitHub OrganizationのWebhooks設定でhook ID `660129617`を開き、activeであることと必須8イベントを確認する。
次にrepositoryのWebhooks設定でhook ID `660198095`がinactiveであることを確認する。
GitHub Appの設定ではdefault eventsが空であり、App hookが存在しないことを確認する。
後者二つをactiveに変更して確認してはならない。

署名と受理結果は、Organization webhook `660129617`のRecent Deliveriesで次の順に確認する。

1. 対象deliveryのrequest headerに`X-GitHub-Delivery`、`X-GitHub-Event`、`X-Hub-Signature-256: sha256=...`があることを確認する。
2. `X-GitHub-Event`が必須8イベントのいずれかであることを確認する。
3. response codeが`202`であり、response bodyの`ok`が`true`、`queued`がboolean、`schemaVersion`が`1`であることを確認する。
4. `queued: true`ならCloud Tasksへの新規投入、`queued: false`なら同じdelivery IDの重複排除が働いた結果として扱う。
5. Cloud Run logで同じdelivery IDの署名エラーがなく、`queued`の値とCloud Tasksの状態が一致することを確認する。

受信処理はraw bodyとWebhook secretからHMAC-SHA256を計算し、`X-Hub-Signature-256`と定数時間で比較する。
署名が一致しない場合は`401 invalid_signature`となるため、`202`として受理してはならない。
headerまたはJSONが不正な場合は`400`、Cloud Tasksへ投入できない場合は`503 queue_unavailable`となる。
確認時にWebhook secretやpayload本文をIssue、PR、Slackへ転記してはならない。

## スレッド規則

PRはGitHubが`Closes`から解決したprimary closing Taskをちょうど1件持つことを必須とする。通知本文と重複排除にはTask URLを使い、Slackのthread keyにはTaskのnative parentであるWorkまたはBusiness URLを使う。
`Closes`はPRが直接完了させるTaskを示す完了リンクであり、Issue同士の親子関係や依存関係ではない。
`Relates to`や本文中の単なる`#123`は通知先にしない。
primary closing Taskが0件、複数件、または`type/task`でないPRは、PR単位のchannel直下投稿へfallbackせず、policy違反として修正する。
WorkまたはBusinessだけが実行単位のSlack親投稿を持つ。Task作成と配下のPR、review、CI、comment、期限、blockerは同じ親threadへ集約し、Task単位の親投稿を作らない。

Task作成eventより先にコメントやPR eventが届いた場合も、親WorkまたはBusinessの概要、Task概要、続報の順に返信する。
PR作成・レビュー依頼の経路もLifecycle通知と同じTask概要intentを使い、Outboxで一度だけ送る。
複数workerが同時に最初のeventを処理しても親投稿は一つだけ作り、root作成中の処理は平投稿せず再試行する。
親がない、親種別が不正、または共有channelのrepository scope外であるTaskはchannel直下へfallbackしない。
通知subjectとdedupe keyはTaskのまま維持し、同じWork配下の複数Taskを衝突させない。
Issue作成時点の担当者は最初のIssue概要に含め、初期`assigned` eventは独立返信にしない。
初期担当者はIssueごとの永続stateで一度だけ消費する。
処理時刻やキュー遅延では判定せず、作成後の`unassigned`と再assignmentは通常どおり通知する。

| GitHub上の出来事 | 通知対象 |
| --- | --- |
| Intake、Work、Businessの最初の親投稿 | Issue作成の実行者本人を除いたIssue担当者 |
| Task作成 | 親WorkまたはBusinessのthreadで、実行者本人を除いたTask担当者 |
| PR作成・レビュー依頼 | 指定reviewerとIssue担当者 |
| Issueコメント | Issue担当者と本文で明示されたGitHubユーザー |
| PR会話コメント・コードコメント | PR作成者と本文で明示されたGitHubユーザー |
| 差し戻し | PR作成者 |
| 差し戻し後の修正push | 差し戻したreviewer |
| 承認 | PR作成者 |
| CI失敗・timeout・cancel・要操作 | PR作成者とIssue担当者 |
| PR Policyが`AR-PR-004`だけでreviewer指定済み | 追加通知なし（既存のレビュー依頼へ一本化） |
| PR Policyが`AR-PR-004`だけでreviewer未指定 | PR作成者へreviewer指定を一度依頼 |
| マージ | Issue担当者 |
| Issue完了 | Issue担当者 |

対応必須DMの対象は、個人reviewerへのレビュー依頼、reviewer未指定の承認待ち、通常のCI失敗、`BLOCKED`、`OVERDUE`の5区分である。
レビュー依頼では個人reviewerだけをDM対象とし、Issue担当者とGitHub team reviewerは対象にしない。
差し戻し、conflict、期限接近、期限当日、情報通知、成功通知はDMへ転送しない。
DMは実行者本人を除外し、channel通知intentとrecipient Slack user IDから別のoutbox intentを作るため、Webhook再送で増えない。
DM失敗時も既存のchannelまたはthread通知は残り、DM intentだけが監査と確認付き再送の対象になる。
この変更では既存のchannelまたはthread投稿の件数を変えない。
channelまたはthread側の通知削減はIssue #159へ分離し、会議の決定記録が付くまで実装しない。

実行者は通知先ではなく出来事の帰属表示なので、常にplainな`@github-login`で表示する。
native mentionは、確認や対応が必要なrecipientだけに付け、Issue作成、自己assignment、自己reviewer指定、自己コメントなどの実行者本人には付けない。
PR PolicyはGitHub Actionsのerror annotationへ`AR-PR-*` codeを出し、Slack adapterはChecks read APIで失敗runのannotationを再取得する。
失敗runのすべてを`AR-PR-004`だけで説明できる場合に限り承認待ちとして扱い、annotationを取得できない場合、別codeがある場合、codeのない失敗runが混在する場合は通常のCI失敗通知を維持する。
Issueの表示はIntake、Work、Task、Businessごとに見出し、説明、次の操作を変えるが、Taskは親WorkまたはBusinessのthread返信として表示する。
セルフマージ対象になった最初の警告だけはWorkまたはBusiness threadへのTask返信をchannelにも展開し、停止機会を作る。
ただし`AR_GITHUB_CAPABILITY_GRANTS_JSON`で`suppress_self_merge_channel_broadcast`を明示grantされたGitHub利用者は、初回警告も親WorkまたはBusiness thread内だけに留める。
この権限はrepositoryのadmin権限やセルフマージ権限から暗黙付与せず、WorkまたはBusiness thread内のTask警告と停止ボタンは権限の有無にかかわらず残す。
CI通過後のセルフマージ実行可能通知は同じthread内だけに置き、channelを二度通知しない。

GitHubログインとSlack user IDの対応は、本人が完了したGitHub OAuthだけを正とする。
表示名やメールアドレスから対応を推測してはならない。
未連携者が担当者または予定reviewerに選択された場合は、そのSlack user IDをnative mentionし、`🧩 GitHub連携が必要です`と`/ar connect github`を案内する。
同じ連携要求は24時間に一度までとする。

## 視覚ルール

すべてのSlackメッセージは、独立したHeader Blockに絵文字と短い日本語見出しを表示する。
Header Blockの後には区切り線を置き、詳細と「次の操作」を分離する。
fallback textにも同じ絵文字と見出しを含めるが、本文中の装飾だけで視認性を担保してはならない。

| 種類 | 先頭表示 |
| --- | --- |
| レビュー依頼 | `👀` |
| コメント | `💬` |
| 差し戻し・注意 | `⚠️` |
| 承認・成功 | `✅` |
| 修正push | `🛠️` |
| マージ | `🎉` |
| Issue完了 | `🏁` |
| 期限 | `⏰` |
| 作業状況 | `🚧` |
| 必要な本人操作 | `🧩` |
| エラー | `🚨` |

## E2E確認

1. 検証用Workと、その子に`merge/self`を付けたTaskを作り、Taskへ担当者と予定reviewerを設定する。
2. Taskだけを`Closes #<Task番号>`で閉じ、親Workはnative parentの完全なIssue URLを`Relates to https://github.com/owner/repo/issues/<Work番号>`で参照するPRを作る。
3. SlackのWork親投稿で作成の実行者本人はmentionされず、Task作成がそのthread内にあること、レビュー依頼でPR作成者本人を除いた予定reviewerだけがnative mentionされていることを確認する。
4. Issueコメント、PR会話コメント、レビューコメントを一つずつ追加する。
5. 差し戻し、修正push、承認の順に実施する。
6. PRをsquash mergeし、Issueを完了させる。
7. CI失敗を一度発生させ、primary Taskの親WorkまたはBusiness threadへ通知されることを確認する。続けて`AR-PR-004`だけの失敗を発生させ、reviewer指定済みでは追加mentionがなく、未指定ではPR作成者へのreviewer指定依頼が一度だけ届くことを確認する。
8. 通常のセルフマージ実行者では初回だけchannelへ展開され、`suppress_self_merge_channel_broadcast`のgrant対象者では初回からthread内だけになることを確認する。どちらも停止ボタンがあり、CI通過通知はthread内だけであることを確認する。
9. Intake、Work、Business、Taskの作成時に、担当者表示を含む最初の概要とは別の初期assignment返信がないことを確認する。その後のunassignmentと再assignmentは通知されることを確認する。
10. Task作成からPR完了までの通知が同じWorkまたはBusinessスレッドにあり、WorkまたはBusiness概要、Task概要、後続eventの順で、同じイベントの重複通知がないことを確認する。
11. 個人reviewerへのレビュー依頼、reviewer未指定の承認待ち、通常のCI失敗、`BLOCKED`、`OVERDUE`で、対処者本人のDMが一件あり、同じeventの再配信では増えないことを確認する。実行者本人だけがrecipientの場合はDMが0件であることも確認する。差し戻し、conflict、期限接近、期限当日はDMが0件であることを確認する。
12. DM送信を一度失敗させ、既存のchannelまたはthread通知が一件残り、DM intentだけをoutboxの監査・照合・確認付き再送で復旧できることを確認する。
13. Organization webhook `660129617`のdeliveryが`202`であること、Cloud Run log、Cloud Tasksの失敗件数を確認する。

Slack APIでも、WorkまたはBusiness親投稿は`ts == thread_ts`、Task作成・PR作成・レビュー依頼は`thread_ts == WorkまたはBusiness親投稿のts`かつ`ts != thread_ts`であることを確認する。
Task作成またはPR作成・レビュー依頼が`ts == thread_ts`なら平投稿が再発しているため、合格にしてはならない。

検証用Issue、PR、Slackメッセージは監査証跡として残す。
失敗時も削除せず、原因と再試験結果をIssueへ追記する。

### 2026-08-04の本番E2E証跡

Cloud Run revision `arttra-work-slack-00048-xv7`で、Work [#111](https://github.com/art-tra2021/arttra-git-workflow/issues/111)とTask [#113](https://github.com/art-tra2021/arttra-git-workflow/issues/113)を使って確認した。
作業通知channelは`C0BK0RGD87J`、Work親投稿のtsは`1785819495.573869`である。

Task作成時に届いたメッセージは次の2件である。

| 順序 | 通知 | message ts | thread_ts | native mention | channelへの展開 |
| --- | --- | --- | --- | --- | --- |
| 1 | Task概要 | `1785820794.713059` | `1785819495.573869` | なし | なし |
| 2 | セルフマージ警告 | `1785820795.549839` | `1785819495.573869` | なし | なし |

Task #113に対する独立したassignment変更通知はなく、Task概要とセルフマージ警告の順序も維持された。
セルフマージ警告がchannelへ展開されないのは、`rozwer`に`suppress_self_merge_channel_broadcast`を明示grantしているためである。

Task #113をcloseするPR [#114](https://github.com/art-tra2021/arttra-git-workflow/pull/114)の作成通知は、message ts `1785820889.371709`、thread_ts `1785819495.573869`である。
この通知にもnative mentionとchannelへの展開はなく、PR作成後もTask #113の概要は重複せず2件のままだった。

### 2026-08-05の最新revision E2E証跡

Work [#111](https://github.com/art-tra2021/arttra-git-workflow/issues/111)とTask [#150](https://github.com/art-tra2021/arttra-git-workflow/issues/150)を使い、Cloud Run revision `arttra-work-slack-00051-dps`で初回確認した後、重複を修正した`arttra-work-slack-00052-t2v`で再確認する。
確認した通知は次のとおりである。

| revision | 通知 | message ts | thread_ts | native mention | channelへの展開 |
| --- | --- | --- | --- | --- | --- |
| `00051-dps` | Task概要 | `1785897342.161759` | `1785819495.573869` | なし | なし |
| `00051-dps` | セルフマージ警告 | `1785897347.427449` | `1785819495.573869` | なし | なし |
| `00051-dps` | PR作成 | `1785897469.673109` | `1785819495.573869` | なし | なし |
| `00051-dps` | 制御したPolicy失敗（汎用Work通知） | `1785897473.798139` | `1785819495.573869` | 実行者へ1回 | なし |
| `00051-dps` | 制御したPolicy失敗（PR lifecycle通知） | `1785897491.737409` | `1785819495.573869` | 実行者へ1回 | なし |
| `00052-t2v` | 修正後のPolicy失敗 | `1785898677.951519` | `1785819495.573869` | 実行者へ1回 | なし |
| `00052-t2v` | 修正後の必須check成功 | `1785898862.531469` | `1785819495.573869` | 実行者へ1回 | なし |

PR [#151](https://github.com/art-tra2021/arttra-git-workflow/pull/151)では、親Workを短縮表記した本文をPolicyで`AR-PR-010`として意図的にfail-closedにした。
初回は同じ失敗に対して汎用Work通知とPR lifecycle通知が1通ずつ届いたため、Task [#152](https://github.com/art-tra2021/arttra-git-workflow/issues/152)とPR [#153](https://github.com/art-tra2021/arttra-git-workflow/pull/153)で`CHECKS_FAILED`の即時通知をPR lifecycleへ一本化した。
commit `5b13f19f95d7e88c00c8467e91bc461ecdca6b64`を`00052-t2v`へdeployし、PR #151の新しいheadで同じPolicy失敗を再現すると、対応必須mentionは1通だけになった。
完全な親Issue URLへ戻して全必須checkを成功させると、セルフマージ可能通知も1通だけ届いた。
Task作成から再確認までchannel rootは増えず、すべて既存Work threadに集約された。

## 本番deploy

必須CIが成功してmainへmergeされたcommitだけを本番へdeployする。
Apple SiliconなどARM環境からbuildする場合も、Cloud Run用imageは`linux/amd64`を明示する。
以下の`<merge-commit>`は省略形ではなく40文字の小文字SHAである。

```sh
docker buildx build --platform linux/amd64 \
  --file apps/slack-adapter/Dockerfile \
  --build-arg AR_BUILD_REVISION=<merge-commit> \
  --tag asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:<merge-commit>-amd64 \
  --push .
```

imageをpushしてもCloud Runは変更されない。
次に対象commitが現在のGitHub mainと一致すること、対象imageのOCI indexに`linux/amd64` manifestがちょうど1件あること、そのdigest、現在配信中のrevision・image digest・health commit、変更点をJSONで確認する。

```sh
mise run slack:release:preview -- --commit <merge-commit>
```

previewは`docker buildx imagetools inspect`で対象tagをread-onlyに検査し、`target.digest`へ`linux/amd64` manifest digest、`target.deployImage`へdigest固定のimage参照を出力する。
attestation manifestの`unknown/unknown` platformを実行imageとして扱ってはならない。
`linux/amd64` manifestがない、または複数ある場合はpreviewを失敗させ、deployしない。
preview自体はread-onlyでありCloud Runを変更しない。
内容を確認した操作者だけが、同じ完全SHAと`--yes`を明示してdeployする。
`--yes`がなければscriptはpreviewを表示した後に停止する。

```sh
mise run slack:release:deploy -- --commit <merge-commit> --yes
```

deploy scriptはpreviewで確定した`linux/amd64` digestを`--image`へ渡すため、previewとdeployの間にtagが移動しても別imageをdeployしない。
既存の環境変数とsecret設定を維持してimageを更新し、Cloud Run revision labelにも同じcommitを記録してからread-backを実行する。
read-backはtraffic 100%のrevisionをCloud Runから引き直す。
Cloud Run revision APIの`status.imageDigest`または`spec.containers[0].image`はtagではなく`@sha256:...`形式で返るため、そのdigestをpreviewで確定した対象digestと比較する。
同時にrevision label、`/health`の`commit`、現在のGitHub mainを比較する。
一致すればexit 0となる。
対象tagを解決できない場合は`targetImageMetadataMissing`、配信revisionからdigestを取得できない場合は`imageMetadataMissing`、対象と配信digestが一致しない場合は`imageVsTarget`を含むdriftをJSONで示してexit 2となる。
main、revision label、配信revisionの不一致も同じくexit 2である。

いつでも次のread-only確認を実行できる。

```sh
mise run slack:release:status
```

deploy後はこのstatusがdriftなしであることを確認する。
旧revisionで作られたTask専用threadは履歴として残るため、deploy後に新しいTaskとPRでWork単位のE2E確認を行う。

### rollback

自動rollbackは行わない。
Cloud Runに残っている戻し先revisionと、そのrevisionが参照するdigest形式のimage、revision labelのcommitをpreviewで確認し、操作者がrevision名と`--yes`を明示した場合だけtrafficを100%切り替える。

```sh
mise run slack:release:rollback -- --revision arttra-work-slack-00047-abc
mise run slack:release:rollback -- --revision arttra-work-slack-00047-abc --yes
```

1行目はrollback planを表示して停止する。
2行目だけがtrafficを変更し、変更後に同じdigest read-backを行う。
旧revisionのcommitは現在のmainと異なるため、意図したrollback後のstatusはdriftを検出してexit 2となる。
Issueと障害記録へrollback理由、対象revision、image、health commit、復旧判断を残す。

## 障害時の切り分け

通知がない場合は、GitHub Webhook delivery、`/github/events`のHTTP応答、Cloud Tasks、worker log、Slack API応答の順に確認する。
同じ通知が複数届く場合は、GitHub delivery ID、`github-delivery` state、`lifecycle-notification` fingerprintを確認する。
別スレッドへ分かれた場合は、PR本文のclosing Task、そのTaskのnative parent、`work-thread` stateのWorkまたはBusiness URLを確認する。
メンションされない場合は、対象者がSlackからGitHub OAuth連携を完了しているか確認する。
