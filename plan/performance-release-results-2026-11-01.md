# 性能优化与发布流程验收（2026-11-01）

## 范围与测量口径

本轮在 `Astro-Theme-WonderShine` 的 `feat/studio-react-workspaces` 分支实施并推送。所有构建、单元/浏览器测试与 App 打包均在 GitHub Actions 执行，本地只编辑文件、检查静态语法、读取远程日志与截图。

使用与基线相同的五个 demo 页面、Lighthouse 13.6.0、Ubuntu 24.04、生产构建及 Astro preview。每页每设备运行三次冷启动，选 Performance 分数居中的一次，其余指标也取自同一次运行。没有修改这五页的文章正文；主题链接文字及可访问性样式按发现的问题修复。新增的代码交互测试页不进入文章列表，也不参与测分。

这不是个人博客部署后的线上成绩。真实 CDN、网络、个人图片及第三方服务仍须在个人站部署后测量；实验室 TBT 不能替代真实 INP。

## 已实施的优化

- **首屏 JavaScript**：Prism 在构建时按需加载语言并生成高亮 HTML；浏览器只保留复制、折叠和行号交互。KaTeX、TOC、阅读模式、摘要、CountUp 等按页面条件加载。jQuery / utils / Pace 保持依赖顺序并推迟执行。
- **按需交互**：导航音乐在首次播放意图时加载播放器及播放列表；音乐专页仍直接初始化。二维码在用户接触分享入口时加载；最新评论等可见后请求；瀑布流按页面元素加载。清理了无使用的 Clipboard 全局库。
- **导航安全**：保留 ClientRouter、首次 Loading 和页面切换 Loading。处理持久音乐播放器、按页 CSS、动态 Fancybox、重复监听与导航后过期回调。Fancybox 不再拼接未经转义的 caption 到 HTML。
- **渲染与布局**：CSS 分成基础与页面样式，避免重复下载整站 CSS；时间线筛选栏由服务端预留位置，初始化不再无条件重插列表；摘要保留首屏文本，暗色星空在亮色、后台与减少动画模式暂停。
- **图片**：普通 Markdown、shortcode 与组件支持 AVIF/WebP、`srcset/sizes` 和已知宽高；lazy 图片使用 `auto` 加兼容 fallback；小图不放大，灯箱保留原图。补充头像、Footer、Loading、背景覆盖，恢复 `avif_enable` 的编码及渲染开关，缓存 recipe 包含此开关。
- **无障碍与 SEO**：补作者链接名称，修摘要/订阅/目录对比度、分类点击范围和英文含糊链接文字。目录去除非当前条目的模糊与半透明处理，并支持键盘焦点。
- **构建成本**：CI 缓存图片编码结果，按 lockfile、编码器与内容 recipe 隔离；缓存环境只作用于构建步骤，不干扰测试的临时目录。

完整诊断确认旧时间线的 LCP 是引用卡片的文字标题，不是封面图；原 Prism 执行占用约 848 ms。此次根据这些证据减少首屏执行与列表重排，没有对所有图片强行提前加载。

## Lighthouse 结果

| 页面 | 手机 Performance | 桌面 Performance | 手机 LCP | 手机 TBT |
|---|---:|---:|---:|---:|
| 英文首页 | 77 → **100** | 92 → **100** | 1.9 s → 1.4 s | 920 ms → 0 ms |
| 文章 | 72 → **96** | 89 → **100** | 2.9 s → 2.7 s | 970 ms → 0 ms |
| 时间线 | 55 → **100** | 91 → **100** | 5.5 s → 1.4 s | 1,000 ms → 0 ms |
| 系列详情 | 72 → **97** | 91 → **100** | 2.9 s → 2.6 s | 940 ms → 0 ms |
| 中文首页 | 77 → **100** | 94 → **100** | 1.9 s → 1.4 s | 910 ms → 0 ms |

最终复测 run `41271796610`，源码 `ab3f4ee0a67beb12de54b8d304c003a7fc2c40a7`。每个页面的三次 Performance 分数一致；桌面各页均为 100。十组代表样本的 Accessibility、Best practices、SEO 全为 100，CLS 显示为 0。完整精度、环境和分数范围保存在 [结果快照](lighthouse-optimized-2026-11-01.json)，基线见 [原始快照](lighthouse-baseline-2026-11-01.json)。

LCP 并非所有页面都达到了原定 ≤2.5 s：手机文章为 2.7 s，系列详情为 2.6 s。最终报告的文章 LCP 是摘要文本，系列详情代表样本识别到保留的 Loading 图片；没有为了提分移除 Loading。TBT 显示 0 ms 是报告的舍入结果，不代表浏览器没有执行 JavaScript。

