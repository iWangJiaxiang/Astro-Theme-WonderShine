# 打包与发布

当前远程 origin 为 Astro-Theme-WonderShine，当前版本仅本地验证，尚未推送或发布。

1. `npm ci`
2. `npm run build`
3. `npm run check && npm test && npm run test:integration`
4. `npm run audit:distribution && npm run test:package`
5. 查看 `npm pack ./packages/theme --dry-run`，确认只有主题 runtime、组件、资源、默认值与翻译。

主题的 `prepack` 会从源码重建资源，不依赖已存在的 ignored 输出。打包白名单不包含个人内容、examples、Studio、测试、缓存或服务端状态。测试从实际 `.tgz` 安装到新目录，避免工作区链接掩盖缺文件问题。

后续正式发布前确认 npm 包名可用、版本号、变更日志与部署平台；这些动作不属于本次本地拆分。主题包公开源代码受 AGPL-3.0-or-later 约束，保持 LICENSE 和第三方来源声明。

升级主题：在个人站点修改依赖版本并更新 lockfile。文章和图片不属于主题包，不随升级被覆盖。Starter 当前依赖本地 workspace 版本；尚未发布时，复制使用需改为本地 `.tgz`。

## 主题与个人站点的回归

主题 CI 构建 Demo 后运行 `npm run test:browser`，覆盖内容页面、ClientRouter、语言切换、1165px 和 390px 布局，并保留截图。可通过 `STUDIO_TEST_BROWSER` 指定 Chrome。

个人站点可以复用 `scripts/test-browser.mjs`：传入 JSON 文件，包含相对于配置文件的 `siteRoot`、`pages`（截图名称与路径的数组）和 `navigation`（`path`、`language`、`translatedPath`）。先构建站点；脚本会自动启动与关闭独立 preview，不接触已有服务。

建议站点以 submodule 固定主题提交，并安装从该提交打出的实际 tgz。主题仓库只使用中性 Demo；站点自己的 CI 使用真实内容回归。升级时提交 submodule 指针、包文件、依赖和 lockfile，通过预览验证后再部署。CI 仅验证与上传构建产物，不发布主题或部署网站。
