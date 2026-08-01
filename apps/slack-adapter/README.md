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

`AR_SLACK_APPROVER_IDS`には、`merge/self`または`merge/emergency`を許可できるSlack user IDをカンマ区切りで設定する。
申請者本人による承認を許すPL等は、`AR_SLACK_SELF_APPROVER_IDS`にも明示する。
通常レビューのIssueは即時作成し、権限昇格を伴うIssueだけをSlackの承認ボタンへ送る。

テスト基盤では承認待ちをプロセス内に保持する。
adapter再起動後の申請は安全のため失効するため、本番化時は`PendingIssueApproval`を永続ストアへ差し替える。

依存管理とtestにはBunを使い、Socket Modeの実行にはmise管理のNode.jsを使う。
テスト時のGitHub操作には認証済みの`gh`を使う。本番では同じdependency interfaceをGitHub App実装へ差し替える。
`/ar new`はrepositoryを選択した後、そのrepositoryの`.github/ISSUE_TEMPLATE/*.yml`を読み、実際のfieldからmodalを生成する。
