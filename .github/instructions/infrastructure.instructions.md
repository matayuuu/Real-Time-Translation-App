---
description: Terraform と PowerShell の対象範囲・確認手順を維持する。
applyTo: "infra/realtime-translation/**,scripts/*.ps1"
---

# インフラとライフサイクル

- Terraform は `infra/realtime-translation` の独立 root と既存の AzAPI を使う。
  provider、model、region、SKU、capacity の制約を無断で置換・緩和しない。
- 既存 resource group だけを対象にし、resource group の作成・削除、
  provider 登録、subscription scope の RBAC を追加しない。
- ownership tag、決定的な命名、resource-scoped RBAC、機密値を出力しない契約を維持する。
- PowerShell 7 の既存パラメーター、エラー処理、saved plan の表示、
  `APPLY` / `DESTROY` の完全一致確認を維持する。
- recovery は明示 opt-in のままにし、所有権・型・場所・SKU の一致しないリソースを import しない。
- context は既存の他キーを保持し、完了後に原子的に書き込む。
  context と Terraform state/plan は Git に含めない。
- 検証は既存の PowerShell 構文検査、pytest 契約テスト、
  `terraform fmt -check`、backend 無効の init と validate を使う。
  テストや調査のために setup/destroy/apply を実行しない。
- 変更時は `tests/contract` と利用ガイドの契約も更新する。

公式仕様: [Terraform fmt](https://developer.hashicorp.com/terraform/cli/commands/fmt)、
[Terraform validate](https://developer.hashicorp.com/terraform/cli/commands/validate)。
