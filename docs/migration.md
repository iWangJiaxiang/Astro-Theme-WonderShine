# 从 Zola 主题迁移到 Astro WonderShine

这篇文档适用于使用 **Zola 版 WonderShine 及其内容约定**的站点。迁移工具保留 Markdown、TOML 配置和内容目录，并转换主题布局字段。其他 Zola 主题可以借用这个流程搬运内容，但其模板、配置项和 shortcode 不保证兼容。

迁移在一个新目录完成，旧站继续保留。尚无站点的用户请阅读 [从零搭建](getting-started.md)。

## 1. 先确认迁移范围

| 旧站内容 | 新站处理 |
| --- | --- |
| `content/**/*.md` | 保留目录与正文，转换 TOML frontmatter 中的布局字段 |
| `config.toml` | 保留站点设置，删除 `theme`、`compile_sass`、`build_search_index`、`minify_html` |
| `data.toml`、`data.<语言>.toml` | 复制到新站根目录 |
| `static/` | 复制为 `public/` |
| 手工维护的 `public/` | 合并到新站 `public/`，同名文件覆盖从 `static/` 复制的版本 |
| 文章同目录图片 | 随内容目录一起复制 |
| `template = "page/post.html"` | 转为 `layout = "post"` |
| `page_template` | 转为 `child_layout`，用于目录下的子内容 |
| `.git`、主题 submodule、隐藏状态、symlink、旧后台资源 | 不导入；`static/`、`public/` 下的 `admin/` 与 `admin-sveltia/` 会排除 |
| 自定义 Tera 模板、Sass、部署脚本、凭据 | 不转换，按新主题能力单独适配 |

工具要求站点具有 `config.toml` 和 `content/`，Markdown 使用 `+++` 包围的 TOML frontmatter。已有 `layout` 或 `child_layout` 时优先保留新字段，随后移除旧字段。

**先检查旧站的 `public/`。** Zola 构建输出也常叫 `public/`。工具无法判断它是生成产物还是你维护的资源；把整份生成站点搬入新站可能带入旧 HTML、重复页面和旧脚本。如果它是输出目录，请制作一份迁移输入副本，在副本中去掉生成的 `public/`，再运行迁移。不要因此删除旧站原文件。

迁移前另外记录正式域名、默认语言、历史 URL、评论标识方式、搜索配置及托管规则。这些是最后验收的依据。

## 2. 准备主题包与新目录

需要 Node.js **22.23.4+**、npm 和主题源码。以下 Bash/Zsh 命令在**主题源码根目录**执行；变量请替换为实际路径，并在同一个终端继续：

```sh
export WONDERSHINE_SOURCE="$PWD"
export ZOLA_SITE="$HOME/Sites/my-zola-blog"
export BLOG_SITE="$HOME/Sites/my-astro-blog"

npm ci
mkdir -p temp/theme-pack
npm pack ./packages/theme --pack-destination temp/theme-pack
export THEME_ARCHIVE="$WONDERSHINE_SOURCE/temp/theme-pack/wondershine-theme-0.1.0.tgz"
```

当前主题包版本是 `0.1.0`；其他版本使用打包输出的实际文件名。主题尚未发布到 npm，迁移不需要先发布。

`ZOLA_SITE` 指向旧站或整理好的迁移输入副本。`BLOG_SITE` 必须在旧站目录之外，并且**尚不存在**；它的父目录需要先建立：

```sh
mkdir -p "$(dirname "$BLOG_SITE")"
npm run migrate:site -- \
  --source "$ZOLA_SITE" \
  --destination "$BLOG_SITE" \
  --theme "$THEME_ARCHIVE"
```

成功后会输出文档数量和新站路径。它不会修改旧站，也不会沿用旧 Git 历史。如果中途失败，旧站仍然保留，但新目录可能已有部分文件；检查失败原因后换一个新的目标目录重试，不要把半成品当作完整迁移结果。

### 保留历史标题锚点

如果旧文章的标题锚点和新渲染结果不同，可以在第一次迁移时额外传入 `--heading-aliases`：

