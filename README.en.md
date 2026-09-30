<div align="center">

  <p><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

  <h1>Animaku</h1>

  <img src="apps/web/public/logo.png" width="160" alt="Animaku logo" />

  <p>
    <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 19" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Vite-6-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite 6" />
    <img src="https://img.shields.io/badge/Hono-API-E36002?style=for-the-badge&logo=hono&logoColor=white" alt="Hono API" />
    <img src="https://img.shields.io/badge/WebGPU-Anime4K-9cf?style=for-the-badge&logo=webgpu&logoColor=white" alt="WebGPU Anime4K" />
    <img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Ready" />
  </p>

  <p>A modern self-hosted anime streaming web client. Built-in 1080P direct streams, Bangumi calendar, danmaku aggregation, WebGPU real-time upscaling, and smart OP/ED skip. Built for anime lovers (～￣▽￣)～</p>

</div>

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
- [X]  Docker One-click Deployment
- [ ]  And more (/・ω・＼)

## Deployment

Deploy in seconds with **Docker Compose**:

```bash
# 1. Clone repository
git clone https://github.com/uerax/Animaku.git animaku
cd animaku

# 2. Configure environment
cp .env.example .env

# 3. Start container
docker compose up -d
```

Open `http://localhost:8787` in your browser.

<details>
<summary>Local Development</summary>

```bash
# Requirements: Node.js ≥ 20, pnpm recommended
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://localhost:5173` in your browser.
</details>

## Shortcuts & Gestures

### Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` / `K` | Play / Pause |
| `←` / `→` | Seek backward 5s / forward 5s |
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

- **Double-tap**: Play / Pause
- **Long-press**: 2.0X Turbo speed
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
A: By default, the client uses a built-in shared endpoint. For the best stability, register a free key on [DanDanPlay Open Platform](https://www.dandanplay.com/) and configure it in `.env`.

</details>

## Disclaimer

This software is provided for personal learning, self-hosting, and educational purposes only. Animaku does not host or distribute any video media. All content is indexed from third-party public sources. Users are responsible for complying with applicable local laws and respecting copyright owners.

## Privacy Policy

No user data is collected by default, and no commercial tracking SDKs are bundled. Playback history and personal preferences are stored strictly in your local browser.

## Acknowledgements

- [Kazumi](https://github.com/Predidit/Kazumi) —— Architecture and design inspiration
- [Bangumi 番组计划](https://bangumi.tv/) —— Anime metadata and broadcast schedule
- [弹弹play](https://www.dandanplay.com/) —— Danmaku database support
- [Anime4K](https://github.com/bloc97/Anime4K) —— Real-time anime upscaling algorithm
- [bangumi-oped](https://github.com/uerax/bangumi-oped) —— OP/ED timestamp database
