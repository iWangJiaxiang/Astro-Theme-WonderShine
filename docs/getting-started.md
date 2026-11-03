# 从零搭建 WonderShine 博客

这篇文档从一个空目录开始，搭建独立的 Astro 博客，再连接 WonderShine Studio 写文章。已有 Zola 站点请使用 [迁移指南](migration.md)。

主题已发布到 npm，包名为 `@wondershine/theme`。下面从源码仓库复制最小 Starter，再安装其中锁定版本的主题依赖；不需要自己打包主题。

## 1. 准备目录和环境

需要 Node.js **22.23.4 或更高版本**、npm 和 Git。以下命令使用 Bash/Zsh；Windows 可在 Git Bash 或 WSL 中运行。

```sh
node --version
npm --version
git --version
```

准备两份独立目录：

```text
workspace/
├── Astro-Theme-WonderShine/   # 主题源码与创作中心
└── my-blog/                  # 你的配置、文章和图片
```

先取得包含本文档的主题源码，并进入其根目录：

```sh
git clone https://github.com/iWangJiaxiang/Astro-Theme-WonderShine.git
cd Astro-Theme-WonderShine
```

后面的 `WONDERSHINE_SOURCE` 指向这个目录，`BLOG_SITE` 指向**尚不存在**的新站目录。请按实际位置修改：

```sh
# 在 Astro-Theme-WonderShine 根目录执行。
export WONDERSHINE_SOURCE="$PWD"
export BLOG_SITE="$HOME/Sites/my-blog"
```

这些变量供后续命令共用；请在同一个终端继续操作。不要在主题的 `examples/` 中存放个人文章。

## 2. 复制最小 Starter

下面的命令复制 Starter，排除开发缓存，并保留其 npm 主题依赖。目标目录已经存在时会停止，不会覆盖已有站点。

```sh
node --input-type=module <<'JS'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const source = process.env.WONDERSHINE_SOURCE;
const site = path.resolve(process.env.BLOG_SITE);
const starter = path.join(source, 'examples/starter');
await mkdir(path.dirname(site), { recursive: true });
await mkdir(site);
await cp(starter, site, {
  recursive: true,
  filter: file => !path.relative(starter, file).split(path.sep)
    .some(part => ['node_modules', 'dist', '.astro', '.astro-assets', '.git'].includes(part)),
});
const pkg = JSON.parse(await readFile(path.join(site, 'package.json'), 'utf8'));
pkg.name = 'my-blog';
await writeFile(path.join(site, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
await writeFile(path.join(site, '.gitignore'),
  'node_modules/\ndist/\n.astro/\n.astro-assets/\n.state/\n.studio-history/\n.studio-write-lock/\n.env\n.env.*\n!.env.example\n.DS_Store\n');
JS
```

## 3. 安装并预览

在新站目录安装依赖。Starter 已指定兼容的 Astro 和主题版本：

```sh
cd "$BLOG_SITE"
npm install
npm run dev
```

浏览器打开终端打印的地址，通常为 `http://127.0.0.1:4321/`；端口被占用时以实际输出为准。按 `Ctrl+C` 停止预览。

主题已经由 `astro.config.mjs` 接入，无需自己建立首页路由：

```js
import { defineConfig } from 'astro/config';
import wondershine from '@wondershine/theme';
export default defineConfig({ integrations: [wondershine()] });
```

## 4. 换成自己的内容

| 文件或目录 | 你在这里修改什么 |
| --- | --- |
| `config.toml` | 站名、作者、正式域名、语言、主题功能 |
| `data.toml`、`data.<语言>.toml` | 导航、标签、分类和对应语言的展示数据 |
| `content/articles/` | 文章 |
| `content/threads/` | 动态；公开网址使用 `/threads/<UUID>/` |
| `content/topics/` | 连接文章与动态的话题 |
| `content/collections/` | 系列与章节等分组内容 |
| `content/pages/` | 关于等独立页面 |
| `public/` | 公共图片、图标和 `css/custom.css` |

先修改 `config.toml` 中的 `title`、`description`、`author` 和 `base_url`。`base_url` 填正式网址；本地预览不需要把它改为 localhost。暂未确定域名时可以保留示例值，但上线前必须更换。

Starter 默认语言是 **English**，中文译文为 `zh-CN`。`content/articles/welcome/index.md` 是默认语言文章，旁边的 `index.zh-CN.md` 是中文版。先保留这个结构，确认两种语言都能浏览。

创建第一篇文章时，新建 `content/articles/my-first-post/index.md`：

```markdown
+++
title = "My first post"
layout = "post"
date = 2026-01-01
draft = false
description = "A short introduction."

[taxonomies]
tags = ["design"]
categories = ["journal"]
+++

## Hello

This is my first post.
```

把标题、日期、摘要和正文换成自己的内容，然后访问 `/articles/my-first-post/`。使用 `draft = true` 可保留为草稿；草稿不会出现在公开构建中。图片可放在文章目录并使用相对路径，公共图片则放到 `public/uploads/`，在正文中引用 `/uploads/文件名`。

示例文章、动态、话题和系列都可以删除或替换；保留仍需使用的目录 `_index.md` 与各语言版本。删除示例话题或文章时，也要检查其他示例内容中的引用。

### 如果希望中文是默认语言

不要只把 `default_language` 改成 `zh-CN`。无语言后缀的文件始终代表默认语言，单改配置会把英文示例当成中文。

在开始写自己的内容前，协调调整：