```sh
npm run migrate:site -- \
  --source "$ZOLA_SITE" \
  --destination "$BLOG_SITE" \
  --theme "$THEME_ARCHIVE" \
  --heading-aliases /absolute/path/to/heading-aliases.json
```

这是上面迁移命令的**替代形式**，不要向同一目标目录执行两遍。JSON 以文章路径为第一层、新生成的标题 ID 为键、历史 ID 为值：

```json
{
  "/articles/example/": {
    "new-heading-id": "historical-heading-id"
  }
}
```

工具将其保存为 `compatibility/heading-aliases.json`。已经迁移完成的站点也可手动新增该文件再构建；工具不会自动推断旧锚点。

## 3. 把主题包保存在新站中

迁移工具生成的依赖最初指向 `--theme` 的绝对路径。这适合本机试跑，但其他设备没有这个路径。首次安装前，将包复制进新站并改为相对依赖：

```sh
node --input-type=module <<'JS'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const site = process.env.BLOG_SITE;
const archive = process.env.THEME_ARCHIVE;
const filename = path.basename(archive);
await mkdir(path.join(site, 'vendor'), { recursive: true });
await cp(archive, path.join(site, 'vendor', filename));
const pkgPath = path.join(site, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
pkg.dependencies['@wondershine/theme'] = `file:vendor/${filename}`;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
JS

cd "$BLOG_SITE"
npm install
npm run build
npm run preview -- --host 127.0.0.1 --port 4325
```

打开 `http://127.0.0.1:4325/`。新站的生成目录是 `dist/`；`public/` 现在是你维护的公共资源，不能再当作构建输出清理。

保存 `vendor/`、`package.json` 与新生成的 `package-lock.json`。后续使用 `npm ci` 安装，不要依赖旧站的 Node 依赖或 Zola 构建脚本。

## 4. 检查需要手工适配的部分

### 模板、样式与 shortcode

新主题通过 Astro Integration 提供路由和组件，不运行 Tera，也没有按旧文件路径自动覆盖模板的机制。

- 先用内置 `layout` 对应旧页面。支持的布局见 [配置与内容格式](configuration.md)。
- 自定义 CSS 放入 `public/css/custom.css`。旧 Sass 源码不由迁移工具编译；旧的编译 CSS 也需要检查选择器是否仍匹配。
- 内置 Markdown 扩展支持 `image` 和 `subscribe_list`。其他自定义 shortcode 要逐项适配，不能仅复制旧 `templates/shortcodes/`。
- 自定义布局需要使用主题导出的 Astro 组件或自行编写 Astro 页面，再检查路由是否冲突。

### 多语言、动态与分类

迁移时保留旧 `default_language`、`languages`、文件语言后缀和 `data.<语言>.toml`。默认语言的 `index.md` 与译文 `index.en.md` 属于同一组内容，不能仅改站点默认语言而不调整文件。

动态源码继续放在 `content/notes/<ID>/`；新建动态由 Studio 使用 UUID，并生成 `/thread/<UUID>/` 公开路径。迁移工具不自动给旧动态重新编号，也不批量改写其 `path`。应逐条核对已有动态地址，避免为了统一目录名称破坏旧链接。

原有 `taxonomies.tags` 与 `taxonomies.categories` 继续使用。话题是独立内容，文章系列和音乐专辑等分组不会自动转换成话题。站内引用、多语言引用回退、系列上下章链接都需要在新站中验证。

### URL、资源与外部服务

保留 `base_url`、内容路径、`slug`、`path` 与 `aliases` 等现有设置，但不要把“字段已复制”当作“所有历史 URL 已验证”。尤其检查：

- 默认语言和译文首页、文章、独立页面、动态、标签、分类和系列。
- 旧 `.html` 别名、带或不带尾斜杠的链接、标题锚点。
- 同目录图片、`/uploads/`、站点 Logo、字体、自定义 CSS。
- RSS、sitemap、canonical 地址。
- 评论系统的页面标识是否仍匹配，旧评论是否能加载。

迁移会复制 `config.toml` 和 `data*.toml` 中已有的服务设置；请清理不再使用的地址和任何误放在公共配置中的私钥。服务器环境文件、Git token、后台密码和 AI key 不会自动搬到新 Studio。

