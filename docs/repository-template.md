# Repository Template運用

## 目的

新しいRepositoryは、ART-TRAの薄い共通基盤と用途別profileから決定的に生成する。
人間とAIが同じ入力を再現できること、生成元を後から追跡できること、個人環境やsecretを複製しないことを目的とする。

この`arttra-git-workflow` Repository自体をそのままGitHub Repository Templateとして使ってはならない。
Slack adapter、運用実験、社内の認証設定まで複製され、権限境界と保守責任が不明確になるためである。

## 構成

```text
templates/
  repository/
    base/                         # 全Repository共通の薄い基盤
    wrappers/
      minimal/template.json       # 最小構成
      python/template.json        # Python / uv
      typescript/template.json    # TypeScript / bun
      business/template.json      # 営業・業務文書
  project/standard-project.json   # GitHub Projectの独立作成用定義
governance/
  template-registry.json          # profileとschemaの正本
  template-*.schema.json          # 決定的validator用契約
```

baseに含むものは、miseのtoolchain、`git ar`の入口、hookとAI command guard、Issue/PR形式、共通CIの呼び出し口、governance値である。
profileはbaseとの差分だけを持つwrapperであり、同じファイルをprofileごとに複製してはならない。

| profile | 主な用途 | 追加runtime | CI profile |
| --- | --- | --- | --- |
| `minimal` | 言語を限定しない小規模・検証Repository | なし | `unmanaged` |
| `python` | Pythonサービス・解析 | Python、uv | `python` |
| `typescript` | TypeScript、React、Node | Node、bun | `typescript` |
| `business` | 営業、業務、仕様書 | なし | `documents` |

Rustは現時点では共通profileに含めない。必要なRepositoryだけ作成後にRust用overlayを追加する。

## 生成時の契約

生成後のRepository直下には`template.lock.json`を置く。lockには次を記録する。

- `template_id`、profile、baseline version
- materialize元のsource commit
- 管理対象pathとローカル専用path
- 同期方式がpull requestであること
- secretを決してコピーしないこと

`governance/template-lock.schema.json`、`template-wrapper.schema.json`、`template-registry.schema.json`をJSON Schema Draft 2020-12の決定的validatorで検証する。
検証は入力JSONの並び順や表示文言に依存せず、未知のpropertyを拒否する。

### 管理対象とローカル専用

管理対象は`AGENTS.md`、`.github/`、`.gitignore`、`.mise.toml`、`hk.pkl`、`arttra.toml`、`governance/`、`template.lock.json`である。
`.arttra/local/`、`.agents/`、`.claude/skills/arttra-git-workflow/`、`.claude/settings.local.json`、`.codex/`、`CLAUDE.md`はGit管理外のローカル専用である。
`.env`、credential、private key、service account、依存cache、build生成物はbaseにもwrapperにも含めてはならない。

## 初回セットアップ

利用者へ案内するコマンドは次の3つである。

```console
git clone git@github.com:art-tra2021/<repository>.git
cd <repository>
mise trust && mise run setup-ar && mise run ready
```

`setup-ar`がtoolchain、hook、AI連携を準備し、`ready`が診断、検査、次の行動を表示する。
認証、shellの権限、OS固有の設定だけはエラーと対応マニュアルを示して利用者に委ねる。
個人のClaude/Codex設定をRepositoryへcommitしてはならない。

この基盤を利用者へ公開する前に、中央Repositoryから署名済み`git-ar`バイナリを配布するrelease経路を用意する必要がある。
現在のbaseは、組織の端末セットアップで`git ar`が既に導入済みであることを前提とする。
releaseが存在しない状態で、各RepositoryへRust toolchainを追加したり`cargo install`を利用者へ実行させたりしてはならない。

## 更新とreconcile

templateの更新は元Repositoryへ直接pushせず、実装予定の`git ar repository sync`が生成する同期PRで配布する。
このcommandが実装されるまでは自動同期を有効化しない。
同期PRには次を含める。

1. `template.lock.json`のsource commitとbaseline versionの更新
2. managed pathだけの差分
3. 既存Repository固有の変更を上書きしないreconcile結果
4. secret検査とschema検証の結果

managed pathとRepository固有の差分が衝突した場合は、自動解決せず日本語の衝突診断を出してPRを止める。
既存の手動設定を黙って削除したり、force pushしたりしてはならない。

## GitHub Repository Templateとの関係

GitHub上でクリックから作成する必要がある場合、管理者はこのregistryからprofileごとの専用template Repositoryをmaterializeして公開する。
専用template Repositoryへは、baseとwrapperの展開結果、検証済みの`template.lock.json`だけを入れる。
template Repositoryの中にSlack adapterの秘密、Cloud Run設定、個人のAI設定、CDは入れない。

通常の開設はIssue申請を正本とし、管理者のprovision commandがwrapperを選択する。
クリック作成を許可する場合も、同じprofileとschemaを使った結果だけを許可し、手作業で別構成を作ってはならない。

## Project Template

通常はOrganizationの共有Projectを正本とし、Repositoryごとの保存Viewを作る。
ProjectをRepositoryごとに複製するとStatus、期限、依存関係が分裂するためである。

顧客や機密情報など明確な権限境界がある場合だけ、`templates/project/standard-project.json`をGitHub Organization Project Templateとして使い、独立Projectを作成する。
この場合も、作成後にRepositoryをProjectへ明示的にリンクする。
GitHubのProject templateがauto-add設定を複製しないことを前提に、管理者がlinkとautomationを検証する。
