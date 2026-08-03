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
| Work | 開発成果と複数Taskの完了を管理する | 作らない |
| Task | 1件のPRで完了できる実装・変更単位 | 1件 |
| Business | 業務成果と複数Taskの完了を管理する | 作らない |

親Issueは、単に全項目を集める箱ではなく、完了を判定できる成果単位にします。
Intakeは解析・整理してWorkまたはBusinessへ分解した時点で役目を終え、実装Issueを永続的に抱える親にはしません。
階層は`Intake → Work / Business → Task → PR`へ固定します。Intakeは親を持たず、Work / Businessは親Intake、Taskは親Work / Businessを必須とし、Work / Businessを最上位にはしません。
repositoryをまたぐ親は`owner/repo#番号`またはGitHub Issue URLで指定します。
Workの直下は10件程度を目安とし、20件を超えそうならIntake配下の複数Workなど、成果別の単位へ再編するかを確認します。
件数はvalidatorで拒否する条件ではなく、分割を見直す運用上のシグナルです。
TaskはWorkまたはBusinessの子となる末端作業で、さらに子Issueを持たせません。

PRは本文の`Closes #<Issue番号>`で、1件のPRで完了できるTaskをちょうど1件だけ閉じます。
Intake、Work、Businessや複数Issueをprimary closing Taskにせず、Taskのnative parentは`Relates to https://github.com/owner/repo/issues/<番号>`で参照します。
branch名のTask番号、`git ar pr --issue`、`Closes`のTask番号はすべて同じにします。
これにより、100件規模の活動を一つの親IssueやSlackスレッドへ集中させません。
`Closes`はPRとIssueの完了リンクであり、Issue同士の`parent / sub-issue`や`blocked-by / blocking`には変換しません。

## マージ

Merge commitとrebase mergeは使わず、squash mergeへ統一します。
意味的に別々に残す必要がある変更は、commitを保存するためではなく、レビューと取り消しの境界を明確にするため別PRにします。

マージ方式はPRが`Closes`するTaskのラベル一つで決めます。

- `merge/review`: 既定。PR作成者以外の承認が1件必要。
- `merge/self`: 小さな変更、PL判断、十分に自動検証できる変更。承認なしで本人がマージ可能。
- `merge/emergency`: `hotfix/` branch限定。即時マージ後に事後レビューIssueを自動作成し、翌営業日までに確認。

GitHub Ruleset側の承認数は0にし、`policy` checkがこの差を機械判定します。
これにより、Rulesetを毎回バイパスせずTask作成時点の明示的な判断を監査できます。

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
日常作業の入口は`git ar status`とし、Issueの目的・完了条件・blocked-by、PR、check、ローカル変更から次の行動を確認します。
AIは同じ判定を`git ar status --json`で取得します。
commitは`git ar commit`だけを入口にし、hookは`AR-Commit: git-ar/v1` trailerを確認します。
branch命名違反とツールチェーン違反は、安定したerror code、日本語説明、実行可能な修正コマンドを返します。

`git ar tasks --json`は`arttra.toml`で指定したOrganization Projectを正本とし、認証済みユーザーが担当する未完了Issueをrepository横断で返します。
人間は任意の`gh-dash`、AIはこのJSONを使い、表示層を正本にしません。
状態、優先度、目標日、repository、Issue URLは人間向け表示とschema version付きJSONの同じ項目から生成します。

Issueの親子、blocked-by、blockingはGitHub CLI 2.94以降のnative relationshipを使います。
本文の自由記述から依存を推測せず、`git ar issue --blocked-by`またはcore `gh issue create/edit`で登録します。
TUIと非対話CLIは同じ階層validatorを使います。AIでは`--parent <番号|owner/repo#番号|Issue URL>`、`--blocked-by`、`--blocking`を使います。

## Slackから見るProject

GitHub Projectsを正本とし、Slack ListとCanvasは閲覧用の投影として扱います。
Slack側の行や本文を直接編集してProjectの状態を変える運用は行いません。

投影範囲は、単一repositoryを示す`repo`と、利用者本人が参照できるrepositoryの集合を示す`all-accessible`に分けます。
GitHub Appが参照できるrepository一覧を、そのままSlack利用者へ表示してはいけません。
Slack利用者と連携したGitHub loginのeffective permissionを確認し、確認できないrepositoryは候補と投影から除外します。

`all-accessible`は閲覧者によって内容が異なるため、共有channelのListまたはCanvasへ投影しません。
本人だけにread権限を与えた個人用の投影を作ります。
repository別の共有投影は、管理者がSlack channelとrepositoryの対応およびchannel参加者を管理する場合だけ有効にします。

共有投影の手動CLI、定期HTTP同期、Webhook同期は同じ固定channel／単一repository bindingを検証します。
scope導入前の共有Listは、channel accessと既存行を除去してから旧表示へ移し、private項目を残しません。

Slack利用者が別のGitHubアカウントへ再連携する場合は、新しいidentityを有効にする前に旧identity用の個人List／Canvas accessを失効させます。

人間はSlackで次のコマンドを使います。

```text
/ar project repo art-tra2021/example
/ar project all
/ar canvas repo art-tra2021/example
/ar canvas all
```

AIと定期処理は同じscopeを非対話コマンドで指定します。

```text
mise run slack:canvas -- --repo art-tra2021/example --user U0123456789
mise run slack:canvas:json -- --user U0123456789
```

Canvas同期は内容のhashを保存し、Projectの表示内容が変わらない限り`canvases.edit`を呼びません。
これにより、定期同期が更新履歴と通知を増やす問題を避けます。

## 新規repositoryの開設

新規repositoryは、中央repositoryの「Repository開設申請」Issueから依頼します。
管理者は申請内容を`plan`と`dry-run`で確認し、`apply`を明示した場合だけ作成します。

既定では全社GitHub Projectを正本とし、repository別の保存Viewをリンクします。
顧客分離など権限境界が異なる場合だけ、Organization Project Templateから独立Projectを作ります。

Repository Templateは`minimal`、`python`、`typescript`、`business`の4種類です。
各Templateはmise、hook、Issue Form、PR、CI、AI向け規則を共有しますが、秘密情報、個人のAI設定、CD設定は含めません。
詳細は[Repository Template](repository-template.md)と[Repository開設手順](repository-provisioning.md)を参照します。

## 段階導入

1. テンプレート、mise、hooks、CI、警告を導入する。
2. `git ar`を通常経路にし、ローカル規則をblockへ上げる。
3. Rulesetをテストリポでactiveにし、`verify`と`policy`を必須にする。
4. Rule Insightsとtelemetryを週次で見て、誤検知と回避行動を修正する。
5. 組織Custom Propertiesで対象リポジトリを選び、段階的に横展開する。

GitHubの`evaluate` RulesetはEnterprise機能なので、現在のプランでは使いません。
テストリポではactive rulesetを使い、管理者bypassを非常口として残します。

Rule Insightsは`git ar rules`で定期確認し、個別suiteの規則別結果は`--suite <ID>`で取得します。
Organization Custom Propertiesは`governance/custom-properties.schema.json`を宣言元とし、dry-run後の明示承認で適用します。
宣言外propertyの削除は自動化せず、既存運用を破壊しません。
