# Realtime Translator

Windows 11 上で動く、オンライン会議、通話、動画や配信向けのリアルタイム翻訳
コンパニオンです。特定アプリのプラグインや会議ボットではありません。PC のシステム音声と
マイク入力を分けて取り込み、英語と日本語の原文・翻訳を入力元ごとに表示します。

## 主な機能

- システム音声: 英語の文字起こしと日本語訳
- マイク音声: 英語の文字起こしと日本語訳
- 2 系統を並べたリアルタイム transcript
- 会話の一時停止、再開、終了
- 相手と自分を混ぜた MP3 の一意名保存
- 日本語の会話要約と Next Actions の Markdown 出力（任意）
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

PowerShell 7:

```powershell
az login
az account set --subscription <SUBSCRIPTION_ID>

pwsh -NoProfile -File .\scripts\setup-realtime-translation.ps1 `
  -SubscriptionId <SUBSCRIPTION_ID> `
  -ResourceGroupName <RESOURCE_GROUP_NAME>
```

Bash:

```bash
az login
az account set --subscription "<SUBSCRIPTION_ID>"

pwsh -File ./scripts/setup-realtime-translation.ps1 \
  -SubscriptionId "<SUBSCRIPTION_ID>" \
  -ResourceGroupName "<RESOURCE_GROUP_NAME>"
```

setup は Azure 環境を検査して Terraform plan を表示し、明示的に `APPLY` と入力した場合
だけリソースを作成します。生成される `.realtime-translation/context.json` はローカル専用で、
Git には保存されません。

既存環境から更新する場合も setup を再実行し、Markdown 生成用の `gpt-5.6-luna`
deployment が plan に含まれることを確認してください。

### ローカル設定と Terraform state の復旧

通常の `git pull` ではローカル専用ファイルは削除されません。ただし、再 clone、リポジトリ
ディレクトリの削除、別 PC への移行では、Git 管理外の `.realtime-translation/context.json` と
`infra/realtime-translation/terraform.tfstate` が失われます。
Azure 側にこのアプリのリソースが残っている状態で `Resource already exists` と表示された場合は、
同じ subscription と resource group を指定して次を実行します。

```powershell
pwsh -NoProfile -File .\scripts\setup-realtime-translation.ps1 `
  -SubscriptionId <SUBSCRIPTION_ID> `
  -ResourceGroupName <RESOURCE_GROUP_NAME> `
  -RecoverExisting
```

`-RecoverExisting` は、決定的な名前とこのアプリの ownership tag が一致する既存リソースだけを
ローカル Terraform state に import します。その後に通常どおり plan を表示し、`APPLY` と完全一致する
入力があるまで Azure を変更しません。state が残っていて `context.json` だけがない場合は、
`-RecoverExisting` を付けずに通常の setup を再実行すれば再生成されます。既存 resource group 内に
このアプリのリソースがまだない初回 setup にも `-RecoverExisting` は不要です。

## Windows アプリの更新

`main` の検証成功後、GitHub Actions が versioned GitHub Release と Windows installer を
自動発行します。Setup 版を一度インストールすると、アプリは起動時と 15 分ごとに更新を確認し、
ダウンロード完了後に再起動確認を表示します。portable 版と `win-unpacked` は開発・確認用のため、
継続利用する端末では Setup 版を使用してください。

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
