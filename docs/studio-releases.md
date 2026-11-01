# WonderShine Studio App 构建、发行与更新

Studio 使用 `.github/workflows/studio.yml`。**构建、打包、单元测试和浏览器测试在 GitHub Actions 执行，不在开发电脑上运行。** 本地修改源码即可，无需安装 Android SDK、Xcode 或执行 Tauri 打包。

Release 标题统一为 `WonderShine Studio X.Y.Z`，例如 `WonderShine Studio 0.2.0`；版本标签使用 `studio-vX.Y.Z`。

应用的 Tauri bundle ID 为 `wang.jiaxiang.wondershine-studio`。iOS 使用此 ID；Tauri 的 Android 生成器会把连字符转成下划线，因此 Android applicationId 为 `wang.jiaxiang.wondershine_studio`。注册 App Store Connect / Play Console 应用、签名或配置更新时，应使用对应平台的 ID。

### 从旧开发包迁移

旧开发包的 ID 是 `me.wondershine.studio`。更换 ID 后，系统会将新包视为另一个应用，不能假定会覆盖安装、共享 WebView 数据或自动读取旧 AppData；商店中已有的旧 ID 也不能直接改名。本次没有删除、搬移或合并旧应用数据。

升级前，使用旧 App 提交或备份未保存内容。新 App 可以重新选择原有本地仓库文件夹；远程缓存仓库中未推送的 Git 提交和未提交文件需从旧 AppData 的 `workspaces/<id>/repo` 备份后导入，重新克隆远程仓库不会带回这些本地内容。macOS 旧目录为 `~/Library/Application Support/me.wondershine.studio`，新目录为 `~/Library/Application Support/wang.jiaxiang.wondershine-studio`；其他平台以 Tauri 的 AppData 目录为准。Git/API 凭据和设备设置需在新 App 中重新配置。确认新 App 中内容完整前，保留旧目录与旧 App。

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

先在 Apple Developer / App Store Connect 登记 `wang.jiaxiang.wondershine-studio`（fork 自用请同时修改 Tauri identifier 和 Apple 登记信息）。

| 配置 | 类型 | 含义 |
| --- | --- | --- |
| `APPLE_DEVELOPMENT_TEAM` | Secret | Apple Team ID，直接填写原值，不做 Base64 编码 |
| `IOS_CERTIFICATE` | Secret | 导出的 Apple Distribution `.p12` 的 base64 |
| `IOS_CERTIFICATE_PASSWORD` | Secret | `.p12` 密码 |
| `IOS_MOBILE_PROVISION` | Secret | 与 identifier、证书匹配的 App Store Connect provisioning profile 的 base64 |

Tauri CLI 负责导入签名材料及构建。独立设置 iOS `bundleVersion=run_number.run_attempt`，不往三段营销版本后追加第四段；重跑构建有新的 build number。首次证书验证在远程构建时进行；仅检查 Secret 存在不代表证书有效。

`APPLE_DEVELOPMENT_TEAM` 统一从 repository secret 读取，不回退读取同名 Variable。若之前配置在 Variables 中，先创建同名 Secret，再删除旧 Variable。不要在日志或示例配置中输出真实值；模拟器构建继续使用占位 Team ID。

Secret 能保护 Actions 配置，并让 GitHub 对日志中匹配的值自动遮罩，但不保证对变换后的值同样有效，也不会清除签名 IPA 内的 Team ID。Apple 的签名 entitlements / provisioning profile 可能包含团队标识；此配置不提供签名产物匿名化。参见 [GitHub Secrets](https://docs.github.com/en/actions/concepts/security/secrets) 和 [Apple provisioning profiles](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles)。

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

2026-11-01 检查的 Studio run `41266954914` 有 11 条 warning：10 条来自 Actions 使用已退役的 Node 20 runtime，1 条来自 `setup-java@v4` 退役。工作流已升级到声明 Node 24 runtime 的版本：checkout 7.0.1、setup-node 7.1.0、setup-java 6.1.0、upload-artifact 7.0.2、download-artifact 8.0.2、setup-android 4.0.4、setup-gradle 6.4.1、setup-chrome 2.2.0。Theme workflow 固定 `ubuntu-24.04`，避免 `ubuntu-latest` 镜像迁移造成未经验证的环境变化。

该 run 的另外 3 条 notice 是 GitHub 的 macOS ARM64 runner 容量排队提醒，不是项目版本错误；升级 Actions 不保证消除平台排队提示。以上版本依据各 Actions 官方 release 和 `action.yml` 核对，实际构建兼容性由新提交的远程 CI 验证。

2026-11-01 升级后 run `41271484308`（源码 `d3db703fc893c649f9922fd8cc62c3e5a6711372`）全部通过：Studio 验证、Windows/macOS/Linux 的 x64 与 ARM64、Android debug APK、iOS simulator app。重新读取 check-run annotations 确认 warning 从 11 条降至 0 条，3 条平台 capacity notice 仍存在。完整前后记录见 `plan/actions-annotations-2026-11-01.json`。
