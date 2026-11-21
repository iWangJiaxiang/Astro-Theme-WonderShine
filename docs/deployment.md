# 独立部署

部署前先完成 [从零搭建](getting-started.md) 或 [Zola 迁移](migration.md)，确认独立站点能在本机构建。

## 静态博客

在独立站点目录运行 `npm ci && npm run build`，部署 `dist/`。可用任意静态托管，不依赖 Zola 或运行中的 Node.js 网站服务器。Demo 的 CI 只构建和验证，不会自动发布到个人站点。

### 用 Studio 选择主题版本

在 Studio 的「外观样式 → 主题版本」选择「最新」(`latest`)、「预览」(`next`) 或「开发」(`canary`)。默认跟随最新稳定版。关闭「固定版本」时，每次 `npm run build` 都查询所选 npm 渠道；开启后可以填写「指定版本」，例如 `0.2.1`，也可以留空使用当前渠道的版本。Studio 在保存时联网核对版本，把具体版本写入站点 `config.toml` 的 `extra.theme.version`。固定期间切换渠道，会在保存时重新固定到新渠道的当前版本。之后每次部署直接读取仓库中的配置，Studio 可以关闭。固定的版本独立于 npm 标签后续的移动。

新 Starter 已包含构建前脚本。已有的独立 npm 博客只需复制 [theme-channel.mjs](../examples/starter/scripts/theme-channel.mjs) 到站点的 `scripts/`，在站点根目录执行一次：

```sh
npm pkg set 'scripts.prebuild=node scripts/theme-channel.mjs'
```

若站点已有 `prebuild`，将 `node scripts/theme-channel.mjs` 加到现有命令前面并用 `&&` 连接。提交脚本与 `package.json`，让部署平台执行 `npm ci && npm run build`。脚本仅为这次构建选择主题版本，站点依赖清单与锁文件继续提供初始安装。源码 workspace 和显式 `file:` 主题依赖沿用本地包；独立博客要跟随渠道，请先按[安装说明](npm-releases.md#选择安装渠道)切换到 npm 依赖。配置保存后，按站点原有流程同步并部署。

## Creator Studio

Studio 位于 `apps/studio`，与主题及个人内容分离。

1. 在仓库根目录安装依赖，运行 `npm run studio:build`。
2. `npm run setup -w @wondershine/studio` 生成本地 `.env`，或参照 `.env.example` 配置服务端环境变量。
3. 本地模式明确指定 `STUDIO_SITE_ROOT`，建议绝对路径；Git 模式指定 `STUDIO_GIT_URL`、分支和访问凭据。
4. `npm run start -w @wondershine/studio` 启动服务，默认监听配置的服务端端口。
5. 反向代理的公开地址与 `STUDIO_ORIGIN` 一致，非本机部署使用 HTTPS。

会话密钥、管理员密码哈希、OIDC、Git token 和 AI 密钥只属于 Studio 服务端环境，不放入主题包、站点公共资源或 VITE_ 变量。在线 Git 模式会推送保存结果；配置持久工作区后改为显式提交与同步，见 [工作区说明](studio-workspaces.md)。静态托管平台需监听内容仓库变更并重新构建。

EdgeOne 等适配器源码保留在 Studio，部署时使用仓库根 lockfile 安装工作区，再构建 Studio；旧的子模块部署说明不再适用。本次验收不包含真实云服务发布、OIDC、付费 AI 或远程 Git 推送。


## 桌面与移动 App

App 使用同一套 React 编辑界面。直连 Git 模式在设备上保存工作区，不需要另起 Node 服务；其 API key 通过客户端设置输入，仅保留在当前连接。连接自建 Studio 时，认证、Git 和 AI 仍由该服务处理。

构建命令、原生工具链要求与已验证范围见 [Studio apps](studio-apps.md)。目前不提供已发布的应用商店安装步骤，移动端仍需开发者准备工具链及签名环境。
