# Repository開設とProvisioning

## 原則

新しいRepositoryは、中央の`art-tra2021/arttra-git-workflow`へ作成する「リポジトリ開設申請」Issueを入口とする。
申請者がSlackから入力しても、GitHub Issueへ正規化された一件の申請として保存する。
管理者が内容と権限を確認した後にだけ作成処理を実行する。

Repository、Project、Slack projectionの作成は監査可能な順序で行い、削除操作はprovisioning commandへ実装しない。
失敗した途中状態は再実行可能なreconcileとして扱い、既に存在する資源を勝手に置き換えない。

## Issue Form

`.github/ISSUE_TEMPLATE/repository-request.yml`が正本である。
必須項目は次のとおりである。

| 項目 | 値 | 用途 |
| --- | --- | --- |
| Repository名 | 小文字英数字とハイフン | 作成名・重複検査 |
| 目的と概要 | 長文 | 利用者、成果物、責任範囲 |
| profile | `minimal` / `python` / `typescript` / `business` | baseに重ねるwrapper |
| 可視性 | `private` / `internal` / `public` | データ境界 |
| 所有チーム | team slug | CODEOWNERS・権限 |
| リスク水準 | `low` / `standard` / `high` / `critical` | Ruleset・レビューの初期値 |
| レビュー方針 | `flexible` / `standard` / `strict` | マージ方針 |
| CI profile | `inherit`など | 共通CIの入力 |
| Project mode | `shared-view` / `isolated-template` | Projectの分離判断 |
| Slack channel | `#channel`または`未定` | projectionの初期束縛 |
| 初期アクセスチーム | team slugの一覧 | 付与する最小権限 |
| データの機微性 | `none` / `internal` / `confidential` / `restricted` | 可視性の再確認 |

secret、token、顧客の実データをIssueへ貼ってはならない。
Issueから`governance/repository-provision.schema.json`に適合するJSONへ変換し、文字列のtrim、enum、重複、Repository名の正規表現を決定的に検証する。
AIは申請文の要約を提案できるが、schema validatorを通過しない値を作成処理へ渡してはならない。

## 管理者の3段階フロー

以下の`git ar repository`群は、この文書で固定する実装契約である。
現行CLIにはまだ組み込まれていないため、コマンド実装とsmoke testが完了するまで`--apply`による本番開設を案内してはならない。
それまではIssue FormとTemplate定義を基盤として使用し、管理者がGitHub UIで作成結果を確認する。

### 1. plan

申請Issueを読み、作成予定をJSONで表示する。

```console
git ar repository plan --issue <number> --json
```

planは次を検証する。

- Issueが`type/repository-request`であり、必要項目が全てある
- Repository名が組織内で未使用である
- profile、visibility、project mode、team slugがschemaに適合する
- data sensitivityとvisibilityに矛盾がない
- shared Projectの保存Viewか、isolated Project Templateかの作成先
- Slack channelへ付与するprojectionの対象と権限
- GitHub App本体が要求する権限の差分

planは外部状態を変更してはならない。出力は安定したkey順のJSONと、人間向けの日本語要約の両方を持つ。

### 2. dry-run

planの内容を使い、作成APIを呼ばずに全差分を表示する。

```console
git ar repository provision --issue <number> --dry-run --json
```

dry-runは既存Repository、Project、保存View、Slack List binding、Custom Properties、Rulesetを読み取り、作成・更新・変更なしを分けて出力する。
既存資源の設定が期待値と異なる場合は`reconcile_required`として停止する。
既存設定を削除して再生成してはならない。

### 3. apply

管理者がdry-runの出力を確認した後、明示的にapplyする。

```console
git ar repository provision --issue <number> --apply --yes --json
```

applyの順序は次のとおりである。

