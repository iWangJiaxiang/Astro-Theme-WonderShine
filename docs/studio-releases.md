# WonderShine Studio App 构建、发行与更新

Studio 使用 `.github/workflows/studio.yml`。**构建、打包、单元测试和浏览器测试在 GitHub Actions 执行，不在开发电脑上运行。** 本地修改源码即可，无需安装 Android SDK、Xcode 或执行 Tauri 打包。

Release 标题统一为 `WonderShine Studio X.Y.Z`，例如 `WonderShine Studio 0.2.0`；版本标签使用 `studio-vX.Y.Z`。

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
| Android | ARM64、ARMv7、x86、x64 | debug APK | 固定密钥签名的 APK、AAB |
| iOS | Apple Silicon 模拟器 / 真机 ARM64 | 未签名模拟器 `.app.tar.gz` | App Store 签名 IPA；可选上传 TestFlight |

桌面未签名安装包可能被系统拦截；当前工作流没有声称它们已经获得 Windows/macOS 签名或 macOS 公证。移动正式发行不会退化成 unsigned/debug 包。iOS 模拟器包不能装在真机，App Store IPA 也不能像 APK 一样公开侧载。

GitHub Releases 是当前桌面/Android 的部署入口；Google Play 上架需要另外将 AAB 提交到 Play Console。iOS IPA 通过 App Store Connect/TestFlight 分发，商店审核和公开上架不会由本工作流自动完成。

## 构建与发布边界

Studio 支持全平台构建和独立 iOS 构建。独立 iOS 的 TestFlight 上传只依赖 Studio 验证和 iOS 构建，不依赖桌面或 Android，也不创建 GitHub Release。全平台发行仍要求全部平台成功；其中启用的 TestFlight 上传可在其他平台完成前执行。

签名和上传凭据仅通过 GitHub Secrets 注入。签名产物自身仍可能包含 Apple Team ID，Secret 配置不意味着产物匿名化。

完整 GitHub Release 使用 `studio-release.json` 标记完成。独立 TestFlight 构建没有此标记，不触发基于 GitHub Release 的 App 更新提醒。模拟器验证也不代表真实证书签名或 TestFlight 上传已验证。

## App 更新体验

原生 App 启动 3 秒后检查；保持打开时每 6 小时检查一次，恢复到前台也按该间隔判断。检查使用 GitHub 的公开 Release API，与用户连接的内容仓库无关，不发送内容仓库凭据。

- 仅检查当前发行仓库的 `studio-v` 稳定版本，有完成标记才提示。
- 自动检查网络失败不打断写作；底部「检查更新」提供手动重试。
- 支持「稍后」「跳过此版本」；手动检查可以重新显示跳过的版本。
- 「查看更新」用系统浏览器打开 Release / iOS 分发页面，不替换当前页面，不丢失编辑内容。
- 这是**自动检查与提醒**，不是后台下载、静默安装或强制重启。

fork 的 CI 默认通过 `github.repository` 指向自己的 Release；直接源码运行默认指向上游。自定义构建可以设置 `VITE_STUDIO_RELEASE_REPOSITORY=owner/repo`。目前只支持公开 GitHub Release；私有仓库 API 需要认证，不会自动取得用户内容仓库 token。

## 验证范围

构建、测试与打包仅在远程 CI 执行。实际平台结果以对应源码提交的 CI 记录为准；模拟器构建、真实签名、TestFlight 上传和真机安装分别验收。操作步骤与运行记录不纳入此文档。
