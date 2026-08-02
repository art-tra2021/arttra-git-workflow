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

関連IssueがあるPRはIssue URLをthread keyとする。
関連IssueがないPRだけはPR URLをthread keyとする。
同じIssueに対する次の通知は、同一の親投稿への返信に集約する。

| GitHub上の出来事 | 通知対象 |
| --- | --- |
| PR作成・レビュー依頼 | reviewerとPR作成者以外のIssue担当者 |
| Issueコメント | Issue担当者と本文で明示されたGitHubユーザー |
| PR会話コメント・コードコメント | PR作成者と本文で明示されたGitHubユーザー |
| 差し戻し | PR作成者 |
| 差し戻し後の修正push | 差し戻したreviewer |
| 承認 | PR作成者 |
| マージ | Issue担当者 |
| Issue完了 | Issue担当者 |

GitHubログインとSlack user IDの対応は、本人が完了したGitHub OAuthだけを正とする。
表示名やメールアドレスから対応を推測してはならない。
未連携者が担当者または予定reviewerに選択された場合は、そのSlack user IDをnative mentionし、`🧩 GitHub連携が必要です`と`/ar connect github`を案内する。
同じ連携要求は24時間に一度までとする。

## 視覚ルール

すべてのSlackメッセージは絵文字と短い日本語見出しから始める。

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

1. `merge/self`を付けた検証用Issueを作り、担当者と予定reviewerを設定する。
2. `Closes #<Issue番号>`を含むPRを作る。
3. Slackの親投稿で予定reviewerがnative mentionされていることを確認する。
4. Issueコメント、PR会話コメント、レビューコメントを一つずつ追加する。
5. 差し戻し、修正push、承認の順に実施する。
6. PRをsquash mergeし、Issueを完了させる。
7. すべての通知が同じIssueスレッドにあり、同じイベントの重複通知がないことを確認する。
8. GitHub Webhook delivery、Cloud Run log、Cloud Tasksの失敗件数を確認する。

検証用Issue、PR、Slackメッセージは監査証跡として残す。
失敗時も削除せず、原因と再試験結果をIssueへ追記する。

## 障害時の切り分け

通知がない場合は、GitHub Webhook delivery、`/github/events`のHTTP応答、Cloud Tasks、worker log、Slack API応答の順に確認する。
同じ通知が複数届く場合は、GitHub delivery ID、`github-delivery` state、`lifecycle-notification` fingerprintを確認する。
別スレッドへ分かれた場合は、PR本文のIssue参照と`work-thread` stateのIssue URLを確認する。
メンションされない場合は、対象者がSlackからGitHub OAuth連携を完了しているか確認する。
