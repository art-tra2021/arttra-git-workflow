---
name: arttra-git-workflow
description: ART-TRA 管理下のリポジトリで、Issue の選択、着手、ブランチ作成、実装、確認、コミット、Pull Request 提出を安全に進める。作業開始時、次の作業を判断するとき、Git や GitHub を操作するときに使用する。
---

# ART-TRA Git Workflow

人間向け TUI と同じ規則を、AI 向けの CLI 引数と JSON 出力から利用する。
GitHub 上の Issue、依存関係、merge 方針を正本とし、推測で作業を始めない。

## 作業を始める

1. リポジトリ直下の `AGENTS.md`、`CLAUDE.md`、`arttra.toml` を読む。
2. `git ar context --json` でリポジトリの規則を確認する。
3. `git ar status --json` で自分の Issue、進行中の作業、次の候補を確認する。
4. `git ar presence check --json` で他の作業者が触っているファイルを確認する。
5. 不明な要件や競合があれば、変更前に人間へ確認する。

`--json` がないコマンドでは、TUI を開かず、必要な値を引数で明示する。

## Issue とブランチを選ぶ

- 既存 Issue がある場合は、新しい Issue を重複作成しない。
- Issue の owner、依存関係、blocked 状態、merge 方針を確認する。
- 他の owner の Issue を、明示的な引き継ぎなしに取得しない。
- ブランチは `git ar branch` で作成し、命名規則を手入力で迂回しない。
- intake と実装可能な task を混同しない。要件が不足していれば task 化を先に行う。

## 変更する

- `mise` で定義されたコマンドと toolchain を使用する。
- JavaScript/TypeScript は `bun`、Python は `uv` を優先し、`npm install` や `pip install` で環境を作らない。
- 対象ファイルを決めたら presence を publish し、変更対象が変わったら更新する。
- 他の branch と対象ファイルが重なる場合は、勝手に上書きせず調整する。
- hooks、deny、rulesets を迂回しない。拒否理由を読み、安全な代替手順を選ぶ。
- ユーザーの既存変更と無関係なファイルを変更しない。

## 確認してコミットする

1. `git status --short` と diff を確認する。
2. リポジトリが定義する `mise` の lint、test、verify を実行する。
3. 必要に応じて `git ar check --json` を実行する。
4. 意図したファイルだけを stage する。
5. `git ar commit` に type、scope、summary、Issue を引数で渡してコミットする。

直接の `git commit` は使用しない。検証失敗時は `--no-verify` で回避せず原因を修正する。

## Pull Request を提出する

1. 最新の基準 branch との差分と conflict を確認する。
2. presence を更新し、未共有の対象ファイルがないことを確認する。
3. branch を push し、対応 Issue と merge 方針を明記した Pull Request を作る。
4. 必須 check、ruleset、review 条件を確認する。
5. `merge/self` でも、CI が成功するまでは merge しない。

作業完了後は presence を解除する。

## 危険操作

`sudo`、root/home の再帰削除、`git reset --hard`、破壊的な `git clean`、force push、
repository や cloud project の削除、infrastructure destroy は自動実行しない。
必要性を説明し、対象と影響範囲を特定して人間へ確認する。

force push が本当に必要な場合でも、通常の `--force` ではなく `--force-with-lease` を検討する。
