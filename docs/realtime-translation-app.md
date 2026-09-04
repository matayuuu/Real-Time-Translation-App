# Windows リアルタイム翻訳コンパニオン

> [!IMPORTANT]
> これは Windows 11 上で動く **Electron コンパニオン アプリ**です。特定の
> オンライン会議、通話、再生アプリのプラグインや会議ボットではありません。

## できること

- システム ループバックを既定の話者として取得します。これは対象アプリに限らず、PC が
  出力する**すべてのシステム音声**を含み得ます。
- マイクは別途選択し、システム音声と区別して取り込みます。
- システム音声とマイク音声を英語→日本語で Azure OpenAI realtime deployment に送ります。
- 翻訳結果は**テキスト表示のみ**です。AI が生成した翻訳音声はミュートされ、会議へ
  再生・送信しません。
- システム音声とマイク音声を混ぜた 1 本の MP3 をローカルで生成し、一意な名前で保存します。
- 必要に応じて、会話の日本語要約と Next Actions を Markdown として MP3 と一緒に保存します。
- 音声は Azure にアップロードされます。ローカル MP3 のみを選んでも、リアルタイム
  翻訳を使う間の音声送信は必要です。
- Markdown を選択した場合だけ会話ログを `gpt-5.6-luna` へ送信します。音声を
  `gpt-5.6-luna` へ再送信することはなく、Responses API の保存は無効にします。

## 事前条件と同意

- Windows 11、PowerShell 7、Azure CLI、Terraform、Node.js を用意します。
- `az login` で Microsoft Entra ID にサインインします。API key や client secret は
  使用しません。
- ヘッドセットを使ってください。スピーカー出力をループバックで取り込むため、ハウリング、
  音声の重複、意図しない録音を避けられます。
- 会議参加者、周囲の人、組織の録音・翻訳・データ送信ポリシーに従い、必要な同意を
  事前に取得してください。通知音、他アプリの音声、個人情報、機密情報もシステム出力に
  含まれる可能性があります。
- Azure への音声送信、モデル推論、データ転送には課金が発生し得ます。利用時間と
  deployment capacity を管理してください。Markdown を選択すると Luna の入出力 token
  にも課金されます。不要になったら cleanup を実行してください。

## Azure 環境の準備

このアプリ専用の Terraform root は `infra/realtime-translation/` です。
対象は指定した**既存**の resource group です。スクリプトは resource group を作成・削除せず、
provider 登録や subscription scope の role assignment も行いません。

PowerShell 7 でリポジトリのルートから実行します。

```powershell
az login
az account set --subscription <SUBSCRIPTION_ID>
./scripts/setup-realtime-translation.ps1 `
  -SubscriptionId <SUBSCRIPTION_ID> `
  -ResourceGroupName <RESOURCE_GROUP_NAME>
```

setup は read-only preflight、Terraform plan の表示、`APPLY` による確認の順で進みます。
自動化で明示的に了承済みの場合だけ `-AutoApprove` を指定してください。生成される
`.realtime-translation/context.json` と Terraform state は環境固有の情報を持つため、**commit しては
いけません**。

作成される Microsoft Foundry / Azure OpenAI 構成は次のとおりです。

| 項目 | 値 |
|---|---|
| AIServices account | `aif-rta-xxxxxxxx`（指定 subscription/RG/location から決定） |
| location | `eastus2`（RG の metadata location とは独立） |
| Foundry project | `realtime-translation` |
| 翻訳 deployment | `gpt-realtime-translate` / `gpt-realtime-translate` / `2026-05-06` / `GlobalStandard` / capacity 5 |
| 文字起こし deployment | `gpt-realtime-whisper` / `gpt-realtime-whisper` / `2026-05-06` / `GlobalStandard` / capacity 5 |
| 会話メモ deployment | `gpt-5.6-luna` / `gpt-5.6-luna` / `2026-07-09` / `GlobalStandard` / capacity 30 |
| Realtime lifecycle | GA。現在の構成で記録する retirement date は `2027-05-06` |

retirement date より前でも、モデル availability、quota、価格、地域サポートは変更され得ます。
実行前の preflight 結果を優先し、運用時は Microsoft の最新情報を確認してください。

## context の選択

setup は既存の `.realtime-translation/context.json` の他のトップレベル キーを保持したまま、
`realtime_translation` ブロックだけを追加・更新します。アプリは次のキーを選択・検証して
keyless 接続の構成に使用します。

```json
{
  "realtime_translation": {
    "schema_version": 1,
    "setup_status": "complete",
    "openai_endpoint": "https://aif-rta-xxxxxxxx.openai.azure.com",
    "translation": { "deployment_name": "gpt-realtime-translate" },
    "transcription": { "deployment_name": "gpt-realtime-whisper" },
    "insights": { "deployment_name": "gpt-5.6-luna" }
  }
}
```

手編集で endpoint、deployment、subscription を別環境の値に置き換えないでください。
環境を切り替える場合は、その環境で setup を実行した context を使用します。
旧 context でも翻訳と MP3 保存は利用できますが、Markdown のチェックボックスは無効になります。
既存環境で Markdown を使う場合は setup を再実行し、Terraform plan に Luna deployment が
追加されることを確認してから apply してください。

## アプリの起動とパッケージ化

`src/realtime-translator` で実行します。

