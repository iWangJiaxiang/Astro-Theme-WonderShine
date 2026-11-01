# Studio CI 与 App 发行

## 已确定的行为

- Studio 代码、依赖锁文件、相关工作流变化时远程验证及打包；本机不运行构建、打包或测试。
- GitHub Release 的 `studio-vX.Y.Z` 标签触发全平台正式构建；Actions 手动入口可指定版本并发布。
- Windows x64/ARM64、macOS Intel/Apple Silicon、Linux x64/ARM64、Android、iOS 分开构建。
- Android 日常构建为 debug APK；iOS 日常构建为未签名模拟器 App。正式发行要求 Android/iOS 签名。
- 所有构建和测试成功后发布安装包、校验和与最终完成标记。App 仅提示完整稳定版本，不强制安装、不重启。
- 自动检查只存在于原生 App；使用现有 native HTTP 与受限的外部链接权限。
- GitHub Releases 提供桌面/Android 下载；iOS 需要 TestFlight/App Store 分发，IPA 仅为发行产物。

## 进度

- [x] 读取当前工作流、Tauri CLI、官方签名文档与远端配置。
- [x] 远程 CI、版本注入、签名及 Release 发布脚本。
- [x] 原生 App 更新提示与手动检查。
- [x] 测试用例、配置文档、静态校验及独立代码审查。
- [x] 远程 CI 实跑：`41265683995` 全平台通过；后续优化的最终回归见下方记录。

## 验证边界

本地只做静态检查，运行与打包测试全部由 GitHub Actions 执行。用户于 2026-11-01 授权提交、推送与远程 CI 修复，分支为 `feat/studio-react-workspaces`。本轮不创建正式 Release，未验证移动端正式签名发行。

## 本轮验收记录

- `tsc --noEmit`、Node 脚本语法、YAML 解析和 actionlint 通过；未执行任何本地构建/打包/单元或浏览器测试。
- 新增远程测试：版本注入、标签校验、产物缺失/误用debug包、更新版本比较、撤回版本、跳过/手动检查、三尺寸截图。
- 独立 reviewer 静态复核通过；修复发布中断后的重试顺序、iOS build number 四段问题、撤回后旧更新卡片残留。
- 桌面当前没有 Windows/macOS 商业代码签名；移动正式发行强制要求签名，文档明确 App Store/TestFlight 分发限制。
- 初始实现阶段未推送；随后按用户授权完成远程验收，结果记录如下。没有创建远端标签/Release。

## 2026-11-01 首次远程验收

- 用户已授权推送；`feat/studio-react-workspaces` 已推送，首次源码 SHA `39b1e98`，Studio run `41264678950`，主题 run `41264678946`。
- 首次 push 被 Twikoo 第三方管理界面的示例凭据格式拦截；保留本地历史 bundle 后，将两处 placeholder 改为明确的 YOUR_TENCENT_SECRET_ID/KEY，并仅重写尚未发布的历史，未绕过保护。
- 首轮远程 Studio 197 项单测、4 项发行脚本测试通过。Android SDK 初始化、iOS 空 Team ID、Ubuntu Chrome namespace 环境问题已定位，修复后继续远程验证。
- 全程没有本地构建、打包或测试；不创建正式 Release。

## 2026-11-01 全平台通过与优化回归

- `96ab4e5`：修复 Android SDK packages、iOS simulator Team ID 及 Ubuntu Chrome sandbox 环境；主题 CI `41265261166` 通过。
- `33f5db1`：添加 Tauri 移动工程需要的 `npm run tauri` 回调。Studio CI `41265683995` 全部通过：197 项 Studio 单测、4 项发行脚本测试、浏览器回归、六桌面目标、Android debug APK 和 iOS ARM64 simulator bundle。
- 已确认八个平台 artifact 和浏览器截图 artifact 存在；没有在本地下载安装包。
- `4233edc`：根据远程截图修复更新提示主按钮背景，并加入可见性断言。
- `a6bcd9e`：应用 tauri-skills 检查结果，优化按需加载、移动端返回导航与桌面窗口恢复。独立静态审查无阻塞问题；最终远程回归 `41266411593` 全部通过，包含 197 + 4 项测试、浏览器回归与八个平台的打包目标。TestFlight 和正式发布任务按预期跳过。
- 目视检查已确认更新按钮正常；发现 Ubuntu runner 缺中文字体，连接页截图出现方框。补齐两套浏览器 CI 的 CJK/emoji 字体后重跑截图验收。
