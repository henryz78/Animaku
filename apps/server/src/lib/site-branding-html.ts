import { formatDefaultDescription } from '@animaku/shared'
import type { SiteConfig } from './site-config'

// Keep HTML branding independent of Node disk access so Workers use the same rules.
function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeJsonLdScript(jsonStr: string): string {
  return jsonStr.replace(/<\/script/gi, '<\\/script')
}

export function applySiteBrandingToHtml(
  html: string,
  cfg: SiteConfig,
  options: { replaceTitle?: boolean; replaceDescription?: boolean } = {
    replaceTitle: true,
    replaceDescription: true,
  },
): string {
  let result = html

  if (cfg.siteName || cfg.siteTagline) {
    const siteTitle = cfg.siteTagline
      ? `${cfg.siteName || 'Animaku'} - ${cfg.siteTagline}`
      : cfg.siteName || 'Animaku'
    const dynamicDesc = formatDefaultDescription(cfg.siteName, cfg.siteTagline)

    if (cfg.siteName) {
      result = result.replace(
        /<meta\s+property=["']og:site_name["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
        `<meta property="og:site_name" content="${escapeHtml(cfg.siteName)}" />`,
      )
      result = result.replace(
        /<meta\s+name=["']application-name["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
        `<meta name="application-name" content="${escapeHtml(cfg.siteName)}" />`,
      )
    }

    if (options.replaceTitle) {
      result = result.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(siteTitle)}</title>`)
      result = result.replace(
        /<meta\s+property=["']og:title["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
        `<meta property="og:title" content="${escapeHtml(siteTitle)}" />`,
      )
      result = result.replace(
        /<meta\s+name=["']twitter:title["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
        `<meta name="twitter:title" content="${escapeHtml(siteTitle)}" />`,
      )

      // 动态更新首页原始 HTML 骨架中的 h1 与 p 标签，保证爬虫在首屏无 JS 情况下抓到自定义品牌
      const siteHeading = cfg.siteTagline
        ? `${cfg.siteName || 'Animaku'} - ${cfg.siteTagline}`
        : `${cfg.siteName || 'Animaku'} 动漫 - 在线高清动画多源聚合弹幕平台`
      result = result.replace(
        /<h1\s+class=["']sr-only["']>[\s\S]*?<\/h1>/i,
        `<h1 class="sr-only">${escapeHtml(siteHeading)}</h1>`,
      )
      result = result.replace(
        /<p\s+class=["']sr-only["']>[\s\S]*?<\/p>/i,
        `<p class="sr-only">${escapeHtml(dynamicDesc)}</p>`,
      )

      // 动态重写首页 HTML 中预埋的 WebSite 结构化数据 (JSON-LD)，覆盖静态写死的 name 与 description
      const websiteJsonRegex =
        /(<script\s+type=["']application\/ld\+json["']\s+data-animaku-jsonld=["']1["']>\s*\{[\s\S]*?"@type"\s*:\s*"WebSite"[\s\S]*?<\/script>)/i
      result = result.replace(websiteJsonRegex, (match) => {
        try {
          const jsonStr = match.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
          const obj = JSON.parse(jsonStr)
          if (cfg.siteName) {
            obj.name = cfg.siteName
            if (Array.isArray(obj.alternateName)) {
              obj.alternateName = Array.from(new Set([cfg.siteName, ...obj.alternateName]))
            }
          }
          obj.description = dynamicDesc
          return `<script type="application/ld+json" data-animaku-jsonld="1">\n      ${escapeJsonLdScript(JSON.stringify(obj, null, 2))}\n    </script>`
        } catch {
          return match
        }
      })
    }

    // 默认 description 仅在未显式关闭 replaceDescription（且 replaceTitle 未置否）时注入，
    // 避免覆盖详情页已渲染好的番剧专属简介 meta description。
    const shouldReplaceDesc = options.replaceDescription ?? options.replaceTitle ?? true
    if (shouldReplaceDesc) {
      result = result.replace(
        /<meta\s+name=["']description["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
        `<meta name="description" content="${escapeHtml(dynamicDesc)}" />`,
      )
      result = result.replace(
        /<meta\s+property=["']og:description["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
        `<meta property="og:description" content="${escapeHtml(dynamicDesc)}" />`,
      )
      result = result.replace(
        /<meta\s+name=["']twitter:description["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
        `<meta name="twitter:description" content="${escapeHtml(dynamicDesc)}" />`,
      )
    }
  }

  // Favicon 与多尺寸图标统一版本指纹穿透 (保持全套图标同源同版本)
  if (cfg.iconMode === 'url' && cfg.iconUrl) {
    const escapedUrl = escapeHtml(cfg.iconUrl)
    result = result
      .replace(
        /<link\s+[^>]*rel=["']icon["'][^>]*\/?>/gi,
        `<link rel="icon" href="${escapedUrl}" sizes="any" />`,
      )
      .replace(
        /<link\s+[^>]*rel=["']apple-touch-icon["'][^>]*\/?>/gi,
        `<link rel="apple-touch-icon" href="${escapedUrl}" />`,
      )
  } else if (cfg.iconUpdatedAt) {
    const v = `?v=${cfg.iconUpdatedAt}`
    result = result
      .replace(/href=["']\/favicon\.ico(?:\?[^"']*)?["']/gi, `href="/favicon.ico${v}"`)
      .replace(/href=["']\/favicon-32x32\.png(?:\?[^"']*)?["']/gi, `href="/favicon-32x32.png${v}"`)
      .replace(/href=["']\/favicon-16x16\.png(?:\?[^"']*)?["']/gi, `href="/favicon-16x16.png${v}"`)
      .replace(/href=["']\/apple-touch-icon\.png(?:\?[^"']*)?["']/gi, `href="/apple-touch-icon.png${v}"`)
      .replace(/href=["']\/android-chrome-192x192\.png(?:\?[^"']*)?["']/gi, `href="/android-chrome-192x192.png${v}"`)
      .replace(/href=["']\/site\.webmanifest(?:\?[^"']*)?["']/gi, `href="/site.webmanifest${v}"`)
      .replace(/content=["']\/android-chrome-512x512\.png(?:\?[^"']*)?["']/gi, `content="/android-chrome-512x512.png${v}"`)
      .replace(/href=["']\/logo\.png(?:\?[^"']*)?["']/gi, `href="/logo.png${v}"`)
  }

  return result
}
