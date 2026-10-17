# Animaku 备用出口代理

这是给 Animaku Cloudflare Worker 使用的极小型 Vercel Function。它只在 Worker 直接访问 B 站、Animoe 或 TvTFun 被拦截时提供备用出口。

当前版本只代理小响应（最多 8 MB），用于搜索、番剧分集、B 站弹幕和播放列表解析。它暂时不会代理完整视频文件或视频分片，避免把 Vercel 免费流量快速消耗掉。

## 部署

这个代理目前仍位于主仓库的 `animaku-egress-proxy/`，尚未拆分为独立仓库。可通过 Git 连接 Vercel，配置如下；已有 Vercel 项目可以连接仓库并沿用域名与环境变量。

1. 在 Vercel 导入 GitHub 仓库 `henryz78/Animaku`，Root Directory 选择 `animaku-egress-proxy`，生产分支选 `master`。
2. Framework Preset 选择 `Other`，不需要 Build Command，也不需要 Output Directory。
3. 添加环境变量 `PROXY_TOKEN`，值设为自己生成的一串随机字符串。
4. 部署后访问 `https://你的代理域名.vercel.app/api/health` 检查服务。
5. 在主 Worker 的运行时设置中，将 `UPSTREAM_PROXY_URL` 设为代理根地址（不带 `/api/health`），Secret `UPSTREAM_PROXY_TOKEN` 设为同一个 `PROXY_TOKEN`。密钥不要放进 URL 或提交到仓库。

完成 Git 连接后，生产分支推送会触发 Vercel 自动部署，无需每次手动上传目录。[Vercel Git 部署说明](https://vercel.com/docs/git)

以后拆成独立仓库时，上传此目录内的文件即可，Root Directory 改为新仓库根目录；主站与代理应各自连接对应仓库。拆分和连接需要另行完成，本文不表示现有线上项目已经启用 Git 自动部署。

## 接口

```http
POST /api/egress
X-Egress-Token: <PROXY_TOKEN>
Content-Type: application/json

{"url":"https://api.bilibili.com/x/web-interface/view?bvid=BV17x411w7KC"}
```

允许的上游域名只有：`api.bilibili.com`、`www.bilibili.com`、`animoe.org`、`www.animoe.org`、`tvtfun.net`、`www.tvtfun.net`。

请求只允许 `POST`，实际向上游只发 `GET`。代理会检查最终跳转地址、限制 HTTPS、拒绝非白名单域名，并限制响应大小为 8 MB。

## 本地检查

```sh
npm test
```

这个目录不依赖主项目的数据库、Wrangler 或 Node 服务，可以单独导入 Vercel。
