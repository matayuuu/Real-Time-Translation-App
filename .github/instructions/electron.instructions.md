---
description: Electron・React・TypeScript の境界と既存 UI を維持する。
applyTo: "src/realtime-translator/**/*.ts,src/realtime-translator/**/*.tsx,src/realtime-translator/src/**/*.js,src/realtime-translator/src/**/*.css,src/realtime-translator/src/**/*.html"
---

# Windows アプリ

- ES modules、2 スペース、既存のダブルクォート・セミコロンを維持する。
  型の正本は `tsconfig.node.json` と `tsconfig.web.json`。
- renderer の状態と表示は React、OS・ファイル・Azure CLI 操作は main に置く。
  型付き契約は `src/shared/contracts.ts`、チャンネルは `src/shared/ipc.ts` で共有する。
- preload は限定されたメソッドだけを公開する。汎用 IPC、ファイルアクセス、
  Node.js API を renderer に渡さない。
- `nodeIntegration: false`、`contextIsolation: true`、sandbox、CSP、
  navigation 制限と IPC sender 検証を弱めない。
- UI は現在の日本語、`--cp-*` トークン、`styles.css` の部品を再利用する。
  非同期操作の失敗を表示し、unmount 後や古い応答で新しい状態を上書きしない。
- 音声取得・送信は既存の同意と認証が終わってから開始する。
  設定や表示だけの操作で録音・認証・Azure 通信を開始しない。
- アプリ名を理由に既存の userData パスや未保存録音を移動・破棄しない。
- 検証入口はルートの AGENTS.md。ウィンドウ機能は DOM/CSS だけでなく
  main 側への接続とネイティブ API の動作も確認する。

公式仕様: [Electron のプロセス分離](https://www.electronjs.org/docs/latest/tutorial/process-model)、
[TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html)。
