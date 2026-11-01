# 主题 npm 包发布

发布包为 `@wondershine/theme`。Studio App 使用独立的 `studio-vX.Y.Z` Release，不发布到 npm。主题工作流为 `.github/workflows/npm-publish.yml`，名称 **Theme npm package**。

## 触发与验证

| 入口 | 行为 |
| --- | --- |
| Actions → Theme npm package → Run workflow | 远程构建、单元/集成/浏览器验证、打包、干净安装烟测、`npm publish --dry-run`；不上传 npm |
| 发布 `theme-vX.Y.Z` GitHub Release | 通过相同验证后，发布到 npm 的 `latest` |
| 发布 `theme-vX.Y.Z-beta.N` 等 GitHub prerelease | 通过验证后，仅发布到 `next` |
| 普通 push / PR 或 `studio-v*` Release | 不发布 npm；常规 CI 仍按既有规则验证代码 |

手动执行入口只有 dry-run，没有隐藏的正式发布开关。整个流程在 GitHub-hosted Ubuntu runner 上执行，不在开发电脑上构建或打包。

正式 Release 的 tag 必须与 `packages/theme/package.json` 的 version 完全一致，GitHub 的 prerelease 复选框也必须与 SemVer 一致。构建元信息（如 `+build`）和非规范版本被拒绝。发布前同时更新 `package-lock.json` 中主题 workspace 的版本；不要改 Studio 的版本来发布主题。

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
3. 在 GitHub 的 `npm` environment 配置适合仓库的 tag 限制或审核人（可选）；如果配置了审核，只有真实发布 job 会等待批准，dry-run 不使用该 environment。
4. 新建的 trusted publisher 必须在 2 天内完成首次成功发布，否则需要删除并重新创建。因此建议准备正式发行时再配置，dry-run 不会验证或延长这个期限。
5. 运行一次手动 dry-run，检查 `theme-npm-package` 与 `theme-npm-browser-results` artifacts。准备好真实发行时再发布 `theme-v*` Release。

OIDC 会自动附带 npm provenance。`package.json` 中的 repository 必须对应实际发布仓库；fork 发布需先修改 repository 和 npm scope/package 名及对应发布校验，再配置自己的 trusted publisher。本次工作不会替用户注册 scope、建立 npm 信任关系或发布真实公共版本。dry-run 成功只能证明构建、包内容和发布命令有效，不能证明 npm 所有权或 OIDC 配置已完成。

## 版本与失败恢复

预发布统一使用 `next`，不会移动普通用户安装的 `latest`。稳定版本使用 `latest`；发行前应确认版本递增，旧版本的 Release 不应重复触发发布。

构建/验证失败时修复代码并重跑；npm 认证失败时检查 trusted publisher 的仓库、workflow 和 environment 是否完全匹配。若上传成功后 Actions 中断，先在 npm 核对该版本是否已存在；已存在时保留发行记录，不强行覆盖、不重复提交同版本。工作流不会删除或撤回 npm 包。

参考：npm 官方 [Trusted publishing](https://docs.npmjs.com/trusted-publishers/)，GitHub Actions 官方 [Publishing Node.js packages](https://docs.github.com/en/actions/use-cases-and-examples/publishing-packages/publishing-nodejs-packages)。配置要求核对日期：2026-11-01。

## 已执行的远程验证

2026-11-01，源码 `ab3f4ee0a67beb12de54b8d304c003a7fc2c40a7` 的 dry-run `41271876571` 全部通过，包括独立消费者安装构建与浏览器检查。验证包为 `wondershine-theme-0.1.0.tgz`，正式 publish job 按设计跳过；未向 npm 上传。日志中的未登录提示来自无认证 dry-run，不能替代首次正式发布时的 Trusted Publisher 权限验证。
