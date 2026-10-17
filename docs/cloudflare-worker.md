# Cloudflare Worker 部署

当前入口是 `apps/server/src/worker.ts`，Worker 同时托管 API 和 `apps/web/dist` 静态资源。D1 保存用户账号、会话、云端同步数据、播放统计、去重键和站点配置，不需要额外部署 Node 服务。

## 1. 从零创建 D1 并初始化

在 Cloudflare 控制台进入 **存储和数据库 → D1 SQL 数据库 → 创建数据库**，名称可以使用 `animaku`。数据库名称可以自定，后面绑定到 Worker 的变量名必须是 `DB`。

打开数据库的 **Console / 控制台**，按下面顺序将每个文件的完整内容粘贴并执行一次：

1. [0001_cloudflare.sql](../apps/server/migrations/0001_cloudflare.sql)：播放统计、去重和站点配置。
2. [0002_bangumi_data_mapping.sql](../apps/server/migrations/0002_bangumi_data_mapping.sql)：跨站条目映射。
3. [0003_account_system.sql](../apps/server/migrations/0003_account_system.sql)：账号、会话和云同步。

应能看到 `anime_play_counts`、`stats_view_dedup`、`site_config`、`bangumi_data_mapping`、`account_users`、`account_sessions`、`account_data` 七张业务表。现有数据库无需因注册开关更新而重新初始化；数据库里的账号和同步数据也不属于视频缓存。

## 2. 创建 Worker 并绑定数据库

进入 **Workers & Pages → 创建应用 → Start with Hello World → Deploy**，先创建名为 `animaku` 的空壳 Worker，再进行绑定和变量设置。名称应与仓库 `wrangler.jsonc` 中的 `name` 一致；使用其他名字时，需要同步调整部署名称。同一账号下旧的同名 Worker 会占用该名称。

进入新 Worker 的 **Bindings / 绑定 → 添加绑定 → D1 数据库**，变量名填大写 `DB`，选择上一步创建的数据库并保存。`ASSETS` 会随正式代码发布，不需要手动绑定。

