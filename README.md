# Realtime Translator

Windows 11 上で動く、オンライン会議、通話、動画や配信向けのリアルタイム翻訳
コンパニオンです。特定アプリのプラグインや会議ボットではありません。PC のシステム音声と
マイク入力を分けて取り込み、英語と日本語の原文・翻訳を入力元ごとに表示します。

## 主な機能

- システム音声: 英語の文字起こしと日本語訳
- マイク音声: 日本語の文字起こしと英語訳
- 2 系統を並べたリアルタイム transcript
- 会話の一時停止、再開、終了
- 相手、自分、会話全体の 3 種類の MP3 保存
- Microsoft Entra ID / Azure RBAC による keyless 接続
- Terraform と PowerShell による Azure リソースの setup / cleanup

> [!IMPORTANT]
> システム音声には翻訳対象以外の通知音や他アプリの音声も含まれます。録音と Azure
> への音声送信を始める前に、参加者の同意と組織のポリシーを確認してください。

## 必要な環境

- Windows 11
- Node.js 22
- PowerShell 7
- Azure CLI
- Terraform
- 利用権限のある既存の Azure resource group

## セットアップ

```powershell
az login
az account set --subscription <SUBSCRIPTION_ID>

.\scripts\setup-realtime-translation.ps1 `
  -SubscriptionId <SUBSCRIPTION_ID> `
  -ResourceGroupName <RESOURCE_GROUP_NAME>
```

setup は Azure 環境を検査して Terraform plan を表示し、明示的に `APPLY` と入力した場合
だけリソースを作成します。生成される `.realtime-translation/context.json` はローカル専用で、
Git には保存されません。

## 開発とパッケージ化

```powershell
cd .\src\realtime-translator
npm ci
npm run dev

# テストとビルド
npm test
npm run build

# Windows installer と portable 実行ファイル
npm run package
```

成果物は `src/realtime-translator/dist/` に作成されます。

詳しい使用方法、Azure 構成、トラブルシューティング、cleanup は
[docs/realtime-translation-app.md](docs/realtime-translation-app.md) を参照してください。
