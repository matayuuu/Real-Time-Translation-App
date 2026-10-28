---
description: 既存の Vitest・Testing Library・pytest で振る舞いと契約を検証する。
applyTo: "src/realtime-translator/tests/**,tests/contract/**"
---

# テスト

- アプリは既存の `tests/main`、`tests/renderer`、`tests/fixtures` と Vitest を使う。
  UI は Testing Library の role・label による操作を優先する。
- 非同期処理を待ち、モックは `DesktopBridge` など実際の契約に適合させる。
  成功だけでなく拒否・範囲外・キャンセル・古い応答を、変更した契約に応じて確認する。
- 実 OS、ファイル、音声、ネットワークの境界を区別する。
  単体テストのモック成功をネイティブ動作や Azure 接続の成功として報告しない。
- Python 契約テストは `tests/contract/test_*.py` と pytest を維持する。
  PEP 8 に沿う既存書式と標準ライブラリを優先し、依存は `requirements-dev.txt` で管理する。
- 構成ファイルの静的契約テストは実行時の振る舞いを保証しない。
  失敗すべき検体が実際に拒否されることも確認する。
- 外部サービス、実録音、本物のトークン、個人の context/state を fixture に使わない。
  0 件実行、固定の成功、失敗を無視するオプションで検証を通さない。
- 最小の関連テストを一度に実行し、共有契約を変更した場合は関連する両側へ広げる。

公式仕様: [Vitest](https://vitest.dev/guide/)、
[Testing Library](https://testing-library.com/docs/queries/about/)、
[pytest](https://docs.pytest.org/en/stable/how-to/assert.html)。
