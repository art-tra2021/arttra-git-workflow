# 実験記録

## E-001: TUIと非対話入力の同値性

- 仮説: 人間とAIで入力方法を分けても、同じ構造化入力へ変換すれば運用規則を共有できる。
- 人間: `git ar`からcommitまたはIssueを作る。
- AI: 完全な引数を指定して`--dry-run`または`--json`を実行する。
- 観測: 所要時間、不明だった項目、修正回数、回避された規則。
- 成功条件: 両経路から同じvalidatorを通り、同じ形式の結果になる。

## E-002: 警告hook

- 仮説: 最初から拒否するより、警告を収集して規則を調整した方が導入負荷を下げられる。
- 操作: `arttra.toml`の`commit.mode = "warn"`で実際のcommitを行う。
- 観測: 警告件数、無視された理由、誤検知。
- 成功条件: blockへ移行できる規則と、補助が必要な規則を分離できる。
- 結果: `git ar commit`がtrailerを付与する方式でblockへ移行した。Git生成messageは例外にした。

## E-003: 変更ファイルpresence

- 仮説: diff本文を共有しなくても、branchと変更ファイルパスだけで作業衝突を早期発見できる。
- 操作: 2つのworktreeを別actor/deviceとして共有し、同じファイルのbranch差分・unstaged差分と、片側だけのuntracked fileを作る。
- 観測: unstagedとuntrackedを正しく区別し、同じファイルだけを重複として検出できた。
- 改善: branch全体の重複は件数が多くなるため、未commitを先、branch差分を後に表示する。
- OS実行: macOSのlaunchdは保護外cloneで終了コード0を確認した。Desktop配下ではmacOSのbackground accessで停止するため、登録を拒否する。
- 成功条件: 人間向け表示とAI向けJSONが同じsnapshotを使用し、期限切れ端末を自動的に無視する。

## 未決定

- AIプロバイダーと認証方法
- Organizationへ移管する条件

## E-004: active Rulesetと本人マージ

- 仮説: Rulesetのapproval数を0にし、Issueの`merge/*`を`policy` checkで評価すれば、保護を外さず変更ごとにレビュー強度を選べる。
- 操作: `merge/self` IssueからPRを作り、`verify`と`policy`を必須にしたactive Ruleset下でsquash mergeする。
- 観測: required check、merge可否、Rule suiteを記録する。
- 成功条件: 管理者bypassなしで本人マージでき、Rulesetの評価記録をAPIから取得できる。
