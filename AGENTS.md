# Agent 开发指南

本文件适用于 Astro-Theme-WonderShine 仓库。若子目录存在更具体的 `AGENTS.md`，在该目录遵循其补充约定。

## 项目定位与边界

- 本仓库包含 Astro 静态博客主题 `@wondershine/theme`、独立创作中心 **WonderShine Studio**、示例站点及发行工具。
- 个人博客属于独立仓库。Demo 使用虚构内容；不得将个人文章、图片、配置、凭据或运行状态复制进主题发行包。
- 主题负责静态页面、路由、样式和构建期资源处理；Studio 负责内容创建、编辑与保存。不要把创作中心的内容生成搬进博客构建脚本。
- Astro Integration 拥有主题路由。保留静态输出与已有 URL 兼容行为；不为导航效果引入 SSR。当前没有 Zola/Tera 模板继承或同路径组件自动覆盖机制。
- 使用者的 `content/`、`public/`、`config.toml`、`data*.toml` 是站点数据，升级主题不能覆盖这些文件。
- 保留 AGPL-3.0-or-later 许可、`LICENSE`、`NOTICE.md` 和第三方来源说明。

## 开始工作

1. 确认实际工作目录、分支、remote 和 `git status --short`。此项目曾从旧 Zola 仓库拆出，不要因会话默认目录仍指向旧仓库而修改错误位置。
2. 阅读目标模块、相关测试和 `docs/` 中对应说明，再进行修改。保留其他未提交改动，不执行无差别 reset、clean 或覆盖。
3. 复杂工作先说明方案，在仓库内 `plan/` 记录计划；临时文件放 `temp/`。路径相对当前仓库，不是系统根目录。
4. 与用户用中文沟通，技术名词和标识符保留英文。代码中的标识符及新增注释使用英文。
5. Git 提交采用 Conventional Commits，如 `fix(theme): ...`、`feat(studio): ...`、`chore(ci): ...`。新分支默认 `feat/` 前缀；已有任务继续使用当前工作分支。

## 目录导航

| 路径 | 职责 |
| --- | --- |
| `packages/theme/integration.mjs` | Astro Integration、站点配置、路由注入与资源准备 |
| `packages/theme/src/lib/` | 内容读取、Markdown、路由、查询、多语言与图片引用 |
| `packages/theme/src/components/`、`layouts/`、`scripts/` | Astro 界面、布局与客户端导航/交互 |
| `packages/theme/styles/` | 构建输入 CSS，包含基础与按页样式 |
| `packages/theme/assets/` | 静态资源、传统主题脚本及第三方库 |
| `packages/theme/scripts/` | 资源汇集及响应式图片编码 |
| `packages/theme/defaults/`、`locales/` | 默认配置与主题翻译 |
| `apps/studio/src/` | React 创作界面、编辑器及客户端状态 |
| `apps/studio/shared/` | 可复用内容、仓库、工作区等协议与业务逻辑 |
| `apps/studio/server/` | HTTP 服务、认证与服务端存储适配 |
| `apps/studio/src-tauri/` | 原生系统能力、权限与 App 打包配置 |
| `examples/demo/`、`examples/starter/` | 完整演示与可复制的最小站点 |
| `scripts/`、`tests/` | 构建/迁移/发行工具及跨工作区验证 |
| `.github/workflows/` | 主题检查、App 构建、Lighthouse 与 npm 发布 |

## 实现约定

- 使用现有 npm workspaces 和 `package-lock.json`；依赖与运行时要求以各 `package.json` 及工作流为准，不引入第二套锁文件。
- 沿用 TypeScript ESM、Astro 和 React。只使用浏览器全局的独立 TS 脚本也应显式成为模块（例如 `export {}`），避免与其他脚本共享全局声明。
- 服务端专属 API 不得进入浏览器共享业务层。业务逻辑优先复用 TypeScript，Tauri 提供文件、网络与系统能力；当前不引入 Rust/WASM 统一后端或 WebSocket 部署依赖。
- Git 存储沿用仓库接口和文件/HTTP 适配器，不能将核心持久化绑定到 GitHub 专有 API。云函数、本地服务和 App 模式的能力差异应通过已有接口表达。
- 保留草稿、隐藏内容、未来发布时间和翻译版本的可见性边界；引用本站文章时按语言解析，不泄露未发布内容。
- 修改界面文案时同步考虑中英文、已有翻译目录与缺失翻译回退。内容国际化和主题框架国际化是两个不同层次。
- 表单应紧凑、操作明确，用布局解释关系，避免不必要的次级标签和说明。复用已有控件、CSS tokens 与静态 SVG 图标，避免引入整套图标注册表。
- 修改 Markdown、HTML 或链接处理时保留转义、路径边界和 URL 校验；不能通过字符串拼接用户文本构造不安全的 HTML。
- 只修改源文件。`dist/`、`.astro/`、`.astro-assets/`、主题生成的 `assets/dist/`、Tauri `target/` 和 `gen/` 不作为手工维护入口。

