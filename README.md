# arttra-git-lab

人間には短いTUI、AIと自動化には非対話引数を提供するGitワークフロー実験場です。

## セットアップ

必要なのはGitと[mise](https://mise.jdx.dev/)だけです。

```console
git clone git@github.com:rozwer/arttra-git-lab.git
cd arttra-git-lab
mise trust
mise install
mise run setup
```

`mise run setup`はRust CLIをインストールし、このリポジトリの共有hookを有効にします。

## 人間向け

```console
git ar
```

メニューからcommit、Issue作成、診断、AI向けコンテキスト確認を選べます。

## AI・自動化向け

TUIを操作する必要はありません。

```console
git ar context --json
git ar commit --type feat --scope cli --summary "add deterministic input" --issue 1 --dry-run
git ar issue \
  --title "非対話commitを検証する" \
  --background "AIは対話TUIを安定して操作できない" \
  --goal "引数だけで同じ処理を実行できるようにする" \
  --done "dry-runの出力がTUIと一致する" \
  --json
```

実際にcommitする場合は、完全な引数に加えて`--yes`を指定します。
IssueをGitHubへ登録する場合は`--create`を指定します。
どちらも明示しなければプレビューだけなので、安全に試せます。

## 開発

```console
mise run verify
mise run ar -- doctor
```

設計原則と実験記録は[`docs/architecture.md`](docs/architecture.md)と
[`docs/experiments.md`](docs/experiments.md)にあります。
