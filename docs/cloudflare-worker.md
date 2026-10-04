# Cloudflare Worker 部署

当前入口是 `apps/server/src/worker.ts`，Worker 同时托管 API 和 `apps/web/dist` 静态资源。D1 只保存播放统计、去重键和站点配置，不需要额外部署 Node 服务。

首次部署需要先安装依赖并构建前端：

```sh
pnpm install --frozen-lockfile
pnpm --filter @animaku/web build
```

数据库迁移和部署使用 Wrangler：

```sh
npx wrangler d1 migrations apply animaku --remote --config wrangler.jsonc
npx wrangler deploy --config wrangler.jsonc
```

可选的 Wrangler 变量：`BANGUMI_API`、`BANGUMI_NEXT_API`、`BANGUMI_USER_AGENT`、`DANDAN_APP_ID`、`DANDAN_APP_SECRET`、`MEDIA_SECRET`、`ADMIN_USERNAME`、`ADMIN_SECRET`、`CORS_ORIGINS`。这些变量通过 Cloudflare 的 Worker Variables / Secrets 管理，不写入代码仓库。建议至少设置 `MEDIA_SECRET`，让播放票据在重新部署后仍由明确的密钥控制。

当前 Cloudflare 版本要求先登录才能进入主页。管理员也使用普通账号登录：把账号名写入 `ADMIN_USERNAME`，把密码写入 Worker Secret `ADMIN_PASSWORD`，服务端会在首次登录时自动创建/修复管理员账号并建立正常会话，设置页不再要求重复输入 `ADMIN_SECRET`。数据库只保存该密码的哈希。`ADMIN_SECRET` 仅作为旧脚本和自托管集成的兼容鉴权入口保留。

当前仓库的 Wrangler 示例把 `ADMIN_USERNAME` 设为 `admin`。设置 `ADMIN_PASSWORD` 后，直接在登录页用 `admin` 和该密码登录即可，不需要先注册。正式开放给其他人注册前，建议先完成一次管理员登录，再把 `ACCOUNT_REGISTRATION_ENABLED` 改为 `false`。

如果你改用了其他管理员账号名，可以通过 Cloudflare Worker Variables 修改 `ADMIN_USERNAME`：

```sh
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
```

当 Cloudflare 出口被 B 站、Animoe 或 TVTFun 拒绝时，可以启用一个只允许固定域名、只转发小响应的外部出口。`wrangler.jsonc` 已配置 `UPSTREAM_PROXY_URL`；对应的 `UPSTREAM_PROXY_TOKEN` 必须作为 Worker Secret 写入，不能放进变量文件：

```sh
npx wrangler secret put UPSTREAM_PROXY_TOKEN --config wrangler.jsonc
npx wrangler deploy --config wrangler.jsonc
```

提示时输入你在外部出口服务中设置的同一个 `PROXY_TOKEN`。没有这个 Secret 时，Worker 会继续使用原来的直连路径；配置后只会在固定上游返回 403/412 时才尝试备用出口。

当前版本已迁移 Bangumi、弹弹、B 站弹幕入口、统计、站点配置、规则搜索/分集/解析、固化视频源搜索/分集/解析，以及 HLS 播放票据和媒体流网关；图标上传仍需要 R2，当前使用 Assets 中的默认图标。B 站会按出口 IP 返回 412 拦截页，这属于上游限制，Worker 本身无法保证每个 BV/番剧都能取到 XML 弹幕。

播放票据包含加密的短期资产快照，解析请求和媒体请求落到不同 Worker 实例时仍可继续播放；生产环境请保留 `MEDIA_SECRET` Secret，不要改成写入仓库的明文变量。
