# WonderShine Studio App 构建、发行与更新

Studio 使用 `.github/workflows/studio.yml`。**构建、打包、单元测试和浏览器测试在 GitHub Actions 执行，不在开发电脑上运行。** 本地修改源码即可，无需安装 Android SDK、Xcode 或执行 Tauri 打包。

Release 标题统一为 `WonderShine Studio X.Y.Z`，例如 `WonderShine Studio 0.2.0`；版本标签使用 `studio-vX.Y.Z`。

所有新发行（包括稳定版、预发布及 TestFlight 发布）仅允许从远端 `main` 的已验证提交创建。必须先合入发行代码和版本变更、通过对应远程验证，再创建 `studio-v*` tag 和 GitHub Release（target 为 `main`），或从 `main` 启动 TestFlight 发布。禁止从 feature 或其他非 main 分支创建新发行。非 main 分支可以执行不发布的构建与验证；已发布 tag 和发行不可移动、覆盖或重发。此规则与主题发行一致。

应用的 Tauri bundle ID 为 `wang.jiaxiang.wondershine-studio`。iOS 使用此 ID；Tauri 的 Android 生成器会把连字符转成下划线，因此 Android applicationId 为 `wang.jiaxiang.wondershine_studio`。注册 App Store Connect / Play Console 应用、签名或配置更新时，应使用对应平台的 ID。

### 从旧开发包迁移

旧开发包的 ID 是 `me.wondershine.studio`。更换 ID 后，系统会将新包视为另一个应用，不能假定会覆盖安装、共享 WebView 数据或自动读取旧 AppData；商店中已有的旧 ID 也不能直接改名。本次没有删除、搬移或合并旧应用数据。

升级前，使用旧 App 提交或备份未保存内容。新 App 可以重新选择原有本地仓库文件夹；远程缓存仓库中未推送的 Git 提交和未提交文件需从旧 AppData 的 `workspaces/<id>/repo` 备份后导入，重新克隆远程仓库不会带回这些本地内容。macOS 旧目录为 `~/Library/Application Support/me.wondershine.studio`，新目录为 `~/Library/Application Support/wang.jiaxiang.wondershine-studio`；其他平台以 Tauri 的 AppData 目录为准。Git/API 凭据和设备设置需在新 App 中重新配置。确认新 App 中内容完整前，保留旧目录与旧 App。

## 平台与产物

| 平台 | 架构 | 代码变更构建 | 正式 Release |
| --- | --- | --- | --- |
| Windows | x64、ARM64 | NSIS `.exe` | `.exe`，当前未配置 Windows 代码签名 |
| macOS | Intel、Apple Silicon | `.dmg` | `.dmg`，当前未配置 Developer ID 签名及公证 |
| Linux | x64、ARM64 | `.deb`、`.rpm`、`.AppImage` | 同左 |
| Android | ARM64、ARMv7、x86、x64 | debug APK | 固定密钥签名的通用 APK |
| iOS | Apple Silicon 模拟器 / 真机 ARM64 | 模拟器验收；启用自动 TestFlight 时另产签名 IPA | App Store 签名 IPA；可选上传 TestFlight |

桌面未签名安装包可能被系统拦截；当前工作流没有声称它们已经获得 Windows/macOS 签名或 macOS 公证。移动正式发行不会退化成 unsigned/debug 包。iOS 模拟器包不能装在真机，App Store IPA 也不能像 APK 一样公开侧载。

GitHub Releases 是当前桌面/Android 的部署入口；Google Play 上架需要另行构建并提交 AAB。iOS IPA 通过 App Store Connect/TestFlight 分发，商店审核和公开上架不会由本工作流自动完成。

## 构建与发布边界

Studio 支持全平台构建和独立 iOS 构建。独立 iOS 的 TestFlight 上传只依赖 Studio 验证和 iOS 构建，不依赖桌面或 Android，也不创建 GitHub Release。全平台发行仍要求全部平台成功；其中启用的 TestFlight 上传可在其他平台完成前执行。

iOS 构建与 TestFlight 上传使用 GitHub Actions 的 `xcode-27` runner 和 Xcode 27.2。为满足 Apple 自 2027 年 4 月起的提交要求，CI 在构建前检查设备 SDK，并在上传前从签名 IPA 的 `Info.plist` 读取 `DTSDKName`；两处均要求 iPhoneOS SDK 27 或更高版本。启动验收在独立的 `macos-15` runner 上，将同一提交用 Xcode 27.2 编译的模拟器 App 安装到 iOS 26 模拟器，检查浅色和深色界面。

