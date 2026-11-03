# 升级已有 Astro 站点的主题

本页面向已接入 `@wondershine/theme` 的独立博客；从 Zola 转换内容请使用 [迁移指南](migration.md)。以下以当前 Starter 使用的主题 `0.2.1`、Astro `7.4.4` 为例，不表示以后版本也使用同一依赖组合。

## 1. 确认实际使用的版本

在**博客根目录**检查 `package.json`、`package-lock.json` 和 `astro.config.mjs`：

- `astro.config.mjs` 应导入 `@wondershine/theme` 并调用 `wondershine()`。
- `package.json` 中主题依赖可能是 npm 版本、`file:vendor/*.tgz` 或本地源码路径；先明确安装来源。
- 锁文件记录实际安装版本。主题源码 submodule 的提交不是 npm 安装版本；只更新 submodule 不会更新已安装主题。
- 更新前阅读目标版本的发行说明与 `packages/theme/package.json` 的 `engines`、`peerDependencies`。`0.2.1` 要求 Node.js ≥ 22.23.4，Astro 为 `7.4.4`。

先备份或提交站点配置、内容、资源及两个依赖文件，记录当前部署版本。不要用新版 Starter 覆盖自己的 `content/`、`public/`、`config.toml` 或 `data*.toml`，也不要把主题示例内容同步到个人站点。

## 2. 更新 npm 依赖

在博客目录执行以下命令可固定到本文对应版本；若升级到其他版本，请换成该版本要求的主题与 Astro 组合：

```sh
npm install --save-exact @wondershine/theme@0.2.1 astro@7.4.4
```

这也可将迁移工具生成的 `file:vendor/...` 依赖切换为 npm 版本。检查 `package.json` 和 `package-lock.json` 的差异，确认主题来源已改变。不要在仍需回退到本地包时删除 `vendor/` 中的归档。

若有意继续使用本地 tgz，应保留新归档并将主题依赖改为对应的相对路径，再更新锁文件；不要覆盖同名归档来冒充新版本。`npm ci` 只安装锁定依赖，不会替你选择新版本。已有个人升级脚本需先检查其实现，Starter 不提供 `theme:sync` 命令。

## 3. 核对配置与公开内容

主题默认配置由包加载，站点配置覆盖默认值；数组是整体替换。无需复制整份默认配置，但新增默认功能可能改变未显式配置的行为。

升级后的回归清单：

- 首页、文章、关于页、系列，以及已有历史 URL 和标题锚点。
- 默认语言与译文、语言切换、各语言 `data*.toml` 的完整导航列表。
- `/threads/`、动态详情、`/timeline/` 和话题；不要把旧 `/notes/` 或 `/thread/` 当作自动兼容入口。
- 动态和时间线订阅是否已明确写入 `feed_filenames`；仅开启 `generate_feeds` 默认只生成 `atom.xml`。见 [动态与订阅](configuration.md#动态与订阅)。
- 草稿、`render = false`、未来发布时间和草稿目录下的内容不公开；当前没有发布未来内容的配置开关。
- 同目录图片、公共资源、自定义 CSS、评论标识、搜索及其他外部服务。

在站点自己的 CI 或获准的验证环境中安装锁定依赖并构建，检查预览部署后再发布 `dist/`。主题仓库 CI 通过不等于个人站点已经验证或部署；保存文件、Git 同步与公开发布是不同步骤。

## 4. 回退与 Studio 的边界

回退时恢复配套的 `package.json` 与 `package-lock.json`（本地包依赖还需要对应 tgz），重新安装、构建并发布，或让托管平台恢复已验证的旧产物。不要恢复整份旧站目录而覆盖升级后新写的文章。

主题 npm 包和 WonderShine Studio 独立发行：更新主题依赖不会升级 Studio；更新 Studio 或源码 submodule 也不会自动升级博客的 npm 主题。Studio 的版本与平台说明见 [Studio apps](studio-apps.md) 和 [Studio 发行](studio-releases.md)。