检查了 Lighthouse final screenshots 中首页、文章和时间线的手机/桌面布局，未见空白或加载遮罩滞留。浏览器 CI 另验证了 ClientRouter 保持文档、代码复制/折叠/重入、语言切换和 1165/390 px 布局。精选的报告缩略图保存于 `plan/performance-screenshots-2026-11-01/`；这些是 Lighthouse 终帧缩略图，不能替代完整视口的像素级 UI 验收。


## Actions 版本与注释

原 Studio run `41266954914` 的 11 warnings 中，10 条是 Actions Node 20 runtime 退役，1 条是 setup-java v4 退役。已升级 checkout、setup-node、setup-java、upload/download-artifact、setup-android、Gradle setup、setup-chrome 和 cache；Linux runner 固定 Ubuntu 24.04。

新的平台构建已全部成功，check-run annotations 中 warning 从 11 条降至 **0 条**，仍有 3 条 macOS ARM64 capacity queue notice。这是 GitHub 平台队列提示，不能由项目版本升级消除，也不意味着构建失败。完整记录见 [Actions 注释前后快照](actions-annotations-2026-11-01.json)。

## Studio 应用标识

Tauri identifier 改为 `wang.jiaxiang.wondershine-studio`；相关 smoke/acceptance 路径和发行文档已同步。Android 生成器将连字符规范化为下划线，因此其 applicationId 为 `wang.jiaxiang.wondershine_studio`。iOS 与桌面使用所要求的 identifier。

应用身份变化会影响原安装的应用数据位置与平台签名配置；没有删除或迁移原 App 数据。详细说明见 [Studio 发布说明](../docs/studio-releases.md)。本轮 CI 生成验证安装包及 iOS simulator app，未创建面向公众的正式 Studio Release。

## npm 发布流程

新增 `.github/workflows/npm-publish.yml`：手动入口仅 dry-run；`theme-vX.Y.Z` Release 经验证后发 `latest`，预发布只发 `next`。`studio-v*` 不会触发 npm 发布。

验证包括版本/ref/source 校验、单元与集成测试、demo/starter 构建、独立消费者安装、浏览器回归和 `npm publish --dry-run`。实际发布使用已经通过干净安装验证的同一份 tgz，以 SHA-256 和源提交清单校验；不会二次打包。只有发布 job 具有 OIDC 权限，并使用 GitHub `npm` environment。

**本轮没有实际向公共 npm 发布。** 包所有者还须确认 `@wondershine` scope 权限并在 npm 配置 Trusted Publisher；dry-run 无法证明这些外部权限已配置。完整操作见 [npm 发布文档](../docs/npm-releases.md)。

## 远程验收记录

| 验证 | Run ID | 源码 | 结果 |
|---|---|---|---|
| 主题与 Studio Web 完整验证 | `41271872232` | `ab3f4ee` | success |
| npm dry-run 与消费者安装/浏览器验证 | `41271876571` | `ab3f4ee` | success；publish job skipped |
| 最终 Lighthouse，5 页 × 2 设备 × 3 次 | `41271796610` | `ab3f4ee` | success |
| 从已有 Lighthouse artifact 提取摘要和截图 | `41272138923` | `ab3f4ee` | success；不重复测量 |
| Studio 全平台构建与验证 | `41271484308` | `d3db703` | success |

全平台验证之后的改动仅涉及主题目录样式/页脚文字、主题测试与手动 CI 入口，不影响 Studio 源码或应用标识；未重复触发全部原生打包。最终主题与 Studio Web CI 覆盖这些改动。

远程测试：主题单元测试 90/90、Studio 主测试集 197/197、工作区边界测试 1/1、npm 发布脚本 4/4、内容集成 12/12；另有类型检查、包独立安装构建、发行内容检查、主题与 Studio 浏览器检查通过。最终 theme 与 npm verify job 的 check-run annotations 均为空。

首次 CI 曾发现脚本全局作用域冲突，以及可选摘要库的旧测试模拟不完整；均已修复并完成复测，未跳过失败断言。静态代码审查没有未解决的阻塞项。

## 保留项与下一步

- 原 Zola 的 16 px 模糊占位图尚未等价移植；当前使用浏览器原生懒加载和尺寸预留。
- 未裁剪资源目录中未直接引用的图片，以免漏掉动态配置引用；外部图片、SVG/GIF 等维持已有处理边界。
- KaTeX 改为按需加载，未增加新的公式解析器，也未实现构建期公式渲染。
- 仍可继续评估基础 CSS 的覆盖率及少量传统脚本压缩；不能仅凭当前视口的 unused CSS 提示删除其它交互所需样式。
- 个人站部署后，重新测真实首页、长文、图片密集页，并配置压缩、hash 资源长期缓存、HTML 重新验证。
