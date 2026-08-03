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

PRはGitHubが`Closes`から解決したprimary closing Taskをちょうど1件持つことを必須とし、そのTask URLだけをthread keyとする。
`Closes`はPRが直接完了させるTaskを示す完了リンクであり、Issue同士の親子関係や依存関係ではない。
`Relates to`や本文中の単なる`#123`は通知先にしない。
primary closing Taskが0件、複数件、または`type/task`でないPRは、PR単位のchannel直下投稿へfallbackせず、policy違反として修正する。
親WorkまたはBusinessとTaskはそれぞれ独立したSlack親投稿を持ち、PRの会話を親Work側へ混ぜない。

Issue作成eventより先にコメントやPR eventが届いた場合も、Issue種別に応じた概要を親投稿として作成してから続報を返信する。
複数workerが同時に最初のeventを処理しても親投稿は一つだけ作り、root作成中の処理は平投稿せず再試行する。
同じIssueに対する次の通知は、同一の親投稿への返信に集約する。

| GitHub上の出来事 | 通知対象 |
| --- | --- |
| Issueの最初の親投稿 | Issue作成者とIssue担当者 |
| PR作成・レビュー依頼 | 指定reviewerとIssue担当者 |
| Issueコメント | Issue担当者と本文で明示されたGitHubユーザー |
| PR会話コメント・コードコメント | PR作成者と本文で明示されたGitHubユーザー |
| 差し戻し | PR作成者 |
| 差し戻し後の修正push | 差し戻したreviewer |
| 承認 | PR作成者 |
| CI失敗・timeout・cancel・要操作 | PR作成者とIssue担当者 |
| マージ | Issue担当者 |
| Issue完了 | Issue担当者 |

実行者に検証済みSlack identityがある場合、`@github-login`という文字列ではなくnative mentionで表示する。
Issueの親投稿はIntake、Work、Task、Businessごとに見出し、説明、次の操作を変える。
セルフマージ対象になった最初の警告だけはIssue threadへの返信をchannelにも展開し、停止機会を作る。
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
3. SlackのIssue親投稿でIssue作成者と担当者がnative mentionされ、レビュー依頼の返信で予定reviewerがnative mentionされていることを確認する。
4. Issueコメント、PR会話コメント、レビューコメントを一つずつ追加する。
5. 差し戻し、修正push、承認の順に実施する。
6. PRをsquash mergeし、Issueを完了させる。
7. CI失敗を一度発生させ、primary Issue threadへ通知されることを確認する。
8. セルフマージ予定の初回だけchannelへ展開され、CI通過通知はthread内だけであることを確認する。
9. すべての通知が同じIssueスレッドにあり、同じイベントの重複通知がないことを確認する。
10. GitHub Webhook delivery、Cloud Run log、Cloud Tasksの失敗件数を確認する。

Slack APIでも、新しいTaskの親投稿は`ts == thread_ts`、PR作成・レビュー依頼は`thread_ts == Task親投稿のts`かつ`ts != thread_ts`であることを確認する。
PR作成・レビュー依頼が`ts == thread_ts`ならPR専用の平投稿が再発しているため、合格にしてはならない。

検証用Issue、PR、Slackメッセージは監査証跡として残す。
失敗時も削除せず、原因と再試験結果をIssueへ追記する。

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
  --region asia-northeast1 \
  --project bmarumado \
  --platform managed
```

deploy後は`latestReadyRevisionName`、image、traffic 100%を確認し、`/health`が`{"ok":true,"schemaVersion":1}`を返すことを確認する。
旧revisionのeventで作られたPR専用threadは履歴として残るため、deploy後に新しいTaskとPRでE2E確認する。

## 障害時の切り分け

通知がない場合は、GitHub Webhook delivery、`/github/events`のHTTP応答、Cloud Tasks、worker log、Slack API応答の順に確認する。
同じ通知が複数届く場合は、GitHub delivery ID、`github-delivery` state、`lifecycle-notification` fingerprintを確認する。
別スレッドへ分かれた場合は、PR本文のIssue参照と`work-thread` stateのIssue URLを確認する。
メンションされない場合は、対象者がSlackからGitHub OAuth連携を完了しているか確認する。
