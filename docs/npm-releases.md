# 主题 npm 包发布

发布包为 `@wondershine/theme`。Studio App 使用独立的 `studio-vX.Y.Z` Release，不发布到 npm。主题工作流为 `.github/workflows/npm-publish.yml`，名称 **Theme npm package**。

## 选择安装渠道

在独立博客根目录选择一条命令。三个标签都属于公开包 `@wondershine/theme`。

| npm 标签 | 适用场景 | 安装或切换渠道 |
| --- | --- | --- |
| `latest` | 普通用户使用的稳定版，也是 npm 默认渠道 | `npm install --save-exact @wondershine/theme@latest` |
| `next` | 愿意试用 beta 或 RC 的用户 | `npm install --save-exact @wondershine/theme@next` |
| `canary` | 维护者自己的博客，试用刚合入 main 的主题改动 | `npm install --save-exact @wondershine/theme@canary` |

`npm view @wondershine/theme dist-tags --json` 可查看当前三个渠道的版本。安装命令会将当时选中的具体版本写入依赖。提交博客的 `package.json` 和 `package-lock.json`，部署时用 `npm ci` 复现。跟进新版或切回稳定版时，重新执行表中对应命令并验证博客；回退可恢复上一次通过验证的两个依赖文件。

## 触发与验证

| 入口 | 行为 |
| --- | --- |
| 手动运行 **Theme npm package** | 远程验证和 `npm publish --dry-run` |
| 合入 main 的主题源码、打包脚本或共享构建依赖变更 | 自动准备 canary，将版本提交到 main，远程验证后直接发布到 npm 的 `canary`，无需 Git tag 或 GitHub Release |
| 从已验证的 main 提交发布 `theme-vX.Y.Z-beta.N` 或 `theme-vX.Y.Z-rc.N`，勾选 **Pre-release** | 通过发行验证后更新 `next` |
| 从已验证的 main 提交发布 `theme-vX.Y.Z` 正式 Release | 通过发行验证后更新 `latest` |

维护者选择 beta、RC 或稳定版的发行时机。运行 `node scripts/theme-version.mjs X.Y.Z-beta.1`（将参数换为目标版本）同步主题、Demo、Starter 和 lockfile，提交到 main。等待该提交通过远程 CI，再在该 SHA 上创建同版本的 `theme-v*` tag，并以 `main` 为 target 发布 GitHub Release。GitHub 的 **Pre-release** 选项必须与版本一致。每次发行只更新所属 npm 标签。

自动 canary 使用 `X.Y.Z-canary.<GitHub run ID>`。当前版本为稳定版时，默认取下一个 patch；已有预发布时沿用其版本基线。要开始新的 minor 或 major，可显式提交该基线的第一个 canary（如 `0.3.0-canary.1`）。显式提交 beta、RC 或稳定版版本号时，工作流等待维护者创建 Release。纯文档、主题测试和 Studio 源码变更跳过自动 canary。

验证 job 缓存 `.astro/image-cache` 中的图片编码结果；key 隔离操作系统、lockfile 和编码器源码，并按提交保存快照。生成器仍对源图内容与完整编码 recipe 计算 hash，所以恢复旧缓存不会跳过变化图片的重新生成。发布 job 不恢复缓存，也不安装项目依赖；`dist` 与 `node_modules` 不进入这个缓存。

验证依次覆盖 demo/starter 构建、类型、单元测试、内容集成、发行文件检查、包消费者干净安装构建和浏览器行为。`test-package.mjs` 验证过的同一个 `.tgz` 连同源提交、版本及 SHA-256 清单上传为 artifact；发布任务只下载并验证此包，使用 `--ignore-scripts`，不重新打包。已发布的 npm 版本不可覆盖，修复后需要增加版本号。

## 首次配置 npm trusted publishing

工作流使用 OIDC，不依赖仓库中的长期 `NPM_TOKEN`。发布 job 单独取得 `id-token: write`，验证 job 没有此权限。Node 24 和固定 npm 11.21.1 满足 npm trusted publishing 的最低版本要求。

需要包所有者在 npm 网站完成以下配置；添加 workflow 不会自动获得 npm scope 或包权限：

1. 确认拥有 `@wondershine` scope 和 `@wondershine/theme` 的发布权限。若尚未创建包，先按 npm 当前的包初始化流程建立包；不要假定未注册的包已能配置 trusted publisher。首次登记/发布由包所有者完成。
2. 在包的 Settings → Trusted Publisher 中添加 GitHub Actions，填写：
   - Organization or user：`iWangJiaxiang`
   - Repository：`Astro-Theme-WonderShine`
   - Workflow filename：`npm-publish.yml`（不是完整路径）
   - Environment name：`npm`（与 workflow 的 environment 完全一致）
   - Allowed actions：启用 **npm publish**。2026-09-03 之后新建的配置默认只允许 staged publishing，本工作流使用直接发布，需要明确开启此项。
3. 在 GitHub 的 `npm` environment 配置适合仓库的部署限制或审核人（可选，自动 canary 需要允许 main，手动发行需要允许主题版本 tag）；如果配置了审核，只有真实发布 job 会等待批准，dry-run 不使用该 environment。
4. 新建的 trusted publisher 必须在 2 天内完成首次成功发布，否则需要删除并重新创建。因此建议准备正式发行时再配置，dry-run 不会验证或延长这个期限。
5. 运行一次手动 dry-run，检查 `theme-npm-package` 与 `theme-npm-browser-results` artifacts。准备好真实发行时再发布 `theme-v*` Release。

OIDC 会自动附带 npm provenance。`package.json` 中的 repository 必须对应实际发布仓库；fork 发布需先修改 repository 和 npm scope/package 名及对应发布校验，再配置自己的 trusted publisher。本次工作不会替用户注册 scope、建立 npm 信任关系或发布真实公共版本。dry-run 成功只能证明构建、包内容和发布命令有效，不能证明 npm 所有权或 OIDC 配置已完成。

## 版本与失败恢复

同一渠道的版本须递增。已发布 tag、GitHub Release 和 npm 版本保留原记录。若自动 canary 在版本提交后中断，可重新运行失败的工作流。工作流从通过独立安装验证的原始 tgz 恢复发布。

构建/验证失败时修复代码并重跑；npm 认证失败时检查 trusted publisher 的仓库、workflow 和 environment 是否完全匹配。若上传成功后 Actions 中断，先在 npm 核对该版本是否已存在；已存在时保留发行记录，不强行覆盖、不重复提交同版本。工作流不会删除或撤回 npm 包。

参考：npm 官方 [Trusted publishing](https://docs.npmjs.com/trusted-publishers/)，GitHub Actions 官方 [Publishing Node.js packages](https://docs.github.com/en/actions/use-cases-and-examples/publishing-packages/publishing-nodejs-packages)。配置要求核对日期：2026-11-01。

## 已执行的远程验证

2026-11-01，源码 `ab3f4ee0a67beb12de54b8d304c003a7fc2c40a7` 的 dry-run `41271876571` 全部通过，包括独立消费者安装构建与浏览器检查。验证包为 `wondershine-theme-0.1.0.tgz`，正式 publish job 按设计跳过；未向 npm 上传。日志中的未登录提示来自无认证 dry-run，不能替代首次正式发布时的 Trusted Publisher 权限验证。
