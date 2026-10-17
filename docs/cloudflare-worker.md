# Cloudflare Worker 部署

当前入口是 `apps/server/src/worker.ts`，Worker 同时托管 API 和 `apps/web/dist` 静态资源。D1 保存用户账号、会话、云端同步数据、播放统计、去重键和站点配置，不需要额外部署 Node 服务。

## 1. 从零创建 D1

在 Cloudflare 控制台进入 **存储和数据库 → D1 SQL 数据库 → 创建数据库**，名称可以使用 `animaku`。数据库名称可以自定，后面绑定到 Worker 的变量名必须是 `DB`。

使用下文 GitHub Actions 自动部署时，首次发布会自动按顺序执行以下迁移，不需要手动粘贴 SQL。若只使用本地手动部署，可以在数据库的 **Console / 控制台** 按顺序执行文件的完整内容：

1. [0001_cloudflare.sql](../apps/server/migrations/0001_cloudflare.sql)：播放统计、去重和站点配置。
2. [0002_bangumi_data_mapping.sql](../apps/server/migrations/0002_bangumi_data_mapping.sql)：跨站条目映射。
3. [0003_account_system.sql](../apps/server/migrations/0003_account_system.sql)：账号、会话和云同步。

迁移完成后应能看到 `anime_play_counts`、`stats_view_dedup`、`site_config`、`bangumi_data_mapping`、`account_users`、`account_sessions`、`account_data` 七张业务表。Actions 还会维护 `d1_migrations` 迁移记录表。现有数据库无需因注册开关更新而重新初始化；数据库里的账号和同步数据也不属于视频缓存。

## 2. 创建 Worker 并绑定数据库

进入 **Workers & Pages → 创建应用 → Start with Hello World → Deploy**，先创建名为 `animaku` 的空壳 Worker，再进行绑定和变量设置。使用其他名字时，在下文 GitHub Actions 的仓库变量中设置 `CLOUDFLARE_WORKER_NAME`，无需修改代码。同一账号下旧的同名 Worker 会占用该名称。

进入新 Worker 的 **Bindings / 绑定 → 添加绑定 → D1 数据库**，变量名填大写 `DB`，选择上一步创建的数据库并保存。`ASSETS` 会随正式代码发布，不需要手动绑定。

