# 独立部署

部署前先完成 [从零搭建](getting-started.md) 或 [Zola 迁移](migration.md)，确认独立站点能在本机构建。

## 静态博客

在独立站点目录运行 `npm ci && npm run build`，部署 `dist/`。可用任意静态托管，不依赖 Zola 或运行中的 Node.js 网站服务器。Demo 的 CI 只构建和验证，不会自动发布到个人站点。

### 用 Studio 选择主题版本

在 Studio 的「主题维护 → 主题版本」选择「最新」(`latest`)、「预览」(`next`) 或「开发」(`canary`)，然后保存。Studio 查询 npm，将具体版本写入博客 `package.json` 的 `dependencies["@wondershine/theme"]`，并同步已有的 npm v3 锁文件。渠道和固定偏好保存在 `config.toml`。开启「固定版本」时可以填写已发布的版本号，留空则固定到该渠道的当前版本。

「检查更新」可以比较仓库版本和 npm 渠道版本。点击「更新到此版本」后，Studio 保存新版本。发布新 canary 后，可重复此操作。在线 Git 模式会推送；持久工作区需要同步，本地目录需要自行提交并推送。CI 执行 `npm ci && npm run build`，部署平台的日志记录实际发布结果。

已有站点若曾添加 `scripts/theme-channel.mjs` 的 `prebuild` 钩子，请从构建命令中移除这一项，保留其他构建步骤。发布脚本应使用仓库提交的依赖。依赖树发生变化时，需要用 npm 重新生成锁文件；Studio 会在写入前提示。使用本地源码包的站点可按[安装说明](npm-releases.md#选择安装渠道)切换为独立 npm 依赖。

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
