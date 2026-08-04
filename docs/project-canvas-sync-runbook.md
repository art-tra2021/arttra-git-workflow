# 個人Canvas定期同期runbook

## 対象と境界

GitHub Projectsを正本とし、利用者が`/ar canvas`で既に作成した本人専用Slack Canvasだけを15分ごとに更新する。

- endpointは`POST /internal/project-canvas-sync`である。
- command本文は固定JSON `{"schemaVersion":1,"kind":"project-canvas.sync"}`である。
- `X-Ar-Job-Signature`は本文を`AR_JOB_SECRET`でHMAC-SHA256署名した値であり、他のinternal jobと同じ検証を通る。
- 保存済みbindingのうち、現在のSlack teamに属し、`viewerId`とtarget userが一致するpersonal Canvasだけを対象にする。
- 定期処理からCanvasを新規作成しない。channel Canvas、共有先、read ACLを追加しない。
- Notion本文は同期しない。

## 同期結果

serviceは既存stateをstate key順に列挙し、手動の`/ar canvas`と同じ経路でGitHub identityとrepository accessを再検証する。
repository accessまたはGitHub連携を失った利用者には、個人List／Canvasの既存失効処理を適用する。
Project表示のhashとACLが保存済みstateから変わらなければ、`canvases.edit`と`canvases.access.set`を呼ばない。

応答の`results`はstate key順であり、各bindingを次のいずれかとして返す。

| status | 意味 |
| --- | --- |
| `success` | 既存Canvasを更新した |
| `unchanged` | 内容とACLが同じためSlackへの書換えを行わなかった |
| `skipped` | channel binding、別team、access喪失、列挙後に失効したstateなど、同期対象外になった |
| `error` | 一時競合または外部API失敗で同期できなかった |

lease競合など明示的に再試行可能な失敗がある場合は、`Retry-After: 5`、HTTP 429、`retryable: true`を返す。
その他の処理失敗はHTTP 500とし、成功・unchanged・skippedだけならHTTP 200を返す。

## deploy後の設定と確認

Cloud Scheduler jobはmainへのmergeとCloud Run deployが完了してから作成する。
scheduleは`*/15 * * * *`、timezoneは`Asia/Tokyo`とし、固定本文と署名headerを設定する。
Job secretをrotationした場合は固定本文の署名headerも更新する。

作成前に対象をread-backし、既存の本人専用Canvas binding以外が含まれないことを確認する。
作成後は次を順に確認する。

1. 手動実行のHTTP応答が署名付きcommandを受理し、対象Canvasを`success`または`unchanged`として返す。
2. Firestoreの`project-canvas` stateにある`contentHash`と更新時刻が実行結果に一致する。
3. 同じProject状態でもう一度実行すると`unchanged`になり、Slack Canvasの内容とACLが書き換わらない。
4. channel bindingや別team bindingがあれば`skipped`になり、新しいCanvasや共有先が作られない。
5. Cloud Schedulerの直近実行が成功し、Cloud Run logにsecretや署名前本文が出ていない。

失敗時はSchedulerのHTTP status、Cloud Run log、bindingの`reasonCode`、GitHub identity、repository access、Canvas stateの順に確認する。
