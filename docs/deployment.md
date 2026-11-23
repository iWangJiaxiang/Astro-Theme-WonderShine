# 独立部署

部署前先完成 [从零搭建](getting-started.md) 或 [Zola 迁移](migration.md)，确认独立站点能在本机构建。

## 静态博客

在独立站点目录运行 `npm ci && npm run build`，部署 `dist/`。可用任意静态托管，不依赖 Zola 或运行中的 Node.js 网站服务器。Demo 的 CI 只构建和验证，不会自动发布到个人站点。

### 用 Studio 选择主题版本

在 Studio 的「主题维护 → 主题版本」选择「最新」(`latest`)、「预览」(`next`) 或「开发」(`canary`)，然后保存。Studio 查询 npm，将具体版本写入博客 `package.json` 的 `dependencies["@wondershine/theme"]`，并同步已有的 npm v3 锁文件。渠道和固定偏好保存在 `config.toml`。开启「固定版本」时可以填写已发布的版本号，留空则固定到该渠道的当前版本。

「检查更新」可以比较仓库版本和 npm 渠道版本。点击「更新到此版本」后，Studio 保存新版本。在线 Git 模式会推送。支持同步的持久工作区会在主题维护页提交修改并同步当前分支，日志显示每一步的结果。推送失败后可以在原页重试同步。本地目录仍需自行提交并推送。普通 `npm ci` 安装仓库锁定的版本。

要在每次流水线启动时跟随渠道，可使用 Starter 提供的 `npm run theme:update`。已有站点可复制 [theme-channel.mjs](../examples/starter/scripts/theme-channel.mjs)，将该 npm 命令设为 `node scripts/theme-channel.mjs --write-lock`。流水线先用 `npm ci` 安装已提交的依赖，再运行更新命令。关闭固定版本时会查询所选渠道，开启时直接使用保存的版本。只有依赖清单或锁文件发生变化时才需再次执行 `npm ci`，随后按原流程构建。需要记录实际部署版本的站点，可在构建和验证成功后提交这两个文件。手机上的 Studio 可以关闭。

如已使用旧的 `prebuild` 钩子，改用上述流水线步骤时请移除重复调用，保留其他构建步骤。使用本地源码包的站点可按[安装说明](npm-releases.md#选择安装渠道)切换为独立 npm 依赖。

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