现有搜索 UI 支持按配置接入 Meilisearch 或 Algolia；切换到 Astro 不会自动创建搜索后端或 Pagefind 索引。评论、统计、音乐、搜索及远程图片的真实可用性需要单独验证。

### 托管规则

根目录的 `_headers`、`_redirects`、CI、域名绑定和个人部署脚本不会自动迁移。如果托管规则原本在资源目录中，它们可能随复制进入新站，仍需核对。旧 CSP、缓存规则和重写规则不一定适用于 Astro 输出。

部署平台应改为：安装依赖 `npm ci`，构建 `npm run build`，输出目录 `dist/`。先用预览部署验证，再切换正式域名。不要继续执行 `zola build` 或部署旧 `public/`。

## 5. 接入新创作中心

先完成内容迁移，再让新 Studio 指向新站。新 Studio 写入 `layout`、`child_layout`；不要让它误写正在使用的 Zola 旧站目录。

确认新站根目录有可解析的 `data.toml`。迁移工具允许旧站没有这个文件，但 Studio Setup 需要它；缺少时可先创建空的 `data.toml`，再按 [配置与内容格式](configuration.md) 填写导航等数据。不要覆盖已有数据文件。

按 [从零搭建：连接创作中心](getting-started.md#5-连接创作中心) 设置 `STUDIO_SITE_ROOT`。Setup 不覆盖已有 `.env`；已经运行过 Studio 时，应手动核对站点路径及 Git 模式配置。旧站账号密码不会被自动导入。

先保存一篇测试草稿并检查磁盘：

1. 新站对应文件发生变化，旧站文件没有变化。
2. 新内容使用 `layout`，翻译关系与 AI 审核状态正确。
3. 图片写到新站 `public/` 或文章目录。
4. 再运行 Astro 构建，公开页符合预期。

桌面 App 可在「本地文件夹」中选择新站 Git 仓库并原地编辑，也可以在「远程仓库」中粘贴包含新格式内容的 HTTPS Git 地址，下载为 App 私有工作区。浏览器本地模式直接编辑指定的站点目录。两种方式见 [Studio apps](studio-apps.md) 与 [工作区说明](studio-workspaces.md)。

## 6. 切换上线与回退

迁移目录完成验收后，再建立新站的 Git 仓库及部署流水线。若需要绑定主题源码，可按 [从零搭建](getting-started.md) 的 submodule 一节操作；这不是运行主题的必要条件。提交前检查 `.gitignore`，排除 `.env*`、`.state/`、`.studio-history/`、`.studio-write-lock/` 和构建缓存；保留所需的 `.env.example`，并纳入 `vendor/` 中的主题包。

上线前至少完成一轮生产预览，并留存旧站的源码、构建产物和托管配置。确认新站后再修改正式部署来源。若上线结果不符合预期，可让托管平台重新发布旧产物或切回旧仓库。

**回退主题不会自动合并迁移后的新内容。** 切换期间尽量只在一个站点编辑；如果已经在 Astro 站点新增稿件，回退前先备份并单独转移这些内容。

## 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 目标目录已存在 | 选择新的目标目录；迁移工具不会覆盖已有目录 |
| TOML/frontmatter 解析失败 | 检查 `+++`、TOML 语法和旧文件编码；在副本中修正后重试 |
| 安装时找不到主题包 | 确认 `vendor/*.tgz` 存在，`package.json` 使用相对 `file:vendor/...` |
| 首页出现旧版 HTML 或脚本 | 检查是否把旧 Zola 生成的 `public/` 当作资源导入 |
| 译文或语言首页缺失 | 检查语言配置、内容后缀和对应 `_index.<语言>.md` |
| Studio 提示路径错误或显示旧内容 | 核对实际加载的 `.env`、`STUDIO_SITE_ROOT` 和遗留 Git 模式变量 |
| 保存后线上没有变化 | 检查是否已同步内容、重新构建并发布 `dist/` |

仓库自带迁移回归可在主题根目录运行：

```sh
npx tsx --test tests/migration.test.ts
```

它验证旧文件不变、布局转换、资源复制、标题锚点和 Studio 写入新格式；不替代你自己站点的历史链接及外部服务验收。
