# Slack PR通知の保守手順

## 目的

この文書は、GitHub上のIssueとPRに起きた変更を、対応するSlackスレッドへ正しく投影できているか確認するための保守手順である。
Slackは正本ではなく、GitHub IssuesとGitHub Projectsを人間が追いやすくする投影先である。

## 本番構成

- GitHub Organization: `art-tra2021`
- GitHub App: `ART-TRA Work`（App ID `4460459`）
- GCP project: `bmarumado`
- Cloud Run service: `arttra-work-slack`（`asia-northeast1`）
- Slack workspace: `art-trahq`（team ID `T03T1GXHYH1`）
- 作業通知channel: `C0BK0RGD87J`

GitHub Webhookは`/github/events`で署名検証した後、Cloud Tasksを介して`/internal/github-events`へ渡す。
生のWebhook payloadをSlackへ転送してはならない。
workerはGitHubから最新状態を再取得し、日本語の要約と検証済みアカウントのnative mentionだけを投稿する。

## 必須イベント

次のイベントを購読する。

- `issues`
- `issue_comment`
- `pull_request`
- `pull_request_review`
- `pull_request_review_comment`
- `check_run`
- `check_suite`

GitHub App本体のWebhook設定が利用できない場合、対象repositoryへ同じURL、secret、イベントを持つ署名付きrepository webhookを設定してよい。
二重配信されてもdelivery IDとイベントfingerprintで重複投稿を防ぐ。
GitHub App本体へ復帰した後もrepository webhookを無断で削除せず、管理者が配信実績を確認して切替を判断する。

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
| マージ | Issue担当者 |
| Issue完了 | Issue担当者 |

実行者は通知先ではなく出来事の帰属表示なので、常にplainな`@github-login`で表示する。
native mentionは、確認や対応が必要なrecipientだけに付け、Issue作成、自己assignment、自己reviewer指定、自己コメントなどの実行者本人には付けない。
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
7. CI失敗を一度発生させ、primary Taskの親WorkまたはBusiness threadへ通知されることを確認する。
8. 通常のセルフマージ実行者では初回だけchannelへ展開され、`suppress_self_merge_channel_broadcast`のgrant対象者では初回からthread内だけになることを確認する。どちらも停止ボタンがあり、CI通過通知はthread内だけであることを確認する。
9. Intake、Work、Business、Taskの作成時に、担当者表示を含む最初の概要とは別の初期assignment返信がないことを確認する。その後のunassignmentと再assignmentは通知されることを確認する。
10. Task作成からPR完了までの通知が同じWorkまたはBusinessスレッドにあり、WorkまたはBusiness概要、Task概要、後続eventの順で、同じイベントの重複通知がないことを確認する。
11. GitHub Webhook delivery、Cloud Run log、Cloud Tasksの失敗件数を確認する。

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

## 本番deploy

必須CIが成功してmainへmergeされたcommitだけを本番へdeployする。
Apple SiliconなどARM環境からbuildする場合も、Cloud Run用imageは`linux/amd64`を明示する。

```sh
docker buildx build --platform linux/amd64 \
  --file apps/slack-adapter/Dockerfile \
  --tag asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:<merge-commit>-amd64 \
  --push .

gcloud run deploy arttra-work-slack \
  --image asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:<merge-commit>-amd64 \
  --update-env-vars='AR_GITHUB_CAPABILITY_GRANTS_JSON={"suppress_self_merge_channel_broadcast":["rozwer"]}' \
  --region asia-northeast1 \
  --project bmarumado \
  --platform managed
```

deploy後は`latestReadyRevisionName`、image、traffic 100%を確認し、`/health`が`{"ok":true,"schemaVersion":1}`を返すことを確認する。
旧revisionで作られたTask専用threadは履歴として残るため、deploy後に新しいTaskとPRでWork単位のE2E確認を行う。

## 障害時の切り分け

通知がない場合は、GitHub Webhook delivery、`/github/events`のHTTP応答、Cloud Tasks、worker log、Slack API応答の順に確認する。
同じ通知が複数届く場合は、GitHub delivery ID、`github-delivery` state、`lifecycle-notification` fingerprintを確認する。
別スレッドへ分かれた場合は、PR本文のclosing Task、そのTaskのnative parent、`work-thread` stateのWorkまたはBusiness URLを確認する。
メンションされない場合は、対象者がSlackからGitHub OAuth連携を完了しているか確認する。
