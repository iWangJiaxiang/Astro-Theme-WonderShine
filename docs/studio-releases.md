# WonderShine Studio App 构建、发行与更新

Studio 使用 `.github/workflows/studio.yml`。**构建、打包、单元测试和浏览器测试在 GitHub Actions 执行，不在开发电脑上运行。** 本地修改源码即可，无需安装 Android SDK、Xcode 或执行 Tauri 打包。

Release 标题统一为 `WonderShine Studio X.Y.Z`，例如 `WonderShine Studio 0.2.0`；版本标签使用 `studio-vX.Y.Z`。

## 触发方式

| 事件 | 结果 |
| --- | --- |
| Push / PR 修改 `apps/studio/**`、`packages/**`、根 package/lock 或 Studio workflow | 远程测试、全平台构建，保存 Actions artifacts；不创建 Release |
| 发布标签为 `studio-vX.Y.Z` 的稳定 GitHub Release | 构建正式安装包，上传到该 Release |
| Actions → **Studio apps & release** → **Run workflow** | 可输入 `0.2.0`，勾选 `publish` 后自动创建并发布 Release；不勾选只构建 |

`workflow_dispatch` 需要先把工作流推送到默认分支。首次推送后可在 Actions 页面查看远程构建与测试记录。`studio-v` 与主题包的标签区分；主题 Release 不触发 App 发行。首版只发布稳定版本，不将 prerelease 推送给普通用户。

手动入口固定所选分支的提交 SHA；已有标签必须指向相同 SHA。所有 runner 都 checkout 同一 SHA。版本只在 runner 上注入 Studio package、Tauri 配置及 Cargo/package lock，不改主题版本、不回写 Git。版本要求三个数字，major 不超过 2000，minor/patch 不超过 99；建议从 `0.1.0` 递增。

## 平台与产物

| 平台 | 架构 | 代码变更构建 | 正式 Release |
| --- | --- | --- | --- |
| Windows | x64、ARM64 | NSIS `.exe` | `.exe`，当前未配置 Windows 代码签名 |
| macOS | Intel、Apple Silicon | `.dmg` | `.dmg`，当前未配置 Developer ID 签名及公证 |
| Linux | x64、ARM64 | `.deb`、`.rpm`、`.AppImage` | 同左 |
| Android | ARM64、ARMv7、x86、x64 | debug APK | 固定密钥签名的 APK、AAB |
| iOS | Apple Silicon 模拟器 / 真机 ARM64 | 未签名模拟器 `.app.tar.gz` | App Store 签名 IPA；可选上传 TestFlight |

桌面未签名安装包可能被系统拦截；当前工作流没有声称它们已经获得 Windows/macOS 签名或 macOS 公证。移动正式发行不会退化成 unsigned/debug 包。iOS 模拟器包不能装在真机，App Store IPA 也不能像 APK 一样公开侧载。

GitHub Releases 是当前桌面/Android 的部署入口；Google Play 上架需要另外将 AAB 提交到 Play Console。iOS IPA 通过 App Store Connect/TestFlight 分发，商店审核和公开上架不会由本工作流自动完成。

## 首次发行配置

在仓库 Settings → Secrets and variables → Actions 配置，密钥不写入代码、不发给 AI。

### Android（正式发行必填）

