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

- Windows 11、PowerShell 7、Azure CLI 2.61 以降、Terraform、Node.js を用意します。
- Azure の setup には `az login` を使用します。アプリ実行時は、必要な場合に既定ブラウザーが
  開き、接続先テナントへサインインします。API key や長期の client secret は使用しません。
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
pwsh -NoProfile -File ./scripts/setup-realtime-translation.ps1 `
  -SubscriptionId <SUBSCRIPTION_ID> `
  -ResourceGroupName <RESOURCE_GROUP_NAME>
```

Bash などのシェルから実行する場合は、`pwsh` 経由で同じスクリプトを呼び出します。

```bash
az login
az account set --subscription "<SUBSCRIPTION_ID>"

pwsh -File ./scripts/setup-realtime-translation.ps1 \
  -SubscriptionId "<SUBSCRIPTION_ID>" \
  -ResourceGroupName "<RESOURCE_GROUP_NAME>"
```

setup は read-only preflight、Terraform plan の表示、`APPLY` による確認の順で進みます。
自動化で明示的に了承済みの場合だけ `-AutoApprove` を指定してください。生成される
`.realtime-translation/context.json` と Terraform state は環境固有の情報を持つため、**commit しては
いけません**。

### ローカル状態を失った場合

通常の `git pull` は `.gitignore` 対象のローカル ファイルを保持します。一方、再 clone、
リポジトリ ディレクトリの削除、別 PC への移行では、次の両方が失われます。

- `.realtime-translation/context.json`
- `infra/realtime-translation/terraform.tfstate`

Terraform state が残っていれば、通常の setup を再実行するだけで `context.json` を再生成できます。
state も失われ、Azure 側にリソースが残っている場合は、次の opt-in recovery を実行します。

```powershell
pwsh -NoProfile -File ./scripts/setup-realtime-translation.ps1 `
  -SubscriptionId <SUBSCRIPTION_ID> `
  -ResourceGroupName <RESOURCE_GROUP_NAME> `
  -RecoverExisting
```

recovery は、指定環境から決定される account 名に加え、`application=teams-realtime-translation` と
`managed-by=terraform` の tag、resource type、location、SKU が一致する場合だけ既存 account と
配下の project、deployment、ユーザーの resource-scoped role assignment を state に import します。
resource group 自体や一致しないリソースは import しません。import 後にも saved plan を表示し、
`APPLY` と完全一致する入力があるまで Azure の変更や `context.json` の生成は行いません。
途中で import が失敗した場合は、成功済みの state を保持するため、原因を解消して同じ recovery
コマンドを再実行できます。

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
    "generated_at": "2026-09-05T00:00:00Z",
    "subscription_id": "<SUBSCRIPTION_ID>",
    "tenant_id": "<RESOURCE_TENANT_ID>",
    "resource_group_name": "<RESOURCE_GROUP_NAME>",
    "location": "eastus2",
    "ai_services_account_name": "aif-rta-xxxxxxxx",
    "openai_endpoint": "https://aif-rta-xxxxxxxx.openai.azure.com",
    "foundry_project_name": "realtime-translation",
    "foundry_project_endpoint": "https://aif-rta-xxxxxxxx.services.ai.azure.com/api/projects/realtime-translation",
    "translation": {
      "deployment_name": "gpt-realtime-translate",
      "model_name": "gpt-realtime-translate",
      "model_version": "2026-05-06",
      "sku": "GlobalStandard",
      "capacity": 5
    },
    "transcription": {
      "deployment_name": "gpt-realtime-whisper",
      "model_name": "gpt-realtime-whisper",
      "model_version": "2026-05-06",
      "sku": "GlobalStandard",
      "capacity": 5
    },
    "insights": {
      "deployment_name": "gpt-5.6-luna",
      "model_name": "gpt-5.6-luna",
      "model_version": "2026-07-09",
      "sku": "GlobalStandard",
      "capacity": 30
    },
    "model_retirement_date": "2027-05-06"
  }
}
```

`realtime_translation` と、上記の `insights`・`tenant_id` 以外のフィールドは必須です。
新しい setup は `tenant_id` も出力します。`subscription_id` と、指定する場合の `tenant_id` は
GUID です。各 deployment の `capacity` は 1 以上の整数、それ以外の文字列フィールドは空にできません。
`openai_endpoint` は `https://*.openai.azure.com` 形式である必要があります。`insights` は
省略できますが、その場合は会話要約と Next Actions を生成できません。API key や client secret は
context に保存せず、Azure CLI を介した Microsoft Entra ID 認証を使用します。

翻訳と Markdown 生成のトークン取得では `realtime_translation.subscription_id` を明示的に
指定します。Azure CLI の既定 subscription を別環境へ切り替えても、選択中の context の
subscription に対応するテナントを使用します。対象テナントへのサインインと、対象リソースの
RBAC 権限は引き続き必要です。アプリの専用 CLI profile を使うため、普段の Azure CLI の既定
subscription やサインイン状態は変更しません。

### ブラウザーでの自動再認証

会話開始時は **認証確認 → 2 系統の Foundry 接続用シークレットの取得 → 音声取得・録音**
の順で進みます。未サインイン、認証期限切れ、MFA など再認証が必要な場合だけ、アプリが裏側で
次のコマンドを実行します。テナントは context の値に固定し、利用者が毎回選ぶ必要はありません。

```powershell
az login --tenant <RESOURCE_TENANT_ID> --scope https://ai.azure.com/.default --output none --only-show-errors
```

Windows でもブラウザーを使い、CLI の subscription 選択待ちを防ぐため、子プロセスだけに
`AZURE_CORE_ENABLE_BROKER_ON_WINDOWS=false` と `AZURE_CORE_LOGIN_EXPERIENCE_V2=off` を渡します。
これらの設定をグローバルな `az config` に書き込むことはありません。CLI は引き続き必要ですが、
新しい Entra アプリ登録やクライアントシークレットは不要です。