1. 在所有示例内容目录中，将英文无后缀文件改为 `.en.md`，再将 `.zh-CN.md` 改为无后缀文件；包括 `_index.md` 和 `pages/about.md` 这类文件。
2. 将 `data.toml` 的英文数据移到 `data.en.toml`，将 `data.zh-CN.toml` 的中文数据作为 `data.toml`。
3. 配置 `default_language = "zh-CN"` 和 `[languages.en]`。把原 `[languages.zh-CN]` 及其子表改为英语配置，填写英文标题、简介、taxonomy；同步检查 `extra.locale` 中的语言覆盖。
4. 更新数据文件中的导航地址：中文 `data.toml` 的 `/zh-CN/articles/` 等地址去掉 `/zh-CN`；英文 `data.en.toml` 中的本站导航加上 `/en`，例如 `/en/articles/`。
5. 更新内容 frontmatter 顶层的显式 `path`：中文关于页由 `zh-CN/about` 改为 `about`，中文动态由 `zh-CN/threads/<UUID>` 改为 `threads/<UUID>`；英文对应版本改为 `en/about`、`en/threads/<UUID>`。显式路径不会自动随默认语言改变，其他手写 URL 和 `aliases` 也应逐项核对。**不要批量替换 `extra.references[].path`**，其中 `articles/welcome/index.md` 是内容源引用，不是公开网址。
6. 构建后核对 `/`、`/en/`、两种语言的关于页、文章、动态、导航和语言切换，再开始正式写作。

已有公开站点更换默认语言可能改变 URL；迁移时优先保留旧语言设置。更多规则见 [配置与内容格式](configuration.md)。

## 5. 连接创作中心

### 浏览器本地模式：直接编辑这个站点

在另一个终端进入**主题源码根目录**：

```sh
cd /absolute/path/to/Astro-Theme-WonderShine
npm ci
npm run setup -w @wondershine/studio
npm run doctor -w @wondershine/studio
npm run studio:dev
```

Setup 中这样选择：

- 内容来源：`1 本地站点`。
- 站点根目录：刚创建的 `my-blog` **绝对路径**，不要选主题目录。
- 后台地址：可以保留 `http://localhost:5173`。
- 管理员账号和密码：自行设置，密码至少 12 个字符。

Setup 写入 `apps/studio/.env`；已有 `.env` 时不会覆盖，请检查其中的 `STUDIO_SITE_ROOT`。相对路径以 `apps/studio/` 为基准，因此推荐绝对路径。此前配置过 Git 模式时，还应清除不再使用的 `STUDIO_GIT_URL` 与 `STUDIO_GIT_WORKSPACE`。

打开终端显示的后台地址，用自己设置的账号登录。没有通用默认密码，Git 平台账号也不是后台账号。

在 Studio 中可创建文章、动态、话题和译文，上传图片，配置导航。保持博客的 `npm run dev` 同时运行，保存后即可预览。这个本地文件模式只写文件，不替你提交或推送 Git。

### 桌面 App：独立的本地 Git 工作区

App 初始化时提供「本地文件夹」和「远程仓库」两个入口。桌面端可以选择现有博客 Git 仓库，直接编辑原目录；也可以粘贴 HTTPS Git 地址，将仓库下载到 App 的私有目录。移动端使用远程仓库入口，下载后可离线编辑。

选择本地目录后，App 自动识别分支和仓库内配置的提交者；没有远端也能编辑和提交。远程入口先粘贴仓库地址，分支、认证和提交者放在「连接与提交设置」中。编辑后依次保存、提交到设备、显式同步。AI 在「客户端 API 设置」中配置，密钥仅用于当前连接。也可以选择「连接自建创作中心」，使用已部署服务的账号和 API 配置。

本地目录须包含普通 `.git/` 目录、`content/`、`config.toml` 和 `data.toml`；暂不支持以 Git worktree 或 submodule 根目录打开。合并或变基进行中会阻止写入；先在 Git 工具中完成操作。

App 构建、移动端准备条件和限制见 [Studio apps](studio-apps.md)；服务端 Git 与云函数模式见 [工作区说明](studio-workspaces.md) 和 [部署指南](deployment.md)。

## 6. 验证生产构建

在**博客目录**执行：

```sh
npm run build
npm run preview -- --host 127.0.0.1 --port 4325
```

访问 `http://127.0.0.1:4325/`，检查首页、文章、动态、语言切换和图片。预览的是上一次构建的 `dist/`；修改内容后要再次 `npm run build`。

确认后，将整个站点源码、`package.json`、`package-lock.json` 纳入自己的 Git 仓库。不要把 `.env`、状态目录或构建缓存纳入版本控制。后续其他设备和 CI 用 `npm ci` 安装锁定依赖，然后构建并部署 `dist/`。

保存内容、同步 Git、部署网站是三个步骤。只有托管平台执行了新构建并发布产物，访客才会看到更新。评论、搜索、音乐和 AI 的外部服务需要另行配置；安装主题不会自动创建这些服务。

## 7. 可选：用 submodule 固定主题源码

仅使用主题时，npm 依赖已经足够。需要一起开发主题或从同一站点仓库运行 Studio 时，可在已初始化的博客 Git 仓库中加入 submodule：

```sh
git submodule add https://github.com/iWangJiaxiang/Astro-Theme-WonderShine.git themes/wondershine
```

submodule 记录源码版本，`package.json` 和 `package-lock.json` 记录博客实际安装的主题版本。切换 submodule 不会自动更新 npm 依赖；两者需要分别管理。

示例 Starter 没有 `theme:sync`、`studio:setup` 或 `verify` 这类个人博客脚本；本文使用主题仓库实际提供的命令。