| Secret | 含义 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Java keystore 文件的 base64 |
| `ANDROID_STORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 签名 key alias |
| `ANDROID_KEY_PASSWORD` | key 密码，可与 store 密码不同 |

密钥需要长期备份并保持一致，否则已安装版本不能原地升级。CI 在临时目录解码 keystore，通过环境变量配置生成的 Gradle 工程，并在结束时移除临时文件。不要使用调试密钥作为正式发行密钥。Android `versionCode` 从版本号生成；每个新版本必须递增。

### iOS（正式发行必填）

先在 Apple Developer / App Store Connect 登记 `me.wondershine.studio`（fork 自用请同时修改 Tauri identifier 和 Apple 登记信息）。

| 配置 | 类型 | 含义 |
| --- | --- | --- |
| `APPLE_DEVELOPMENT_TEAM` | Variable | Apple Team ID |
| `IOS_CERTIFICATE` | Secret | 导出的 Apple Distribution `.p12` 的 base64 |
| `IOS_CERTIFICATE_PASSWORD` | Secret | `.p12` 密码 |
| `IOS_MOBILE_PROVISION` | Secret | 与 identifier、证书匹配的 App Store Connect provisioning profile 的 base64 |

Tauri CLI 负责导入签名材料及构建。独立设置 iOS `bundleVersion=run_number.run_attempt`，不往三段营销版本后追加第四段；重跑构建有新的 build number。首次证书验证在远程构建时进行；仅检查 Secret 存在不代表证书有效。

### 自动上传 TestFlight（可选）

设置 Variable `STUDIO_UPLOAD_TESTFLIGHT=true`，并配置 Secrets `APPLE_API_ISSUER`、`APPLE_API_KEY`（Key ID）、`APPLE_API_KEY_BASE64`（`.p8` 内容的 base64）。上传在所有构建及测试成功后进行；失败会阻止 Release 完成标记上传。Apple 后台仍需处理构建并配置测试员，CI 上传成功不代表立即可安装或通过审核。

Variable `STUDIO_IOS_UPDATE_URL` 可填 App Store 页面或 TestFlight 邀请链接，只允许 `https://apps.apple.com/…` 或 `https://testflight.apple.com/…`。没有配置时 App 打开 GitHub Release 说明页。该地址是在构建时写入 App 的，变更后需要重新发行。

## 发布过程与失败恢复

1. 先验证版本、标签源提交及 Android/iOS 必需签名配置。
2. 远程运行 Studio 单元测试、浏览器测试与截图；并行构建八个平台/架构产物。
3. 每个平台记录源 SHA、版本、文件名和 SHA-256。最终发布任务验证各平台产物来自同一源码版本。
4. 上传安装包及 `SHA256SUMS`。手动发布时创建 draft，上传完成后将其公开。
5. 最后上传 `studio-release.json` 完成标记，App 才会提示该版本。

如果部分构建失败，修复后重跑失败任务或从相同提交重跑工作流。如果 Apple 已接收 IPA 但上传任务的最终状态不明确，需要重跑 iOS 构建及后续任务以取得新的 build number，避免重复上传同一构建。安装包上传/公开过程失败时，Release 可能已存在但没有完成标记；按同一提交重跑可以补全。已经有完成标记的版本不可覆盖，应发布新的版本号。

手工在 GitHub 上先发布的 Release 在构建结束前会公开但缺少安装包，建议优先用 Actions 的 `publish` 入口。用工作流 token 创建的 Release 不会再次触发工作流；当前任务已经完成构建和上传，无需二次触发。

CI 默认只读权限，最终上传任务单独获得 `contents: write`。PR 构建不使用发行 Secret，没有 `pull_request_target`。不把仓库 token 或用户 Git token 嵌入 App。

## App 更新体验

原生 App 启动 3 秒后检查；保持打开时每 6 小时检查一次，恢复到前台也按该间隔判断。检查使用 GitHub 的公开 Release API，与用户连接的内容仓库无关，不发送内容仓库凭据。

- 仅检查当前发行仓库的 `studio-v` 稳定版本，有完成标记才提示。
- 自动检查网络失败不打断写作；底部「检查更新」提供手动重试。
- 支持「稍后」「跳过此版本」；手动检查可以重新显示跳过的版本。
- 「查看更新」用系统浏览器打开 Release / iOS 分发页面，不替换当前页面，不丢失编辑内容。
- 这是**自动检查与提醒**，不是后台下载、静默安装或强制重启。

fork 的 CI 默认通过 `github.repository` 指向自己的 Release；直接源码运行默认指向上游。自定义构建可以设置 `VITE_STUDIO_RELEASE_REPOSITORY=owner/repo`。目前只支持公开 GitHub Release；私有仓库 API 需要认证，不会自动取得用户内容仓库 token。

## 验证状态

构建与测试在 GitHub Actions 执行，本机只做静态检查。平台安装包和运行测试以对应源码提交的 CI 结果为准；签名与 TestFlight 上传需要另行配置正式发行凭据。模拟器构建使用占位 Team ID 并明确跳过签名，正式发行必须使用真实 Team ID。
