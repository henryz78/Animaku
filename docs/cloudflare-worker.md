# Cloudflare Worker 部署

当前入口是 `apps/server/src/worker.ts`，Worker 同时托管 API 和 `apps/web/dist` 静态资源。D1 保存用户账号、会话、云端同步数据、播放统计、去重键和站点配置，不需要额外部署 Node 服务。

## GitHub 推送自动部署（现有主站）

主站使用 Cloudflare Workers Builds，代理仍使用 Vercel。连接现有的 `animaku` Worker，沿用当前 D1 数据库、域名和运行时密钥。仓库只保留入口、静态资源和兼容模式等技术配置，运行时变量和数据库绑定由 Cloudflare 网页端管理。

在 Cloudflare 控制台进入 **Workers & Pages → animaku → Settings → Build / Builds**，连接 GitHub 后填写：

| 设置 | 值 |
| --- | --- |
| Git 仓库 | `henryz78/Animaku` |
| 生产分支 | `master` |
| 根目录 | 仓库根目录 `/`，不要选 `apps/web` |
| 构建命令 | `pnpm build:cloudflare` |
| 部署命令 | `pnpm deploy:cloudflare` |
| 构建变量 | `PNPM_VERSION=9.15.0` |

Node 版本由根目录 `.node-version` 固定为 `24.14.1`。Wrangler 是仓库中锁定版本的开发依赖，Cloudflare 会先根据 `pnpm-lock.yaml` 安装依赖。构建命令会检查三个工作区的类型并构建前端；Worker 服务端由发布命令直接打包，不需要启动或发布 Node 服务。

现阶段只启用 `master` 的生产部署，关闭其他分支的自动预览，避免测试版本使用生产数据库。Workers Builds 的构建设置、自动安装行为和版本覆盖方式见 [构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)及[构建环境](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

**运行时变量与构建变量分开：** `ADMIN_PASSWORD`、`MEDIA_SECRET`、`UPSTREAM_PROXY_TOKEN`、`TMDB_API_KEY` 等继续放在 Worker 的 **Settings → Variables & Secrets**，不要复制到 GitHub 或前端构建变量。构建所需的非密钥选项（例如 `VITE_SITE_URL`）才放在 Build Variables 中。

`wrangler.jsonc` 不声明 `vars`、D1 数据库 ID、R2 桶或 KV 命名空间。`keep_vars` 配合 Cloudflare 上传 API 的 `keep_bindings` 保留网页端的普通变量、密钥以及 D1 / R2 / KV 绑定，后续在网页修改它们不会被代码中的旧值覆盖。Wrangler 暂无对应的正式顶层绑定保留选项，因此通过 `unsafe.metadata` 透传已公开的 API 参数，并固定 Wrangler 版本；不要只删掉绑定声明而同时删掉这段保留配置。[变量说明](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)、[上传 API 的 keep_bindings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)

在 Worker 的 **Bindings** 中确认有 D1 绑定：变量名 `DB`，选择现有的 `animaku` 数据库。`ASSETS` 是随代码发布的前端静态资源，由技术配置维护，不需要手动绑定。当前保留清单覆盖普通变量、密钥、D1、R2、KV；以后新增其他类型的绑定时需先把该类型加入清单，不能假定所有资源都会自动保留。

首次连接后运行一次构建，确认构建日志和部署均成功，再检查 `/api/health` 返回 JSON、登录正常、详情页和播放正常。后续推送到 `master` 会自动发布；没有完成 GitHub 连接和首次构建前，不能视为已启用自动部署。

现有数据库本次无需重新迁移。未来若有数据库结构变化，先核对迁移再单独执行，不把远程迁移放入每次自动发布命令。

## 本地检查与手动部署

在仓库根目录使用同一套命令：

```sh
pnpm install --frozen-lockfile
pnpm build:cloudflare
pnpm check:cloudflare
pnpm deploy:cloudflare
```

`check:cloudflare` 只打包检查，不上传、不修改线上数据库；先运行构建，确保 `apps/web/dist` 是当前代码的产物。只有 `deploy:cloudflare` 会发布。

首次部署到新账号时，在网页创建自己的 D1 并绑定为 `DB`，再在 D1 控制台按顺序执行 `apps/server/migrations/` 中的 SQL。仓库不再保存任何账号的数据库 ID；自动发布也不会新建数据库或执行 SQL。若习惯 CLI，可针对明确的数据库逐个执行迁移文件，例如：

```sh
pnpm exec wrangler d1 execute YOUR_DATABASE_NAME --remote --file apps/server/migrations/0001_cloudflare.sql
```

可选的 Wrangler 变量：`BANGUMI_API`、`BANGUMI_NEXT_API`、`BANGUMI_USER_AGENT`、`DANDAN_APP_ID`、`DANDAN_APP_SECRET`、`MEDIA_SECRET`、`ADMIN_USERNAME`、`ADMIN_SECRET`、`CORS_ORIGINS`。这些变量通过 Cloudflare 的 Worker Variables / Secrets 管理，不写入代码仓库。建议至少设置 `MEDIA_SECRET`，让播放票据在重新部署后仍由明确的密钥控制。

当前 Cloudflare 版本要求先登录才能进入主页。管理员也使用普通账号登录：把账号名写入 `ADMIN_USERNAME`，把密码写入 Worker Secret `ADMIN_PASSWORD`，服务端会在首次登录时自动创建/修复管理员账号并建立正常会话，设置页不再要求重复输入 `ADMIN_SECRET`。数据库只保存该密码的哈希。`ADMIN_SECRET` 仅作为旧脚本和自托管集成的兼容鉴权入口保留。

在网页端把 `ADMIN_USERNAME` 设为你希望使用的账号名，并将 `ADMIN_PASSWORD` 设为密钥。然后直接在登录页用该账号和密码登录，不需要先注册。

是否允许新用户注册在网站的 **设置 → 站点运维与管理 → 云端账号管理 → 允许新用户注册** 中控制，切换后自动保存到 D1。关闭注册不影响已有账号登录，登录页会隐藏注册入口。新部署无需设置 `ACCOUNT_REGISTRATION_ENABLED`，默认关闭注册；旧部署的该变量只作为尚未保存面板设置时的默认值，面板保存后始终以 D1 中的设置为准。注册开关与站名、图标独立保存，不会被重置图标或站点外观清除，也不需要新增数据库迁移。

当 Cloudflare 出口被 B 站、Animoe 或 TVTFun 拒绝时，可以启用一个只允许固定域名、只转发小响应的外部出口。在网页端设置普通变量 `UPSTREAM_PROXY_URL` 为代理根地址，并设置密钥 `UPSTREAM_PROXY_TOKEN` 为代理中的同一个 `PROXY_TOKEN`。现有代理地址为 `https://animaku-egress-proxy.vercel.app`，已有配置会继续保留。没有代理密钥时，Worker 会继续使用原来的直连路径；配置后只会在固定上游返回 403/412 时才尝试备用出口。

当前版本已迁移 Bangumi、弹弹、B 站弹幕入口、统计、站点配置、规则搜索/分集/解析、固化视频源搜索/分集/解析，以及 HLS 播放票据和媒体流网关；图标上传仍需要 R2，当前使用 Assets 中的默认图标。B 站会按出口 IP 返回 412 拦截页，这属于上游限制，Worker 本身无法保证每个 BV/番剧都能取到 XML 弹幕。

播放票据包含加密的短期资产快照，解析请求和媒体请求落到不同 Worker 实例时仍可继续播放；生产环境请保留 `MEDIA_SECRET` Secret，不要改成写入仓库的明文变量。