1. schema、重複、権限、可視性を再検証する
2. 選択したwrapperをbaseへmaterializeする
3. Repositoryを作成し、初期branchとtemplate.lockを投入する
4. Custom Properties、team、CODEOWNERS、Rulesetを設定する
5. `shared-view`なら共有ProjectへRepository別保存Viewを作り、`isolated-template`ならStandard Project Templateから独立Projectを作る
6. Slackのrepo bindingとList accessを作る
7. smoke checkを実行し、申請IssueへRepository、Project、Slack、CIのリンクをコメントする
8. labelを`status/provisioned`へ変更する

各段階はsource issue numberとidempotency keyを監査ログへ記録する。
失敗後の再実行は既存IDを再利用し、既存resourceを削除しない。

## GitHub App権限

初期実装では、通常のSlack adapterが使うGitHub AppへRepository Administration writeを追加してはならない。
Administration writeはRepository作成だけでなく削除などの強い権限を含むためである。

初期運用は次のいずれかとする。

- 管理者の`gh`認証で`--apply`を実行する
- Repository作成専用のprovisionerを別GitHub Appとして用意する

専用provisionerを導入する場合も、削除endpointを実装せず、許可されたOrganization、profile、visibilityだけをallowlistする。
通常運用のGitHub AppはIssue、Project、Pull Request、Webhookに必要な最小権限だけを保持する。

## Projectの扱い

既定値は`shared-view`である。
Organization共有Projectを正本とし、Repository名でfilterした保存Viewを作成する。
これにより、期限、Status、依存関係をProjectごとに二重管理しない。
GitHub Projectの可視性はRepositoryの権限境界に従うため、private Repositoryの項目をSlackの全社共有Listへ再公開してはならない。

顧客単位、機密区分、契約上の分離など明確な権限境界がある場合だけ`isolated-template`を許可する。
この場合は`templates/project/standard-project.json`のviews、fields、workflows、draft itemsをコピーし、作成後に対象Repositoryを明示的にlinkする。
Project templateはauto-add設定をコピーしないため、linkとautomationのsmoke checkを必須とする。

## Slackと営業利用

Slackは操作と通知の入口、GitHub Issue/Projectは正本である。
営業利用者は次の操作をSlackから行えるようにする。

- `/ar repo request`でIssue Formと同じ項目を入力する
- `/ar projects`で現在のchannel、指定Repository、自分がアクセスできるRepositoryを選ぶ
- `/ar new`でIssueを作り、review要否、期限、担当者、blocked-byを指定する
- ボタンとmodalでStatus、Priority、Target date、Assigneeを変更する

「自分がアクセスできる全Repository」は利用者ごとに集合が異なる。
したがって共有channelの一つのListへ混在させず、Slack user単位のprivate projectionか、要求時のephemeral表示にする。
Repository単位のListはGitHub permissionを検証したuser idへだけ`slackLists.access.set`で付与する。
channel IDだけを根拠にprivateな項目を配布してはならない。

## Template同期

テンプレート更新は`template.lock.json`のsource commitを基準にする。

```console
git ar repository sync --json
git ar repository reconcile --check --json
git ar repository reconcile --create-pr --json
```

`sync`は最新版との差分を取得し、`reconcile`はmanaged pathだけを比較する。
Repository固有変更と衝突したpathは自動上書きせず、理由、対象path、推奨手動操作を日本語でPRへ記載する。
同期PRがmergeされるまで、対象Repositoryのmainへ直接書き込まない。

## 完了条件

管理者はapply後に次を確認する。

- Repositoryのvisibility、owner team、Custom PropertiesがIssueと一致する
- baseとwrapperのschema検証が成功する
- `template.lock.json`にprofileとsource commitがある
- `.gitignore`がAI連携・個人設定（`.agents/`、`.claude/`、`.codex/`、`CLAUDE.md`）をGit管理外にしている
- secret scanに該当がない
- RulesetとCIが期待するbranchへ適用される
- shared Projectの保存Viewまたはisolated Projectが作成される
- Slack projectionが対象ユーザーだけに見える
- 申請Issueに全resourceのリンクと監査結果が残る

一つでも不一致なら`status/provisioned`にせず、削除ではなくreconcile Issueを作成する。