仓库变量 `STUDIO_UPLOAD_TESTFLIGHT=true` 启用自动内测。每次推送到 `main`，CI 比较本次推送前后的提交；`apps/studio/` 中除 Markdown 文档和 `tests/` 目录以外的文件发生变更时，构建签名 IPA。Studio 验证、模拟器启动和 IPA 检查都通过后，CI 上传同一提交的 IPA，并查询 Apple 处理状态。PR 和功能分支仅验证，测试组沿用 App Store Connect 配置。

自动内测的版本号取自 Studio 包。每次 TestFlight 分发在签名前查询 App Store Connect 当前 iOS 版本的构建和上传记录。新版本从 build `1` 开始，同版本使用历史最高构建号的下一个整数，例如旧编号 `299.1` 接续为 `300`。查询失败时中止签名。若上传失败且需要重新分配构建号，在 `main` 手动启动新的 Studio workflow，选择 `target=ios` 和 `publish=true`。不上传 TestFlight 的 CI 构建继续使用工作流运行序号和重试次数。

签名和上传凭据仅通过 GitHub Secrets 注入。签名产物自身仍可能包含 Apple Team ID，Secret 配置不意味着产物匿名化。

完整 GitHub Release 使用 `studio-release.json` 标记完成。独立 TestFlight 构建没有此标记，不触发基于 GitHub Release 的 App 更新提醒。模拟器验证也不代表真实证书签名或 TestFlight 上传已验证。

## App 更新体验

原生 App 启动 3 秒后检查；保持打开时每 6 小时检查一次，恢复到前台也按该间隔判断。检查使用 GitHub 的公开 Release API，与用户连接的内容仓库无关，不发送内容仓库凭据。

- 仅检查当前发行仓库的 `studio-v` 稳定版本，有完成标记才提示。
- 自动检查网络失败不打断写作；连接页展开「WonderShine Studio」后可查看版本、手动检查更新。
- 支持「稍后」「跳过此版本」；手动检查可以重新显示跳过的版本。
- 在连接页展开「WonderShine Studio」，或在工作区的「界面设置」中切换本机的「自动下载更新，安装前确认」。默认开启。关闭后点击「下载并安装」才下载。安装前需要保存编辑并等待上传、保存和 Git 操作完成。
- Windows NSIS、macOS App 和 Linux AppImage、deb、rpm 按当前架构及安装格式下载。Tauri updater 校验签名和签名中记录的版本。确认安装后桌面会重启，系统包管理器可要求授权。
- Android 使用 GitHub Release 的通用 APK。自动下载要求非计费网络；计费网络可以手动下载。应用展示大小和下载进度，按完成清单核对 SHA-256，再核对 APK 包名、签名证书以及递增的版本代码。首次安装可能要在系统设置允许 Studio 安装未知应用；返回 Studio 后再次点击安装。取消后可以重试。正式包和 debug 包的签名不同。
- iOS 继续通过 TestFlight 或 App Store 更新。旧客户端首次升级使用既有的发行页入口。若新版客户端遇到较早的发行清单，也可打开发行页。

### 桌面签名与清单

在受信任的机器上运行 `npm exec -w @wondershine/studio -- tauri signer generate -w <密钥保存路径>`，设置密码并安全备份私钥和密码。将公钥文件中的完整编码值设为 GitHub Actions 仓库变量 `STUDIO_UPDATER_PUBLIC_KEY`，将私钥文件内容和密码分别设为 Secrets `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。同一发行渠道需持续使用同一密钥；fork 正式发行使用自己的密钥。PR 和普通 push 构建使用 runner 的临时密钥。

发行工作流收集各平台更新包和 `.sig`，核对签名的 key ID 与构建内置公钥，生成每个 Studio tag 专属的 `studio-updater.json`。最后上传 `studio-release.json`，内含 APK 大小及 SHA-256。更新检查仅使用带完成标记的稳定版本。桌面更新签名与 Windows 代码签名、macOS 公证分别配置。

fork 的 CI 默认通过 `github.repository` 指向自己的 Release；直接源码运行默认指向上游。自定义构建可以设置 `VITE_STUDIO_RELEASE_REPOSITORY=owner/repo`。目前只支持公开 GitHub Release；私有仓库 API 需要认证，不会自动取得用户内容仓库 token。

## 验证范围

构建、测试与打包仅在远程 CI 执行。实际平台结果以对应源码提交的 CI 记录为准；模拟器构建、真实签名、TestFlight 上传和真机安装分别验收。操作步骤与运行记录不纳入此文档。
