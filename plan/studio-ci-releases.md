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
- [ ] 远程 CI 实跑（当前仓库未推送，已有不推送约束）。

## 验证边界

本轮仅做静态检查，运行与打包测试全部留给 GitHub Actions。远端仓库当前没有默认分支、工作流或签名配置；不能声称远程构建已通过。保留本地已有未提交更改，不提交、不推送、不创建远端 Release。

## 本轮验收记录

- `tsc --noEmit`、Node 脚本语法、YAML 解析和 actionlint 通过；未执行任何本地构建/打包/单元或浏览器测试。
- 新增远程测试：版本注入、标签校验、产物缺失/误用debug包、更新版本比较、撤回版本、跳过/手动检查、三尺寸截图。
- 独立 reviewer 静态复核通过；修复发布中断后的重试顺序、iOS build number 四段问题、撤回后旧更新卡片残留。
- 桌面当前没有 Windows/macOS 商业代码签名；移动正式发行强制要求签名，文档明确 App Store/TestFlight 分发限制。
- 工作流未推送或运行；没有创建远端标签/Release；实际平台通过状态待远程验收。

## 2026-11-01 首次远程验收

- 用户已授权推送；`feat/studio-react-workspaces` 已推送，首次源码 SHA `39b1e98`，Studio run `41264678950`，主题 run `41264678946`。
- 首次 push 被 Twikoo 第三方管理界面的示例凭据格式拦截；保留本地历史 bundle 后，将两处 placeholder 改为明确的 YOUR_TENCENT_SECRET_ID/KEY，并仅重写尚未发布的历史，未绕过保护。
- 首轮远程 Studio 197 项单测、4 项发行脚本测试通过。Android SDK 初始化、iOS 空 Team ID、Ubuntu Chrome namespace 环境问题已定位，修复后继续远程验证。
- 全程没有本地构建、打包或测试；不创建正式 Release。
