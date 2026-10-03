# Animaku 备用出口代理

这是给 Animaku Cloudflare Worker 使用的极小型 Vercel Function。它只在 Worker 直接访问 B 站、Animoe 或 TvTFun 被拦截时提供备用出口。

当前版本只代理小响应（最多 8 MB），用于搜索、番剧分集、B 站弹幕和播放列表解析。它暂时不会代理完整视频文件或视频分片，避免把 Vercel 免费流量快速消耗掉。

## 部署

1. 在 Vercel 导入这个目录：`animaku-egress-proxy`。
2. Framework Preset 选择 `Other`，不需要 Build Command，也不需要 Output Directory。
3. 添加环境变量 `PROXY_TOKEN`，值设为自己生成的一串随机字符串。
4. 部署后访问 `https://你的代理域名.vercel.app/api/health` 检查服务。
5. 把部署后的代理 URL 发给主项目配置。`PROXY_TOKEN` 不要放进 URL，也不要提交到仓库。

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
