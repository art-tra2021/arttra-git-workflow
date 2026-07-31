# ART-TRA Git運用 v2

この文書はテストリポジトリで実証する正本です。
旧案と矛盾する場合は、実験結果が付いたこの版を優先します。

## 境界

GitHub Issuesは要求と作業の記録、GitHub Projectsは担当・状態・優先度・予定の正本です。
SlackとカレンダーはProjectsの入出力であり、独自の状態を持ちません。
コード、営業資料、契約条件、運用手順を含む変更成果はPRにします。
会話や思いつきを無理にPRへせず、まず`type/intake` Issueへ置きます。

Issueは次の単位に分けます。

| 種類 | 用途 | 単独PR |
| --- | --- | --- |
| Intake | 未整理の相談、営業情報、思いつき | 作らない |
| Work | 完了条件を持つ変更成果 | 原則1件 |
| Task | Workを分解した短い行動 | 原則作らない |
| Business | 文書・条件・業務フローの変更 | 1件 |

## マージ

Merge commitとrebase mergeは使わず、squash mergeへ統一します。
意味的に別々に残す必要がある変更は、commitを保存するためではなく、レビューと取り消しの境界を明確にするため別PRにします。

マージ方式はIssueのラベル一つで決めます。

- `merge/review`: 既定。PR作成者以外の承認が1件必要。
- `merge/self`: 小さな変更、PL判断、十分に自動検証できる変更。承認なしで本人がマージ可能。
- `merge/emergency`: `hotfix/` branch限定。即時マージ後に事後レビューIssueを自動作成。

GitHub Ruleset側の承認数は0にし、`policy` checkがこの差を機械判定します。
これにより、Rulesetを毎回バイパスせずIssue時点の明示的な判断を監査できます。

## 競合と滞留

`PR Health`は4時間ごとに次を更新します。

- 競合するPRへ`status/conflict`
- baseより遅れている、または3日更新がないPRへ`status/needs-update`
- 差分量に応じた`size/S`〜`size/XL`
- open PR同士で同じファイルを触っている組をworkflow summaryへ出力

未commitを含む手元の重複は`git ar presence`が担当します。
共有するのはファイルパス、状態、branch、時刻だけで、diffやコマンド本文は送りません。

## 人間とAI

人間は`git ar`のTUI、AIと自動化は同じ処理の引数とJSONを使います。
commitは`git ar commit`だけを入口にし、hookは`AR-Commit: git-ar/v1` trailerを確認します。
branch命名違反とツールチェーン違反は、安定したerror code、日本語説明、実行可能な修正コマンドを返します。

`git ar tasks --json`は認証済みユーザーのIssueを機械可読で返します。
人間は任意の`gh-dash`、AIはこのJSONを使い、表示層を正本にしません。
Project scopeがある環境では、将来同じ出力へProjectsの日程と状態を結合します。

Issueの親子、blocked-by、blockingはGitHub CLI 2.94以降のnative relationshipを使います。
本文の自由記述から依存を推測せず、`git ar issue --blocked-by`またはcore `gh issue create/edit`で登録します。
TUIでは任意の詳細設定、AIでは`--parent`、`--blocked-by`、`--blocking`を使います。

## 段階導入

1. テンプレート、mise、hooks、CI、警告を導入する。
2. `git ar`を通常経路にし、ローカル規則をblockへ上げる。
3. Rulesetをテストリポでactiveにし、`verify`と`policy`を必須にする。
4. Rule Insightsとtelemetryを週次で見て、誤検知と回避行動を修正する。
5. 組織Custom Propertiesで対象リポジトリを選び、段階的に横展開する。

GitHubの`evaluate` RulesetはEnterprise機能なので、現在のプランでは使いません。
テストリポではactive rulesetを使い、管理者bypassを非常口として残します。
