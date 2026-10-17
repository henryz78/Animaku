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

  <p>A modern self-hosted anime streaming web client. Built-in 1080P direct streams, Bangumi calendar, danmaku aggregation, WebGPU real-time upscaling, and smart OP/ED skip. Built for anime lovers (～￣▽￣)～</p>

</div>

This is a fork of [uerax/Animaku](https://github.com/uerax/Animaku), primarily deployed on **Cloudflare Workers + D1**. It adds website accounts, cloud sync, administrator user management, and device-local caching and downloads while continuing to integrate upstream updates.

## Screenshots

<p align="center">
  <img src="docs/screenshots/watch-player.png" alt="Animaku Player" width="900" />
</p>

## Features / Roadmap

- [X]  1080P Direct Stream Playback
- [X]  WebGPU Real-time Upscaling (Anime4K)
- [X]  Danmaku Playback & Aggregation (DanDanPlay)
- [X]  Local Danmaku Import (.xml / Pakku)
- [X]  High-Energy Danmaku Heatmap
- [X]  Smart OP/ED Skip
- [X]  Smart Ad-segment Filter
- [X]  Multi-source Support & Quick Switching
- [X]  Custom Source Sorting & Configuration
- [X]  Weekly Broadcast Schedule (Bangumi)
- [X]  Anime Search & Metadata Details
- [X]  Watchlist Management & Bangumi Sync
- [X]  Smart Recommendations
- [X]  Widescreen / Web Fullscreen / Fullscreen
- [X]  Aspect Ratio Control (16:9 / 4:3 / Cover / Fill)
- [X]  Screenshot / Video Flip / Picture-in-Picture
- [X]  Stats for Nerds
- [X]  Mobile Touch Gestures
- [X]  Playback History
- [X]  Dark / Light Mode
- [X]  Cloudflare Workers + D1 with automatic deployment from GitHub
- [X]  Website accounts and cross-device history / settings sync
- [X]  Administrator user management and registration controls
- [X]  Device-local caching, file export and personal data backups
- [X]  Character / staff detail dialogs, reviews and TMDB-assisted episode images
- [ ]  And more (/・ω・＼)

## Deployment

Follow the [Cloudflare deployment guide](docs/cloudflare-worker.md) to create D1, initialize its tables, create a Worker and connect GitHub. The Worker serves both the frontend and API.

| Repository | Production branch | Root | Build command | Deploy command |
| --- | --- | --- | --- | --- |
| `henryz78/Animaku` | `master` | `/` | `pnpm build:cloudflare` | `pnpm deploy:cloudflare` |

Set the build variable `PNPM_VERSION=9.15.0`. Manage runtime credentials and the `DB` database binding in the Cloudflare dashboard. The repository retains only technical deployment settings such as entrypoints and static assets.

Registration is closed on a fresh deployment. Configure `ADMIN_USERNAME` and `ADMIN_PASSWORD`, sign in directly as the administrator, then enable registration under **Settings → Site administration → Cloud account management**. `ACCOUNT_REGISTRATION_ENABLED` is not required.

See [offline caching and downloads](docs/offline-cache.md), the [optional egress proxy](animaku-egress-proxy/README.md), and [upstream sync notes](docs/upstream-sync.md).

Upstream Node/Docker entrypoints remain in the repository, but the account and cloud-sync APIs currently run in the Worker. The Node entrypoint does not provide the complete account deployment. The default `docker-compose.yml` pulls the official upstream image and does not publish this fork's changes.

<details>
<summary>Local Development</summary>

```bash
# Requirements: Node.js ≥ 22; prefer .node-version, with pnpm 9.15.0
git clone https://github.com/henryz78/Animaku.git animaku
cd animaku
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://localhost:5173` to develop the frontend and Node API. This entrypoint does not include the Worker's account APIs, so it cannot validate the complete login flow. Use `pnpm build:cloudflare` and `pnpm check:cloudflare` to check the Cloudflare bundle.
</details>

## Shortcuts & Gestures

### Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` / `K` | Play / Pause |
| `←` / `→` | Seek backward 5s / forward 5s |
| Hold `←` / `→` | Temporary 2× playback; release to restore the previous speed |
| `↑` / `↓` | Volume ±5% |
| `F` | Toggle fullscreen |
| `Shift + W` | Toggle Web Fullscreen |
| `W` | Cycle aspect ratios |
| `D` | Toggle danmaku |
| `Alt + M` | Danmaku settings panel |
| `,` / `.` / `/` | Danmaku delay / advance / reset offset |
| `P` / `N` | Previous / Next episode |
| `Right Click` | Advanced menu (Stats / Screenshot / Mirror / Upscaling) |

### Mobile Gestures

- **Double-tap the left / right side**: Seek backward / forward 5 seconds
- **Double-tap the center**: Play / Pause
- **Long-press**: Temporary 2× playback; release to restore the previous speed
- **Horizontal swipe**: Fast seek forward / backward

## Q&A

<details>
<summary>User Q&A</summary>

#### Q: Why do some episodes contain ads?
A: Animaku contains no ads. Ads come from 3rd-party source streams. You can enable "Ad Filter" in settings or switch to another source in the sidebar.

#### Q: Why does playback lag with Anime4K enabled?
A: Anime4K requires GPU compute (WebGPU). If your hardware struggles, switch to the "Efficiency" preset or only enable it for 720P and lower resolutions.

#### Q: Why do some video sources fail or load slowly?
A: 3rd-party providers may experience network fluctuations. You can switch to another source anytime from the source drawer.

#### Q: Danmaku shows "Not configured" or fails to load?
A: The client uses built-in shared credentials by default. You can apply for your own credentials on [DanDanPlay Open Platform](https://www.dandanplay.com/) and configure them as Worker runtime secrets.

</details>

## Disclaimer

This software is provided for personal learning, self-hosting, and educational purposes only. Animaku does not host or distribute any video media. All content is indexed from third-party public sources. Users are responsible for complying with applicable local laws and respecting copyright owners.

## Privacy Policy

This fork uses website accounts. D1 stores accounts, password hashes, session digests, and synced history, watched-episode markers, search history, playback settings, rules and source bindings. The browser also retains local data. Bangumi manages its own collections; its login tokens are not actively included in this site's cloud sync.

Cached videos and exported media remain on the user's device rather than in D1. JSON backups do not include videos. Analytics scripts are injected only when the operator explicitly configures the corresponding build variables. See [offline caching and downloads](docs/offline-cache.md) for browser and export limitations.

## Acknowledgements

- [Kazumi](https://github.com/Predidit/Kazumi) —— Architecture and design inspiration
- [Bangumi 番组计划](https://bangumi.tv/) —— Anime metadata and broadcast schedule
- [弹弹play](https://www.dandanplay.com/) —— Danmaku database support
- [Anime4K](https://github.com/bloc97/Anime4K) —— Real-time anime upscaling algorithm
- [bangumi-oped](https://github.com/uerax/bangumi-oped) —— OP/ED timestamp database
