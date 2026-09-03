# Windows リアルタイム翻訳コンパニオン

Windows 11 用の Electron コンパニオン アプリです。特定のオンライン会議、通話、再生アプリの
プラグインではありません。システム ループバック（既定のスピーカー、PC の全システム出力）と別途選択した
マイクを取り込み、英語→日本語・日本語→英語の realtime 翻訳を**テキストのみ**で表示します。
AI 翻訳音声はミュートされ、会議へ送出されません。

完全なセットアップ、同意・プライバシー・コスト上の注意、Azure 構成、cleanup は
[../../docs/realtime-translation-app.md](../../docs/realtime-translation-app.md) を参照してください。

## 前提条件

- Windows 11、Node.js、PowerShell 7、Azure CLI、Terraform
- Azure では `az login` による Entra ID/RBAC 認証（API key は不要）
- setup 済みのリポジトリ ルート `.realtime-translation/context.json` 内の
  `realtime_translation` ブロック
- 同意済みの音声取り込み。ヘッドセットを推奨します。

`.realtime-translation/context.json` と Terraform state は commit しないでください。

## 開発

```powershell
npm ci
npm run dev
npm run build
npm run package
npm test
```

`npm run package` で生成する installer は署名されていない場合があります。SmartScreen の
警告を回避する前に、組織のソフトウェア配布ポリシーと入手元を確認してください。

会話中は **STOP**、**RESUME**、**END SESSION** を選べます。終了後のダイアログで
3 種類の MP3 を個別に保存するか、**DISCARD & CLOSE** で保存せず終了します。
未保存の一時録音は、アプリを終了して次回起動した時点で削除されます。

## 音声とデータの取り扱い

ループバックには翻訳対象以外の通知音・他アプリの音声・機密情報が含まれる可能性があります。
音声は Azure にアップロードされ、システム音声、マイク音声、混合セッションの 3 種類を
ローカル MP3 として出力できます。録音・翻訳・アップロードの前に、参加者の同意および
組織のプライバシー・保持・課金ポリシーを確認してください。

## ライセンス

依存関係の通知は [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) を参照してください。
