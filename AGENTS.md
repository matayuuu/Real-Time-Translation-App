# 開発ガイド

## 目的と読む順序

Windows 11 用の Electron 翻訳コンパニオン。システム音声とマイクを別々に翻訳し、
混合 MP3 と任意の会話メモを保存する。会議ボットや会議サービスのプラグインではない。

- 用途と起動方法: [README.md](README.md)。
- 利用・認証・データ境界: [利用ガイド](docs/realtime-translation-app.md)。
- 変更する領域に対応する `.github/instructions/*.instructions.md` を読む。
- 設計・検証・変更共有の方針は利用ガイドの「開発時の構成と変更方針」を参照する。

## 構成

| 場所 | 責務 |
|---|---|
| `src/realtime-translator/src/main/` | Electron のウィンドウ、認証、設定、保存、更新 |
| `src/realtime-translator/src/preload/` | 型付きの限定的な IPC ブリッジ |
| `src/realtime-translator/src/shared/` | main と renderer の契約・IPC チャンネル |
| `src/realtime-translator/src/renderer/` | React UI、音声取得、翻訳接続、MP3 エンコード |
| `src/realtime-translator/tests/` | Vitest と Testing Library のテスト |
| `infra/realtime-translation/` | AzAPI による独立した Terraform root |
| `scripts/` | Azure の事前確認・setup・cleanup |
| `tests/contract/` | pytest によるインフラ・スクリプト・配布契約の検証 |
| `.github/workflows/validate.yml` | Windows アプリとインフラの検証、既存の Release 配布 |

renderer は Node.js や Azure CLI を直接呼ばず、preload の `DesktopBridge` を使う。
権限・ファイル操作・認証は main が所有する。契約変更時は main、preload、shared、
renderer とテストのモックを一緒に確認する。

## 検証

PowerShell 7、リポジトリのルートから実行する。アプリは Node.js 22 と
`src/realtime-translator/package-lock.json` を使う。ルートの package ファイルを
アプリの依存管理に使用しない。

| 対象 | コマンド |
|---|---|
| アプリ依存の復元 | `npm --prefix .\src\realtime-translator ci` |
| 単体・UI テスト | `npm --prefix .\src\realtime-translator test` |
| 対象を絞ったテスト | `npm --prefix .\src\realtime-translator test -- tests/main/context-service.test.ts` |
| 型検査 | `npm --prefix .\src\realtime-translator run typecheck` |
| ビルド（型検査を含む） | `npm --prefix .\src\realtime-translator run build` |
| Windows 配布物の作成 | `npm --prefix .\src\realtime-translator run package` |
| インフラ等の契約テスト | `python -m pytest tests/contract` |
| Terraform 書式検査 | `terraform -chdir=infra/realtime-translation fmt -check` |
| Terraform 構成検証 | `terraform -chdir=infra/realtime-translation init -backend=false` 後に `terraform -chdir=infra/realtime-translation validate` |

pytest の依存は `requirements-dev.txt` を使い、ローカルに復元するときは仮想環境を使う。
CI の Python は 3.12。アプリの静的検査は既存の strict TypeScript 設定を正とし、
独立した JavaScript/TypeScript の lint・formatter は現在未設定。
変更と無関係な一括整形やツール置換は行わない。

## 注意事項

- `.realtime-translation/context.json`、Terraform state、認証キャッシュ、録音、
  トークン、会話内容をコミット・ログ出力しない。
- 検証のために録音、Azure 接続、setup、destroy、Release 公開を実行しない。
- Azure 変更は既存の saved plan と明示確認を維持する。既存 resource group 自体を変更しない。
- 開発版は既存アプリと多重起動できない。ユーザーのアプリや未保存録音を勝手に終了しない。
- 通常の実装は Default Agent で行う。独立した調査やレビューが必要な場合だけ既存 Agent を使う。
  専用 Agent は、既存の役割で不足する反復作業と明確な入出力・権限境界が生じた場合に再評価する。
- 現在の設計や公開契約が変わったら、関連する文書とテストを同じ変更で更新する。
  日常的な実装選択のための ADR や進捗文書は増やさない。