## 导航与性能约束

- 保留 Astro ClientRouter、首次加载 Loading、站内切换 Loading、多语言导航和持久音乐播放器。
- 客户端初始化应同时覆盖首次访问及 `astro:page-load`；处理重复绑定、持久元素、离开页面后的请求与异步回调。
- 按页面或用户交互加载依赖，检查依赖顺序。构建期代码高亮不应重新变成全站浏览器语言包；CSS 拆分不能重复加载整站与按页样式。
- 保留 AVIF/WebP、多尺寸 `srcset/sizes`、已知宽高及原图灯箱。不得放大小图；修改编码配置须同步缓存 recipe，遵循 `avif_enable`。
- 页面得分不能替代功能、可访问性和视觉回归。使用同一内容、环境与多次测量比较，明确 demo 与个人站线上表现的差异。

## Studio 数据与安全

- 本地文件保存、本地 Git 提交、远端同步和公开发布是不同操作。不得把保存成功显示为推送或部署成功。
- 持久工作区可能保存唯一的未发布内容和未推送提交，属于用户数据，不能作为构建缓存清理。`.studio-history/` 和 AppData 同样不能随意删除。
- `STUDIO_SITE_ROOT` 为本地站点；在线 Git 与持久 Git 工作区的语义见 `docs/studio-workspaces.md`。云函数临时磁盘不能冒充持久离线工作区。
- Git 分支保存不会自动推送、创建 PR 或合并；工作区同步也不应隐式推送所有保存分支。
- 保留 revision 冲突检测、工作区锁、Origin/CSRF 与权限检查。不得为恢复同步而自动 force push 或删除工作区。
- API 密钥、Git token、签名材料不得进入版本库、日志、截图或浏览器公开配置。测试使用临时仓库与测试服务，不对真实仓库执行破坏性操作或调用计费 API。

## 验证：仅在远程 CI 执行构建与测试

用户要求减少本机空间与构建负载。**不要在本地运行依赖安装、项目构建、测试套件、Lighthouse、原生编译或 App 打包。** 本地可读写源码、检查 diff、进行轻量语法解析、下载/查看远程日志和截图。

下表列出远程 CI 的验证入口，不是要求在本地运行：

| 命令 | 验证内容 |
| --- | --- |
| `npm run build` / `npm run build:starter` | Demo / Starter 生产构建 |
| `npm run check` | Astro 与 Studio 类型检查 |
| `npm test` | 主题、Studio 和工作区测试 |
| `npm run test:integration` | Studio 写入到 Astro 构建的内容集成 |
| `npm run audit:distribution` | 发行边界与个人数据泄漏检查 |
| `npm run test:package` | 实际 tgz 的独立消费者安装与构建 |
| `npm run test:browser` | 主题导航、语言、代码交互及响应式浏览器回归 |
| `npm run test:browser -w @wondershine/studio` | Studio 浏览器回归 |
| `node --test tests/npm-release.test.mjs` | npm 发布规则与产物校验 |

