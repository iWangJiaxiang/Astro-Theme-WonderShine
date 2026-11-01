# WonderShine Creator Studio

独立创作中心。编辑 Markdown、TOML 和图片，Astro 负责构建公开网站。Studio 必须显式连接站点目录或内容 Git 仓库，不会默认写入主题源码。

## 先准备站点

- 尚无站点：[从零搭建 Astro 博客](../../docs/getting-started.md)。
- 使用 Zola 旧主题：[先迁移到新目录](../../docs/migration.md)，再连接新 Studio。

创作中心编辑内容，不负责将 Zola 模板转换成 Astro 模板。

## 本地启动

从整个仓库的根目录执行，需要 Node.js 22.23.4 或更高版本：

```sh
npm ci
npm run setup -w @wondershine/studio
npm run doctor -w @wondershine/studio
npm run studio:dev
```

Setup 创建 `apps/studio/.env`，保留已有配置。将 `STUDIO_SITE_ROOT` 设置为站点绝对路径；首次试用可选择 `examples/demo`。浏览器访问开发服务输出的地址，使用 Setup 创建的管理员登录。

生产构建在远程 CI 或部署服务器执行，构建后的服务可按需运行：

```sh
npm run studio:build
npm run start -w @wondershine/studio
```

## 配置

完整变量示例见 [.env.example](.env.example)，部署与认证说明见 [独立部署](../../docs/deployment.md)。

- 本地文件模式：`STUDIO_SITE_ROOT` 指向包含 `config.toml` 和 `content/` 的站点。
- Git 在线模式：设置 `STUDIO_GIT_URL`、分支、访问凭据；保存会提交并推送到该内容仓库。
- Git 本地工作区：额外设置 `STUDIO_GIT_WORKSPACE`，支持离线保存和提交，再显式同步。需要持久磁盘；云函数继续使用在线模式。参见 [工作区说明](../../docs/studio-workspaces.md)。
- 账号密码或 OIDC 均由服务端配置，密钥不能使用 `VITE_` 前缀。
- 桌面 App 初始化提供本地文件夹选择和远程仓库地址输入：前者原地编辑，后者下载到 App 私有目录；移动端支持后者。目录权限通过系统选择器授予，重启后保留。参见 [App 说明](../../docs/studio-apps.md)。
- 浏览器与远程服务模式从服务端读取 OpenAI-compatible AI 配置；App 直连 Git 模式在「客户端 API 设置」中配置。两者均支持摘要、封面生成和待审核的翻译草稿。
- 服务端状态使用文件或配置的 Blob 服务；会话、历史备份和凭据不属于公开站点。

## 内容与编辑

支持文章、动态、话题、系列/专辑、独立页面和多语言版本；动态支持内联编辑与引用文章。编辑器提供 Markdown 源码、可视化编辑、正文预览、浏览器草稿恢复、自动保存和保存冲突检查。

公共图片写入 `public/`，文章附件可以保存在对应内容目录。媒体库提供目录树、预览、上传和选图。新内容使用 `layout`、`child_layout`，从旧格式切换前参照 [迁移说明](../../docs/migration.md)。配置约定见 [内容格式](../../docs/configuration.md)。

保存成功表示文件已保存，不表示公开网站已部署。开发服务会刷新；正式静态站点须重新构建发布。

## 检查

从仓库根目录运行：

```sh
npm test -w @wondershine/studio
npm run test:integration
npm run studio:build
npm run test:browser -w @wondershine/studio
```

浏览器测试使用临时站点、临时认证数据和独立端口，不修改用户站点。测试在远程 CI 执行，需要 runner 安装 Chrome/Chromium，可通过 `STUDIO_TEST_BROWSER` 指定可执行文件。

## Desktop and mobile apps

React/Tauri architecture, connection modes, build commands and verified limitations: [Studio apps](../../docs/studio-apps.md). Native local workspaces do not embed Node; existing HTTP/cloud-function deployments remain supported.

### App CI 与 Release

桌面、Android 和 iOS 构建/测试交给 GitHub Actions 的 **Studio apps & release**，本机无需打包。修改 Studio 代码自动构建；正式发行使用 `studio-vX.Y.Z` Release 或 Actions 手动入口。原生 App 启动后自动检查新版本，可选择查看、稍后或跳过。签名配置与发行步骤见 [Studio App 发行文档](../../docs/studio-releases.md)。
