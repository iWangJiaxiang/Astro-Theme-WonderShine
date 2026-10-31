# 迁移站点，保留原文件

迁移工具只创建一个**不存在的新目录**，不原地编辑旧站点，不导入旧 Git 历史、主题子模块、会话或部署凭据。

```sh
npm run build:theme
npm pack ./packages/theme --pack-destination /tmp
npm run migrate:site -- --source /path/to/old-site --destination /path/to/new-site --theme /tmp/wondershine-theme-0.1.0.tgz
```

转换内容：

- `template = "page/post.html"` → `layout = "post"`。
- `page_template` → `child_layout`，保留正文、日期和其他 frontmatter。
- `static/` → `public/`；已有 `public/` 作为站点覆盖。旧 `admin/` 与 `admin-sveltia/` 不导入。
- 删除配置中的旧主题发现、Sass、Zola 搜索构建字段。保留 TOML、Markdown、section、taxonomy 和 URL 等内容约定。
- 不复制源树中的 symlink 或隐藏状态。

如果已有自定义历史标题锚点，用 `--heading-aliases /path/to/heading-aliases.json` 带入。此文件只属于个人站点：

```json
{"/articles/example/":{"new-heading-id":"historical-heading-id"}}
```

先在新目录 `npm install && npm run build`，检查旧 URL、媒体、评论关联和语言路径。最后才切换部署。旧路径和旧 frontmatter 的读取兼容层仍在主题中，完全不需要安装 Zola；新 Studio 仅写新格式，因此应在切换新 Studio 之前运行迁移。

迁移工具不会复制你的个人部署脚本、重定向服务器规则或密钥。按实际平台将 `_headers`、`_redirects` 等必要部署规则单独移入新站点并核对。不要把旧生成站点的 `public/` 当成手工资源目录迁入；若它是生成产物，先在旧站点的副本中移除再运行工具。