先创建空壳并保存绑定，是因为发布配置只保留已有资源，不会替你创建数据库或补建数据表。[Cloudflare 创建与绑定说明](https://developers.cloudflare.com/d1/get-started/)

## 3. 在网页端设置运行时变量

进入 Worker 的 **Settings → Variables & Secrets**，保存以下设置。密钥不需要写入 GitHub，也不要放入前端构建变量。

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 文本 | 自己的管理员账号，例如 `admin` |
| `ADMIN_PASSWORD` | Secret | 自己设置的管理员密码，至少 8 个字符 |
| `MEDIA_SECRET` | Secret | 自己生成并保留的一串至少 32 字符的随机密钥，用于播放票据 |
| `UPSTREAM_PROXY_URL` | 文本，可选 | 自己的备用出口根地址，见[代理说明](../animaku-egress-proxy/README.md) |
| `UPSTREAM_PROXY_TOKEN` | Secret，可选 | 与备用出口中的 `PROXY_TOKEN` 相同 |
| `TMDB_API_KEY` | Secret，可选 | TMDB Key，用于可靠匹配时补充单集剧照；不能保证所有作品每集都有图片 |
| `DANDAN_APP_ID` / `DANDAN_APP_SECRET` | Secret，可选 | 弹弹play 独立应用凭据，留空使用现有回退凭据 |

首次部署不用填写 `ACCOUNT_REGISTRATION_ENABLED`，注册默认关闭，管理员仍可直接登录。后续在网站管理面板开启注册，见下文“管理员与注册控制”。`MEDIA_SECRET` 重新设置会使之前签发的播放票据失效。

其他可选运行时变量包括 `BANGUMI_API`、`BANGUMI_NEXT_API`、`BANGUMI_USER_AGENT`、`CORS_ORIGINS`。Worker 的 Bangumi API 覆盖值应填写完整 HTTPS 根地址，通常留空即可，不要照搬 Node `.env` 中的 `mirror` / `official` 预设。

## 4. GitHub 推送自动部署

主站使用 Cloudflare Workers Builds，备用出口使用 Vercel。连接已经创建并配置好的 `animaku` Worker；如果沿用旧站，则保留现有 D1 数据库、域名和运行时密钥。仓库只保留入口、静态资源和兼容模式等技术配置，运行时变量和数据库绑定由 Cloudflare 网页端管理。

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

首次连接后运行一次构建，确认构建日志和部署均成功，再检查：

- `/api/health` 返回 JSON，`ok`、`d1Configured`、`assetsConfigured` 都是 `true`。
- `/api/account/me` 的 `available` 是 `true`；未登录时 `user` 为 `null` 是正常情况。
- 管理员能登录，注册开关可保存，刷新后状态不变。
- 详情、源搜索、播放和同账号进度同步正常。

后续推送到 `master` 会自动发布；没有完成 GitHub 连接和首次构建前，不能视为已启用自动部署。绑定保留通过 Wrangler 的实验透传字段实现，工具版本已固定；首次线上构建后仍需核对实际绑定与密钥，不能只看打包成功。

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

## 管理员与注册控制

当前 Cloudflare 版本要求先登录才能进入主页。管理员也使用普通账号登录：把账号名写入 `ADMIN_USERNAME`，把密码写入 Worker Secret `ADMIN_PASSWORD`，服务端会在首次登录时自动创建/修复管理员账号并建立正常会话，设置页不再要求重复输入 `ADMIN_SECRET`。数据库只保存该密码的哈希。`ADMIN_SECRET` 仅作为旧脚本和自托管集成的兼容鉴权入口保留。

在网页端把 `ADMIN_USERNAME` 设为你希望使用的账号名，并将 `ADMIN_PASSWORD` 设为密钥。然后直接在登录页用该账号和密码登录，不需要先注册。

是否允许新用户注册在网站的 **设置 → 站点运维与管理 → 云端账号管理 → 允许新用户注册** 中控制，切换后自动保存到 D1。关闭注册不影响已有账号登录，登录页会隐藏注册入口。新部署无需设置 `ACCOUNT_REGISTRATION_ENABLED`，默认关闭注册；旧部署的该变量只作为尚未保存面板设置时的默认值，面板保存后始终以 D1 中的设置为准。注册开关与站名、图标独立保存，不会被重置图标或站点外观清除，也不需要新增数据库迁移。

当 Cloudflare 出口被 B 站、Animoe 或 TVTFun 拒绝时，可以启用一个只允许固定域名、只转发小响应的外部出口。在网页端设置普通变量 `UPSTREAM_PROXY_URL` 为代理根地址，并设置密钥 `UPSTREAM_PROXY_TOKEN` 为代理中的同一个 `PROXY_TOKEN`。现有代理地址为 `https://animaku-egress-proxy.vercel.app`，已有配置会继续保留。没有代理密钥时，Worker 会继续使用原来的直连路径；配置后只会在固定上游返回 403/412 时才尝试备用出口。

## 数据边界与当前限制

- D1 保存账号、会话、云同步、站点设置、统计和条目映射。视频存放在用户设备的 IndexedDB，JSON 数据备份不包含视频，详见[本机缓存与下载](offline-cache.md)。
- 角色、制作人员、评价、评论和剧照来自外部数据源，接口空结果、缺图和上游限制仍可能存在。
- Worker 的图标上传接口当前返回 `501`，可以使用默认图标或外部图片 URL；仅绑定一个 R2 桶不会自动启用上传。
- 上游 Node 入口的定时 IndexNow、站点地图与爬虫 SEO 路由没有等同迁移到 Worker。Worker 的 HTML 品牌替换不等于完整 Node SEO 功能。
- Node/Docker 入口尚未提供本分支的账号和云同步接口，不能替代完整 Worker 部署；VPS CDN 指南中的监听端口、本地 SQLite、Nginx 与回源配置不适用于此流程。
- B 站及其他片源会按出口 IP 拒绝请求。备用出口只转发白名单中的小响应，不代理整集视频或分片，也不保证绕过所有验证。代理目前仍在本仓库 `animaku-egress-proxy/`，拆分为独立仓库尚未完成。

播放票据包含加密的短期资产快照，解析请求和媒体请求落到不同 Worker 实例时仍可继续播放；生产环境请保留 `MEDIA_SECRET` Secret，不要改成写入仓库的明文变量。
