<div align="center">

  <p><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

  <h1>Animaku</h1>

  <img src="apps/web/public/android-chrome-512x512.png" width="512" alt="Animaku logo" />

  <p>
    <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 19" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Vite-6-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite 6" />
    <img src="https://img.shields.io/badge/Hono-API-E36002?style=for-the-badge&logo=hono&logoColor=white" alt="Hono API" />
    <img src="https://img.shields.io/badge/WebGPU-Anime4K-9cf?style=for-the-badge&logo=webgpu&logoColor=white" alt="WebGPU Anime4K" />
    <img src="https://img.shields.io/badge/Cloudflare_Workers-Ready-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  </p>

  <p>现代化自托管二次元番剧流媒体客户端。开箱内置优质 1080P 直链源，集成 Bangumi 放送表、弹幕聚合、WebGPU 实时超分与智能跳过 OP/ED。专为追番设计 (～￣▽￣)～</p>

</div>

本仓库是 [uerax/Animaku](https://github.com/uerax/Animaku) 的二次开发版本，主要部署方式为 **Cloudflare Workers + D1**，增加网站账号、云端同步、管理员用户管理、本机缓存与下载等功能，并继续跟进官方更新。

## 屏幕截图

<p align="center">
  <img src="docs/screenshots/watch-player.png" alt="Animaku 播放页" width="900" />
</p>

## 功能 / 开发计划

- [X]  1080P 直链播放
- [X]  WebGPU 实时超分 (Anime4K)
- [X]  弹幕播放与聚合 (弹弹play)
- [X]  本地弹幕导入 (.xml / Pakku)
- [X]  进度条高能弹幕热力图
- [X]  智能跳过片头片尾 (OP/ED)
- [X]  智能去广告切片
- [X]  多视频源支持与快捷换源
- [X]  视频源自定义排序与独立配置
- [X]  番剧周更时间表 (Bangumi)
- [X]  番剧搜索与详情浏览
- [X]  个人追番管理与 Bangumi 进度同步
- [X]  智能番剧推荐
- [X]  桌面宽屏模式 / 网页全屏 / 系统全屏
- [X]  画面比例切换 (16:9 / 4:3 / 铺满 / 拉伸)
- [X]  原画截图 / 画面翻转 / 画中画
- [X]  播放器信息统计 (Stats for Nerds)
- [X]  移动端触控手势操作
- [X]  播放历史记录
- [X]  深色 / 浅色模式
- [X]  Cloudflare Workers + D1，GitHub 推送自动部署
- [X]  网站账号登录、跨设备观看记录与设置同步
- [X]  管理员用户管理与注册开关
- [X]  本机缓存、下载导出与个人数据备份
- [X]  角色 / 制作人员详情弹窗、评价及 TMDB 辅助单集图片
- [ ]  还有更多 (/・ω・＼)

## 部署与运行

按 [Cloudflare Worker 部署指南](docs/cloudflare-worker.md) 配置 GitHub Actions 的部署凭据并运行工作流，即可自动创建或复用 D1、初始化数据表、绑定并部署 Worker。首次部署后在 Cloudflare 网页端设置管理员账号密码等运行时变量。主站同时提供网页和 API，不需要额外的 Node 服务，也不需要 Cloudflare 直接连接 GitHub。

| 工作流 | 自动触发 | GitHub Repository Secrets |
| --- | --- | --- |
| [Deploy Cloudflare Worker](.github/workflows/cloudflare-deploy.yml) | 推送 `master`，或手动运行 | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` |

默认创建或更新 `animaku` Worker，数据库默认也叫 `animaku`；自定名称可通过 GitHub 仓库变量 `CLOUDFLARE_WORKER_NAME` / `CLOUDFLARE_D1_NAME` 设置。后续发布优先使用 Worker 实际的 `DB` 绑定，只应用待执行的 D1 迁移，保留网页端的运行时变量、密钥和 D1 / R2 / KV 绑定。API Token 需要目标账号的 Workers Scripts 编辑和 D1 编辑权限。

首次部署默认关闭注册。配置 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 后直接登录管理员，在 **设置 → 站点运维与管理 → 云端账号管理** 中开启注册，无需设置 `ACCOUNT_REGISTRATION_ENABLED`。

部署与数据说明：

- [Cloudflare 从零创建、变量、自动部署及限制](docs/cloudflare-worker.md)
- [本机缓存、下载与浏览器兼容限制](docs/offline-cache.md)
- [可选的外部备用出口代理](animaku-egress-proxy/README.md)
- [官方版本合并记录](docs/upstream-sync.md)

仓库保留上游 Node/Docker 入口，但账号和云同步接口目前由 Worker 实现，Node 入口不能替代完整的账号部署。`docker-compose.yml` 默认拉取官方镜像，使用它不会发布本分支的修改。

<details>
<summary>本地开发与调试</summary>

```bash
# 环境要求：Node.js ≥ 22，推荐使用 .node-version 指定的版本；pnpm 9.15.0
git clone https://github.com/henryz78/Animaku.git animaku
cd animaku
pnpm install
cp .env.example .env
pnpm dev
```

浏览器打开 `http://localhost:5173` 调试前端与 Node API；此开发入口尚未提供 Worker 的账号接口，不能据此验证完整登录流程。Cloudflare 打包检查使用 `pnpm build:cloudflare` 和 `pnpm check:cloudflare`。
</details>

## 快捷键与手势

### 键盘快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Space` / `K` | 播放 / 暂停 |
| `←` / `→` | 快退 5 秒 / 快进 5 秒 |
| 长按 `←` / `→` | 临时 2 倍速，松开恢复原速度 |
| `↑` / `↓` | 音量调整 ±5% |
| `F` | 系统全屏 |
| `Shift + W` | 网页全屏 |
| `W` | 切换画面比例 |
| `D` | 切换弹幕显示状态 |
| `Alt + M` | 打开弹幕设置面板 |
| `,` / `.` / `/` | 弹幕延后 / 提前 / 重置偏移 |
| `P` / `N` | 上一集 / 下一集 |
| `鼠标右键` | 高级菜单（信息统计 / 截图 / 镜像 / 超分） |

### 移动端手势

- **双击左侧 / 右侧画面**：回退 / 快进 5 秒
- **双击中间画面**：播放 / 暂停
- **长按画面**：临时 2 倍速，松开恢复原速度
- **横向滑动**：快速寻轨快进 / 快退

## Q&A

<details>
<summary>使用者 Q&A</summary>

#### Q: 为什么少数番剧播放时会有广告？
A: 本项目不包含任何广告。广告来自第三方切片源，可在设置中开启「广告过滤」，或在播放页右侧切换其他视频源。

#### Q: 为什么开启超分辨率 (Anime4K) 后播放卡顿？
A: 超分辨率依赖本地显卡算力 (WebGPU)。若硬件性能有限，建议在设置或右键菜单中选择「效率档」，或仅针对 720P 及以下分辨率开启。

#### Q: 为什么部分视频源无法播放或加载缓慢？
A: 部分第三方源可能存在临时网络波动或反爬限制，可在右侧源抽屉中一键切换其他线路。

#### Q: 弹幕获取失败或提示未配置？
A: 默认使用内置公共接口。如需更稳定体验，可在 [弹弹play 开放平台](https://www.dandanplay.com/) 免费申请专属 API 并配置到环境变量中。

</details>

## 免责声明

本软件仅供学习交流与自托管使用。本项目不存储、不分发任何音视频文件，所有视频均索引自互联网第三方公开源。使用本项目需遵守所在地法律法规，并尊重版权方的合法权益。

## 隐私政策

本分支使用网站账号。D1 保存账号与密码哈希、会话摘要，以及账号同步的观看记录、已看集数、搜索记录、播放设置、规则和源绑定等数据；浏览器同时保留本机数据。Bangumi 收藏由 Bangumi 维护，其登录令牌不主动参与本站云同步。

视频缓存与下载文件保存在用户设备，不存入 D1；JSON 数据备份不包含视频。访客分析脚本仅在站长显式配置对应构建变量时注入。具体缓存与导出边界见 [本机缓存与下载](docs/offline-cache.md)。

## 致谢

- [Kazumi](https://github.com/Predidit/Kazumi) —— 优秀的设计与灵感来源
- [Bangumi 番组计划](https://bangumi.tv/) —— 番剧维基数据与更新日历
- [弹弹play](https://www.dandanplay.com/) —— 弹幕库支持
- [Anime4K](https://github.com/bloc97/Anime4K) —— 实时动画超分辨率算法
- [bangumi-oped](https://github.com/uerax/bangumi-oped) —— 片头片尾时间戳数据