- `.github/workflows/ci.yml` 支持手动运行，可只重测主题/Web 而不重复触发整套原生打包。执行 GitHub 操作沿用当前任务的授权范围。
- App 构建和原生验收由 `studio.yml` 负责；其中 production browser smoke、React lifecycle、上传折叠反馈、原生按钮布局与历史 MediaBrowser expected-red 检查在前置条件成功后独立执行，任何一步失败仍使 job 失败，不将局部结果合称通过。两个新增组件 fixture 各有独立 5 分钟步骤，产物分别位于 `apps/studio/test-results/upload-collapsed-feedback/` 和 `apps/studio/test-results/native-actions-layout/`；它们不扩展原 lifecycle 场景，也不代表真实 AT 或原生 WebView 验收。`test:browser` package 命令仍保留 `smoke && lifecycle`。Lighthouse 由 `lighthouse.yml` 负责。已有报告可通过 `report_run_id` 提取，不必重复测量。
- Mounted Settings safety 在 `studio.yml` 中作为仅依赖 `prepare` 的独立 20 分钟 job，仅对非 tag、非发行／发布的 push 和 PR 执行，无需产品构建或字体安装；独立 5 分钟 runner 步骤先创建 `/tmp/opencode`，再执行 fixture，始终尝试上传 `apps/studio/test-results/settings-mounted-safety/`。不改变原 verify、package 命令或发行依赖；此合成 fixture 不代表真实服务、原生 WebView、视觉或可访问性验收。
- Studio 多尺寸、滚动／缩放与共享弹层审计由 `studio-ui-audit.yml` 负责，覆盖与证据边界见 `docs/studio-ui-validation.md`。其 shard-1 native fixture build／browser step 单独启用并要求 CI-only final-clone scope trace；普通、发行与 TestFlight 构建不启用该插桩，原 stale-scope／abort／不重放保护保持不变。Chromium 合成触控和 mocked Tauri IPC 不等于原生 WebView 或真机验收。
- `studio-ui-audit.yml` 的 residual synthetic complement 仅在 shard 1 的 Collection step 后、native fixture build 前执行，使用独立 3 分钟步骤及既有 service-build／Chrome outcome 条件；此前审计失败不阻止其收集结果，失败仍使 job 失败，取消或 job deadline 可阻止执行。runner 固定三个 cases、共享 90 秒 worker／名义 143 秒 parent 预算，产物位于 `apps/studio/test-results/residual-navigation-media/`，由既有 `always()` artifact step 尝试保留。字体／sandbox 前置失败仍是 job 失败，局部 fixture 通过不代表环境验收。此补充不替代原 93-surface matrix、generic gestures、真实 App saved-node retention、AT 或原生 WebView／真机证据，也不改变发行依赖或普通／发行／TestFlight 插桩范围。
- 根据改动选择必要测试；通过后不无故重复。修复失败后复测受影响部分，代码变更完成后进行代码审查。
- UI 修改应读取远程截图并检查布局、遮挡和交互。不要把 CI 构建成功称为真机或应用商店验收成功。
- 完成报告说明改动、实际验证、未验证项与限制，并关联 run ID 或提交。不得仅因 CI 已启动就宣称验证完成。

## 发布约定

- Studio 的发行名称是 **WonderShine Studio**，Tauri identifier 为 `wang.jiaxiang.wondershine-studio`；Android 生成的 applicationId 为 `wang.jiaxiang.wondershine_studio`。更改应用身份必须评估旧数据目录、签名与升级影响。
- Studio 使用 `studio-vX.Y.Z`，主题 npm 包使用 `theme-vX.Y.Z`，互不混用版本或发布触发器。
- 所有新发行（主题和 Studio，包括稳定版与预发布）必须先将发行代码及版本变更合入远端 `main`，确认该提交通过对应的远程验证，再从 `main` 的已验证提交创建 `theme-v*` 或 `studio-v*` tag 和 GitHub Release（target 为 `main`）。禁止直接从 feature 或其他非 main 分支创建发行 tag 或 Release。已发布的 tag、npm 版本及 Studio 发行不得移动、覆盖或重发；发现违反流程时先说明事实，再通过合并和新版本纠正。
- `npm-publish.yml` 的手动入口只有 dry-run；主题 Release 经验证后，稳定版发 `latest`，预发布发 `next`。实际公开发行须在用户授权范围内。
- 发布已经通过独立安装验证的同一份 tgz，保留源码/版本/SHA-256 校验，不在发布 job 重新打包。
- npm 正式发布使用 Trusted Publisher/OIDC；dry-run 不证明 scope 权限或信任配置可用。配置以 `docs/npm-releases.md` 为准。
- 个人博客升级还需在站点仓库更新主题依赖或 submodule 指针，并进行站点自身的内容回归；主题 CI 不等于个人站已部署。

## 按需查阅

- 开始与迁移：`docs/getting-started.md`、`docs/migration.md`、`docs/configuration.md`。
- Studio 架构和存储：`docs/studio-technology.md`、`docs/studio-workspaces.md`、`docs/studio-apps.md`。
- 部署与发行：`docs/deployment.md`、`docs/releasing.md`、`docs/npm-releases.md`、`docs/studio-releases.md`。
- 性能基线与验收：`plan/lighthouse-optimization-2026-11-01.md`、`plan/performance-release-results-2026-11-01.md`。其中分数和 CI 结论仅代表记录的源码版本。

后续架构、命令或工作流发生变化时同步维护本文件；详细进度与实验结果写入 `plan/`，避免将历史日志堆进 Agent 指南。