先创建空壳并保存绑定，是因为工作流只更新已有 Worker，读取其真实 `DB` 绑定来执行迁移，不会另外新建 Worker 或数据库。[Cloudflare 创建与绑定说明](https://developers.cloudflare.com/d1/get-started/)

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

主站使用本仓库的 [GitHub Actions 工作流](../.github/workflows/cloudflare-deploy.yml)，无需 Cloudflare 账号直接连接 GitHub。备用出口仍使用 Vercel，和主站工作流独立。仓库只保留入口、静态资源和兼容模式等技术配置，运行时变量和数据库绑定由 Cloudflare 网页端管理。

在 Cloudflare 创建一个限定到目标账号的 API Token，可使用 **Edit Cloudflare Workers** 模板并补上 **Account → D1 → Edit** 权限。至少需要目标账号的 **Workers Scripts → Edit** 与 **D1 → Edit**，分别用于发布/读取绑定和执行迁移。使用 `workers.dev` 且不在配置中管理域名路由时，无需为此额外授权其他账号或区域。[Cloudflare Actions 凭据说明](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

进入 GitHub 仓库 **Settings → Secrets and variables → Actions → Secrets → New repository secret**，新增：

| Repository secret | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 上述 API Token；不要提交到代码或发到构建日志 |
| `CLOUDFLARE_ACCOUNT_ID` | 目标 Cloudflare 账号的 Account ID，32 位十六进制字符；不是数据库 ID 或 Zone ID |

默认部署到现有的 `animaku` Worker。若名字不同，进入同一页面的 **Variables → New repository variable**，设置 `CLOUDFLARE_WORKER_NAME` 为实际名称。数据库 ID 不用在 GitHub 再填一份：工作流会通过只读 API 查询该 Worker 当前的 `DB` 绑定。

保存后打开 GitHub **Actions → Deploy Cloudflare Worker → Run workflow**，选择 `master` 运行首次发布。以后每次推送 `master` 都会自动运行；其他分支和 PR 不发布到生产。同一时间只执行一次生产发布，不会因新推送中断正在进行的迁移。若之前开过 Cloudflare Workers Builds 自动构建，请关闭其中的 Git 自动部署，避免两套流程重复发布。

工作流依次安装锁定依赖、运行部署准备测试、检查三个工作区的类型、构建前端、检查 Worker 打包、确认已有 Worker 和 `DB` 绑定、执行尚未应用的 D1 迁移，最后发布代码。构建、绑定检查或迁移失败时不会继续发布。Node 版本由 `.node-version` 固定为 `24.14.1`，pnpm 为 `9.15.0`，Wrangler 使用仓库中锁定的版本。

**运行时变量与部署凭据分开：** `ADMIN_PASSWORD`、`MEDIA_SECRET`、`UPSTREAM_PROXY_TOKEN`、`TMDB_API_KEY` 等继续放在 Worker 的 **Settings → Variables & Secrets**，不要复制到 GitHub 或前端构建变量。GitHub 中只需要上面的部署凭据。项目目前的前端构建无需另填变量；以后若需 `VITE_SITE_URL` 等公开构建选项，应显式加到工作流的构建步骤，不能当作运行时密钥。

`wrangler.jsonc` 不声明 `vars`、D1 数据库 ID、R2 桶或 KV 命名空间。`keep_vars` 配合 Cloudflare 上传 API 的 `keep_bindings` 保留网页端的普通变量、密钥以及 D1 / R2 / KV 绑定，后续在网页修改它们不会被代码中的旧值覆盖。Wrangler 暂无对应的正式顶层绑定保留选项，因此通过 `unsafe.metadata` 透传已公开的 API 参数，并固定 Wrangler 版本；不要只删掉绑定声明而同时删掉这段保留配置。[变量说明](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)、[上传 API 的 keep_bindings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)

在 Worker 的 **Bindings** 中确认有 D1 绑定：变量名 `DB`，选择现有的 `animaku` 数据库。`ASSETS` 是随代码发布的前端静态资源，由技术配置维护，不需要手动绑定。当前保留清单覆盖普通变量、密钥、D1、R2、KV；以后新增其他类型的绑定时需先把该类型加入清单，不能假定所有资源都会自动保留。

每次更新的是同一个 Worker，Cloudflare 可能增加一条版本/部署历史，不会每次创建一个新服务或数据库。D1 迁移使用临时配置 `.tmp-cloudflare-d1.json`，只含实际 `DB` 的数据库 ID 和迁移目录，完成后删除；发布 Worker 仍只使用仓库中的 `wrangler.jsonc`，不会把临时配置的绑定或任何运行时变量写回网页设置。

首次发布成功后检查：

- `/api/health` 返回 JSON，`ok`、`d1Configured`、`assetsConfigured` 都是 `true`。
- `/api/account/me` 的 `available` 是 `true`；未登录时 `user` 为 `null` 是正常情况。
- 管理员能登录，注册开关可保存，刷新后状态不变。
- 详情、源搜索、播放和同账号进度同步正常。

没有配置 GitHub Secrets 或尚未完成首次成功发布前，不能视为自动部署已经可用。绑定保留通过 Wrangler 的实验透传字段实现，工具版本已固定；首次线上发布后仍需核对实际绑定与密钥，不能只看打包成功。

`d1_migrations` 记录已执行文件，后续推送只应用新增迁移，不会每次重建数据表或清空账号。当前三个迁移都是 `CREATE ... IF NOT EXISTS`，之前手动初始化过的数据库也可以接入。后续修改表结构应新增编号 SQL 文件，不要改动已经执行过的历史文件；自动运行不代表未来 SQL 可以未经检查。迁移和代码发布不是一个整体事务：若迁移成功后上传失败，迁移会保留，修好后重跑；新增迁移必须兼容仍在运行的旧代码。[D1 迁移记录说明](https://developers.cloudflare.com/d1/reference/migrations/)

## 本地检查与手动部署

在仓库根目录使用同一套命令：

```sh
pnpm install --frozen-lockfile
pnpm build:cloudflare
pnpm check:cloudflare
pnpm deploy:cloudflare
```

`check:cloudflare` 只打包检查，不上传、不修改线上数据库；先运行构建，确保 `apps/web/dist` 是当前代码的产物。只有 `deploy:cloudflare` 会发布。

纯本地手动部署不会自动迁移 D1。首次部署到新账号时，在网页创建自己的 D1 并绑定为 `DB`，再在 D1 控制台按顺序执行 `apps/server/migrations/` 中的 SQL。GitHub Actions 则已包含待执行迁移。仓库不保存任何账号的数据库 ID。若习惯 CLI，可针对明确的数据库逐个执行迁移文件，例如：

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
