---
description: 既存の検証 job と Release 配布の分離を維持する。
applyTo: ".github/workflows/*.yml,.github/workflows/*.yaml"
---

# CI の保守

- `.github/workflows/validate.yml` の `application` と `infrastructure` を既存の検証入口とする。
  ローカルの package scripts、lockfile、作業ディレクトリ、Node.js 22 / Python 3.12 とそろえる。
- 通常検証の `contents: read` を維持し、不要な secrets や書き込み権限を渡さない。
  `pull_request_target` で外部 PR のコードを実行しない。
- 型検査は既存 build に含まれる。テスト 0 件や失敗を無視する設定で job を成功させない。
- `release` は検証後の main push に限る既存の配布処理。
  初期化やローカル検証の副作用として実行・拡張しない。
- action の更新は実在する公式 release と互換性を確認する。
  remote CI の結果は対象 head SHA と期待する job の完了結果で確認する。
- workflow の変更と branch rules・required checks・公開権限の変更は別操作。
  利用ガイドの変更共有方針と実際の強制設定を混同しない。

公式仕様: [GitHub Actions の構文](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions)。
