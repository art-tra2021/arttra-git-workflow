# アーキテクチャ

## 目的

操作方法だけを人間とAIで分け、実行するユースケースと検証規則は共有します。

```text
Human ── TUI ───────┐
                    ├─ Commit / Issue use case ─ Validator ─ Git / GitHub
AI ─── CLI / JSON ──┘
```

TUIは便利な入力手段であり、正本ではありません。
正本は引数または将来追加するJSONスキーマで表現できる構造化データです。

## 境界

- `git ar context --json`は、AIへ渡せる最小限の状態を決定的に生成する。
- `git ar commit`はTUIと引数から同じcommit候補を生成する。
- `git ar issue`はTUIと引数から同じIssue本文を生成する。
- `commit-msg` hookはCLIと同じvalidatorを呼び、規則を二重実装しない。
- AIは候補を提案できるが、合否は`arttra.toml`とvalidatorが決める。

## 段階的な強制

初期値は`warn`です。
違反、離脱、修正回数を観測してから`block`へ変更します。
GitHub RulesetsとCIは、ローカルhookを回避した場合のサーバー側境界として後から接続します。