```powershell
cd src/realtime-translator
npm ci
npm run dev

# 配布用成果物
npm run build
npm run package

# テスト
npm test
```

`npm run package` の成果物は `src/realtime-translator/dist/` に作成されます。
ローカルで生成した installer は署名されていない場合があります。Windows SmartScreen の警告が
表示されたら、組織のソフトウェア配布ポリシーに従って発行元・ハッシュ・入手元を確認して
ください。警告を無条件に回避したり、本番端末へ無許可で配布したりしないでください。

### 自動更新

`main` への push（PR merge を含む）で application と infrastructure の検証が両方成功すると、
GitHub Actions は run number を patch version にした GitHub Release を自動発行します。
Setup 版は起動時と 15 分ごとに Release を確認し、更新をダウンロードすると再起動確認を表示します。
最初の 1 回は Setup 版を手動でインストールする必要があります。portable 版と `win-unpacked` は
開発・確認用であり、自動更新対象として継続利用しないでください。

現在の配布物はコード署名されていないため、更新 installer でも SmartScreen が表示される場合が
あります。本番配布では Windows コード署名証明書を設定してください。

## 使用手順

1. ヘッドセットを接続し、翻訳対象アプリの出力先を Windows の既定スピーカーに合わせます。
2. アプリを起動します。配布版の初回起動では **設定を選択** から、setup が生成した
   `.realtime-translation/context.json` を選びます。
3. 使用するマイクを選び、会議参加者の同意を確認して **同意を確認しました** を選択します。
4. **START CONVERSATION** を押します。左ペインへ相手の英語原文と日本語訳、右ペインへ自分の
   英語原文と日本語訳が、時間をそろえた連続 transcript として表示されます。
5. **STOP** で音声送信と録音を一時停止します。停止中は **RESUME** で再開するか、
   **END SESSION** で会話を終了できます。録音中も **END SESSION** で直接終了できます。
6. 終了後の **音声ファイルを保存しますか？** ダイアログで、必要なら
   **日本語で会話を要約** と **日本語で Next Actions を作成** を選択して、
   混合 MP3 を保存します。
7. 保存した場合は **DONE**、保存しない場合は **DISCARD & CLOSE** を選びます。
   どちらも未保存の一時録音を削除して、次の会話を開始できる状態へ戻します。

オプション未選択時は `conversation-YYYYMMDD-HHmmss-<一意ID>.mp3` を初期名として
MP3 の保存先を選びます。オプションを選択すると親フォルダーの選択後に同じ一意名の
フォルダーが作られ、MP3 と選択した `-summary.md` / `-next-actions.md` が保存されます。
生成や書き込みに失敗した場合は不完全なフォルダーを残さず、一時録音から再試行できます。

保存前にアプリを終了した場合、未保存の一時録音は次回起動時にプライバシー保護のため削除されます。
保存確認中の一時ファイルは
`%APPDATA%\teams-realtime-translator\recordings\<session-id>\` にあります。旧製品名との
互換性のため保存先名は維持しており、通常は直接操作しません。
アプリの Start/Stop は翻訳対象アプリ自体の録音機能や通話状態を変更しません。

## トラブルシューティング

| 症状 | 確認と対処 |
|---|---|
| システム音声が表示されない | Windows の出力デバイスと音量を確認し、対象アプリが実際にそのデバイスへ出力しているか確認します。仮想オーディオ デバイスや排他モードを使う場合は組織の端末ポリシーも確認します。 |
| マイクが無音・選択できない | Windows の Privacy & security の microphone permission、アプリ内で選んだ入力デバイス、ヘッドセットの物理ミュートを確認します。 |
| Azure RBAC / 401 / 403 | `az login` と対象 subscription を確認します。context の account / endpoint / deployment を手編集せず、setup の完了後に再起動します。権限の反映には時間がかかることがあります。 |
| quota または deployment 作成失敗 | setup 前の preflight report を確認します。Realtime 2 deployment は capacity 5、Luna は capacity 30 を要求します。provider の登録や quota 増量は subscription 管理者に依頼します。 |
| WebRTC 接続できない | 組織の firewall、proxy、VPN、TLS inspection が WebRTC の HTTPS/WSS/STUN/TURN 通信を妨げていないか、ネットワーク管理者に確認します。回避のために firewall を無断で変更しないでください。 |
| Markdown を選択できない | setup を再実行し、選択中の context に `insights` deployment が含まれることを確認します。会話ログが空の場合も選択できません。 |
| Markdown 生成に失敗する | `az login`、Luna deployment、quota、ネットワークを確認します。一時録音は残るため、再試行するかオプションを外して MP3 のみ保存できます。 |
| 日本語訳は続くが EN 原文だけ止まる | アプリは複数の Realtime transcript event 形式を処理し、訳文だけが45秒以上続く場合は該当セッションを自動再接続します。再接続中の表示とエラー内容を確認してください。 |

## cleanup

不要になった Azure リソースは、リポジトリのルートから削除します。

```powershell
./scripts/destroy-realtime-translation.ps1
```

destroy は context の `realtime_translation` ブロックから入力を補完し、保存済みの Terraform
state だけを使って destroy plan を表示します。`DESTROY` を入力するまで削除しません
（`-AutoApprove` は自動化時のみ）。指定した既存 resource group は削除対象では
ありません。成功時だけ
`realtime_translation` ブロックを削除し、他のトップレベル キーは保持します。
