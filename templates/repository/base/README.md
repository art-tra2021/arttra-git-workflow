# ART-TRA Repository Base Template

これは全Repositoryに共通する薄い基盤である。

- `mise`によるtoolchainの固定
- `git ar`のTUIと非対話JSON入口
- 日本語のdiagnosticを返すhook、AI command guard、Issue/PRの共通形式
- 共通CIの呼び出し口
- governance値と`template.lock.json`による生成元の追跡

Python、TypeScript、営業・業務文書などの差分は、同じbaseへwrapper profileを重ねて生成する。
このbaseへsecret、token、個人のClaude/Codex設定、project固有のCD設定を含めてはならない。

このディレクトリを直接GitHub Repository Templateとして公開するのではなく、管理者のprovision commandが選択したwrapperを決定的にmaterializeする。