CLI の認証キャッシュは `%APPDATA%\teams-realtime-translator\azure-cli\profiles\<tenant-id>\` に
分離されます。初回は、通常の CLI でサインイン済みでもブラウザー認証が必要です。Windows 上の
トークン保存は Azure CLI / MSAL の OS 保護を使用し、アプリはトークンを context、画面、ログへ
保存・出力しません。実行中は有効なアクセストークンを共有し、期限が近づいたら再取得します。

`tenant_id` がない旧 context は、**指定 subscription の** CLI メタデータからテナントを特定し、
アプリのローカル設定に ID だけを保存します。既定 subscription や `common` にはフォールバック
しません。メタデータもない場合は、Azure portal で確認したリソースのテナント ID を context の
`tenant_id` に設定して選び直してください。期限切れトークン内のテナントからは推測しません。

ブラウザーで認証を終えると元の処理を1回再試行します。スピーカー・マイク・要約で認証処理を
共有し、同じ接続先の同時要求で複数の認証画面を開きません。アプリの **認証をキャンセル** で中止
でき、3分以内に認証が終わらない場合も待機を終了します。開いたブラウザーのタブは閉じて構いません。
キャンセルや失敗後は、自動再接続でログインを繰り返さず、START CONVERSATION、RESUME、
または保存の再試行で認証をやり直します。

別のアカウントを選択して対象 subscription が見つからない場合は、認証エラー欄の
**サインインし直す** を選び、対象リソースへの権限を持つアカウントを選び直してください。
この明示操作では有効なトークンのキャッシュも使わず、同じ接続先テナントで再認証します。
録音中は STOP で一時停止してから実行できます。自動の認証確認中も STOP は利用できます。

会話中の再認証では録音と送信を一時停止し、既存の録音・字幕は保持します。認証後は **RESUME**
で再開してください。Markdown 保存中にキャンセルした場合も録音を保持するため、保存を再試行
するか MP3 のみ保存できます。権限不足、設定不一致、通信障害ではブラウザーを開き続けません。
組織の MFA・条件付きアクセスは引き続き適用され、無期限のログインは保証しません。

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
| Azure RBAC / 401 / 403 | アプリで認証したアカウント、対象 subscription、リソースの RBAC 権限を確認します。context の account / endpoint / deployment を手編集しないでください。権限の反映には時間がかかることがあります。 |
| サインインが必要 / 認証期限切れ | アプリが指定テナントのブラウザー認証を開きます。完了後に自動再試行します。キャンセルした場合は START CONVERSATION / RESUME / 保存を再試行してください。 |
| 接続先テナントを特定できない | 旧 context と CLI メタデータの両方にテナント情報がありません。リソースのテナント ID を context の `realtime_translation.tenant_id` に設定して選び直してください。 |
| 認証用ブラウザーを開けない / タイムアウト | Windows の既定ブラウザーとネットワークを確認し、古い認証タブを閉じて再試行します。CLI の device-code フォールバックを非表示のまま待ち続けることはありません。 |
| `Token tenant ... does not match resource tenant` / 400 | トークンと Foundry リソースのテナントが異なります。下記の手順で対象 subscription とサインイン先を確認します。リソースの再作成や API key への切り替えは不要です。 |
| quota または deployment 作成失敗 | setup 前の preflight report を確認します。Realtime 2 deployment は capacity 5、Luna は capacity 30 を要求します。provider の登録や quota 増量は subscription 管理者に依頼します。 |
| WebRTC 接続できない | 組織の firewall、proxy、VPN、TLS inspection が WebRTC の HTTPS/WSS/STUN/TURN 通信を妨げていないか、ネットワーク管理者に確認します。回避のために firewall を無断で変更しないでください。 |
| Markdown を選択できない | setup を再実行し、選択中の context に `insights` deployment が含まれることを確認します。会話ログが空の場合も選択できません。 |
| Markdown 生成に失敗する | アプリの認証状態、Luna deployment、quota、ネットワークを確認します。一時録音は残るため、再試行するかオプションを外して MP3 のみ保存できます。 |
| 日本語訳は続くが EN 原文だけ止まる | アプリは複数の Realtime transcript event 形式を処理し、訳文だけが45秒以上続く場合は該当セッションを自動再接続します。再接続中の表示とエラー内容を確認してください。 |

### テナント不一致の対処

アプリで選択している context の subscription と、そのテナントを確認します。
以下はリポジトリのルートで実行する例です。別の context を選択している場合はパスを変更してください。

```powershell
$context = (Get-Content -Raw .\.realtime-translation\context.json | ConvertFrom-Json).realtime_translation
az account show --subscription $context.subscription_id `
  --query "{subscriptionId:id,tenantId:tenantId}" --output json
```

対象 subscription が見つからない場合は、Foundry リソースが属するテナント ID を Azure portal で
確認し、context の `tenant_id` を確認してください。新しいアプリは専用 profile でブラウザー認証
します。通常の CLI で `az login` してもアプリ専用 profile は更新されません。エラー中の
`Token tenant` は現在の誤ったテナントであり、接続先として指定する値ではありません。

旧版アプリでは Azure CLI の既定 subscription が使われます。更新前の一時的な対処として、
次を実行してアプリから接続を再試行できます。この操作は他の Azure CLI 作業にも影響するため、
必要に応じて元の subscription を記録しておいてください。

```powershell
az account set --subscription $context.subscription_id
```

更新後も同じエラーが続く場合は、context の endpoint と subscription が同じ環境のものかを
確認してください。異なる環境の設定を混ぜず、その環境の setup が生成した context を選び直します。

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
