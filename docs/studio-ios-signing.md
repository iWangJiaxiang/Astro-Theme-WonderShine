# iOS 签名材料准备

当前 GitHub Actions 使用导出的本地 Distribution 签名材料；不读取开发电脑的 Xcode 账户。所有值自行添加到仓库 Settings → Secrets and variables → Actions → Secrets，不提交到 Git，也不发送给 AI。

## 已有 Xcode 证书时

打开「钥匙串访问 → 登录 → 我的证书」，找到有效的 **Apple Distribution** 证书，展开确认下面有对应私钥。满足这些条件即可复用，无需重新生成 CSR 或申请新证书。

- `Apple Development` 用于开发，不能替代本流程的 Distribution 证书。
- 只有 `.cer`、没有对应私钥时，从最初生成密钥的 Mac 导出 `.p12`，或创建新的 Distribution 证书；重新下载 `.cer` 不会补回私钥。
- Xcode 云端托管的签名证书不等于本机持有私钥。若钥匙串中没有可导出的签名身份，为当前手动签名流程准备本地 Distribution 证书，无需撤销已有证书。

选中证书及对应私钥，右键导出，选择 `.p12` 格式。设置一个非空导出密码并保存：这就是 `IOS_CERTIFICATE_PASSWORD`，不是 Apple ID 或 Mac 登录密码。若无法选择 `.p12`，检查是否位于「我的证书」并包含私钥。

## 尚无可导出的 Distribution 证书

1. 在 Mac「钥匙串访问 → 证书助理 → 从证书颁发机构请求证书」生成 CSR，选择保存到磁盘。
2. Apple Developer → Certificates → 添加 **Apple Distribution**，上传 CSR。
3. 下载 `.cer` 并导入生成 CSR 的同一台 Mac，再按上节导出包含私钥的 `.p12`。

## 获取描述文件

已有描述文件只有同时满足以下条件才可复用：有效的 **App Store Connect** 类型、同一 Team、App ID 对应 `wang.jiaxiang.wondershine-studio`，并包含上面导出的 Distribution 证书。开发或 Ad Hoc 描述文件不适用于此流程。

若没有匹配文件，以 Account Holder 或 Admin 身份进入 Apple Developer → Certificates, Identifiers & Profiles → Profiles：

1. 点击 `+`，在 Distribution 中选 **App Store Connect**。
2. 选择与 `wang.jiaxiang.wondershine-studio` 对应的 App ID。
3. 选择刚才导出的那张 Distribution 证书。
4. 命名并 Generate，Download 得到 `.mobileprovision`。

## 填入 GitHub Secrets

在自己的 Mac 终端运行，替换为实际路径。每次命令会将内容复制到剪贴板，直接粘贴到对应 Secret，不在终端打印凭据。

```sh
base64 -i "/你的路径/distribution.p12" | pbcopy
```

粘贴为 `IOS_CERTIFICATE`；将导出 `.p12` 时自己设置的密码直接填入 `IOS_CERTIFICATE_PASSWORD`，密码不做 Base64。

```sh
base64 -i "/你的路径/profile.mobileprovision" | pbcopy
```

粘贴为 `IOS_MOBILE_PROVISION`。

此外填写 `APPLE_DEVELOPMENT_TEAM` Secret（原始 Team ID），以及上传所需的 `APPLE_API_ISSUER`、`APPLE_API_KEY`、`APPLE_API_KEY_BASE64`。API `.p8` 用于上传认证，与签名 `.p12` 不是同一个文件。

配置完成后，Actions → Studio apps & release → Run workflow → `target=ios` → 填写版本 → 勾选 `publish`，即可执行签名和 TestFlight 上传。首次运行仍需验证证书有效性、Apple 权限及商店应用记录。

## 官方参考

- [Tauri iOS Code Signing](https://v2.tauri.app/distribute/sign/ios/)
- [Apple：Cloud-managed certificates](https://developer.apple.com/help/account/certificates/cloud-managed-certificates/)
- [Apple：创建 App Store Connect provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/)
- [Apple：创建 CSR](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/)
