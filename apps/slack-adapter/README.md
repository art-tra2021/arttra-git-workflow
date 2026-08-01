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
