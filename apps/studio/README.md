# WonderShine Creator Studio

独立创作中心。编辑 Markdown、TOML 和图片，Astro 负责构建公开网站。Studio 必须显式连接站点目录或内容 Git 仓库，不会默认写入主题源码。

## 本地启动

从整个仓库的根目录执行，需要 Node.js 22.23.4 或更高版本：

```sh
npm ci
npm run setup -w @wondershine/studio
npm run doctor -w @wondershine/studio
npm run studio:dev
```

Setup 创建 `apps/studio/.env`，保留已有配置。将 `STUDIO_SITE_ROOT` 设置为站点绝对路径；首次试用可选择 `examples/demo`。浏览器访问开发服务输出的地址，使用 Setup 创建的管理员登录。

生产构建与运行：

```sh
npm run studio:build
npm run start -w @wondershine/studio
```

## 配置

完整变量示例见 [.env.example](.env.example)，部署与认证说明见 [独立部署](../../docs/deployment.md)。

- 本地文件模式：`STUDIO_SITE_ROOT` 指向包含 `config.toml` 和 `content/` 的站点。
- Git 模式：设置 `STUDIO_GIT_URL`、分支、访问凭据；保存会提交并推送到该内容仓库。
- 账号密码或 OIDC 均由服务端配置，密钥不能使用 `VITE_` 前缀。
- OpenAI-compatible AI 配置只在服务端读取，支持摘要、封面提示词和图片生成、翻译草稿与人工审核。
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

浏览器测试使用临时站点、临时认证数据和独立端口，不修改用户站点。需要本机 Chrome/Chromium，可通过 `STUDIO_TEST_BROWSER` 指定可执行文件。
