import { existsSync, readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { isAuthorizedAdmin } from '../lib/indexnow'
import {
  getSiteConfig,
  saveSiteConfig,
  saveCustomFavicon,
  resetCustomFavicon,
  resetAllSiteConfig,
  validateIconBuffer,
  getCustomFaviconPath,
  hasCustomFavicon,
  type SiteConfig,
} from '../lib/site-config'

export const siteRoutes = new Hono()

function isValidHttpUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 公开接口：获取当前站点品牌与自定义图标配置
 */
siteRoutes.get('/config', (c) => {
  const cfg = getSiteConfig()
  return c.json({
    ok: true,
    siteName: cfg.siteName || '',
    siteTagline: cfg.siteTagline || '',
    iconMode: cfg.iconMode || 'default',
    iconUrl: cfg.iconUrl || '',
    iconUpdatedAt: cfg.iconUpdatedAt || 0,
  })
})

/**
 * 公开接口：获取当前站点的 Favicon 图标（根据实际格式输出正确的 Content-Type）
 */
siteRoutes.get('/favicon', (c) => {
  const cfg = getSiteConfig()
  if (cfg.iconMode === 'upload' && hasCustomFavicon()) {
    const targetPath = getCustomFaviconPath()
    if (existsSync(targetPath)) {
      try {
        const data = readFileSync(targetPath)
        const check = validateIconBuffer(data)
        const mime = check.valid && check.mime ? check.mime : 'image/x-icon'
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'public, max-age=86400',
          },
        })
      } catch {
        return c.text('Icon not found', 404)
      }
    }
  } else if (cfg.iconMode === 'url' && cfg.iconUrl) {
    return c.redirect(cfg.iconUrl, 302)
  }
  return c.text('No custom icon', 404)
})

export const adminSiteRoutes = new Hono()

// 管理员身份前置校验中间件
adminSiteRoutes.use('*', async (c, next) => {
  if (!isAuthorizedAdmin(c)) {
    return c.json(
      {
        ok: false,
        error: 'unauthorized',
        message: '管理员鉴权失败：请提供有效的 X-Admin-Secret 或仅在本机回环访问',
      },
      401,
    )
  }
  await next()
})

/**
 * 校验管理员凭据是否有效
 */
adminSiteRoutes.post('/verify', (c) => {
  return c.json({
    ok: true,
    message: '管理员身份验证成功',
  })
})

/**
 * 更新站点配置（名称、标语、图标模式及外链）
 */
adminSiteRoutes.post('/site/config', async (c) => {
  const body = (await c.req.json<Partial<SiteConfig>>().catch(() => ({}))) as Partial<SiteConfig>

  const updates: Partial<SiteConfig> = {}

  if (body.siteName !== undefined) {
    updates.siteName = typeof body.siteName === 'string' ? body.siteName.trim().slice(0, 50) : ''
  }

  if (body.siteTagline !== undefined) {
    updates.siteTagline = typeof body.siteTagline === 'string' ? body.siteTagline.trim().slice(0, 100) : ''
  }

  if (body.iconMode !== undefined) {
    if (['default', 'upload', 'url'].includes(body.iconMode)) {
      updates.iconMode = body.iconMode
    }
  }

  if (body.iconUrl !== undefined) {
    const trimmed = typeof body.iconUrl === 'string' ? body.iconUrl.trim() : ''
    if (trimmed && !isValidHttpUrl(trimmed)) {
      return c.json({ ok: false, error: '图标外链必须为以 http:// 或 https:// 开头的合法 URL' }, 400)
    }
    updates.iconUrl = trimmed.slice(0, 500)
  }

  try {
    const saved = saveSiteConfig(updates)
    return c.json({
      ok: true,
      data: saved,
      message: '站点配置已更新',
    })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : '保存失败' }, 500)
  }
})

/**
 * 在线上传站点图标文件（≤2MB，格式嗅探 ICO/PNG/JPEG/WEBP，固定保存为 favicon.ico）
 */
adminSiteRoutes.post('/site/upload-icon', async (c) => {
  try {
    let buffer: Buffer
    const contentType = c.req.header('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      let file: unknown
      try {
        const formData = await c.req.formData()
        file = formData.get('file')
      } catch {
        const body = await c.req.parseBody()
        file = body['file']
      }

      if (!file) {
        return c.json({ ok: false, error: '未找到上传的图标文件 (file 字段)' }, 400)
      }

      if (typeof (file as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
        buffer = Buffer.from(await (file as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer())
      } else if (typeof file === 'string') {
        buffer = Buffer.from(file, 'utf8')
      } else {
        return c.json({ ok: false, error: '无法解析上传的文件内容' }, 400)
      }
    } else {
      const ab = await c.req.arrayBuffer()
      buffer = Buffer.from(ab)
    }

    if (!buffer || buffer.length === 0) {
      return c.json({ ok: false, error: '上传内容为空' }, 400)
    }

    const check = validateIconBuffer(buffer)
    if (!check.valid) {
      return c.json({ ok: false, error: check.error }, 400)
    }

    await saveCustomFavicon(buffer)
    const cfg = getSiteConfig()

    return c.json({
      ok: true,
      message: '图标上传并更新成功',
      iconMode: cfg.iconMode,
      iconUpdatedAt: cfg.iconUpdatedAt,
    })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : '图标上传保存失败' }, 500)
  }
})

/**
 * 重置为官方默认图标
 */
adminSiteRoutes.post('/site/reset-icon', (c) => {
  try {
    resetCustomFavicon()
    const cfg = getSiteConfig()
    return c.json({
      ok: true,
      message: '已恢复官方默认图标',
      iconMode: cfg.iconMode,
      iconUpdatedAt: cfg.iconUpdatedAt,
    })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : '重置失败' }, 500)
  }
})

/**
 * 全局恢复为官方默认设置（站点名称、标语与图标全部清除重置）
 */
adminSiteRoutes.post('/site/reset-all', (c) => {
  try {
    const cfg = resetAllSiteConfig()
    return c.json({
      ok: true,
      message: '已全局恢复官方默认设置',
      data: {
        siteName: cfg.siteName || '',
        siteTagline: cfg.siteTagline || '',
        iconMode: cfg.iconMode || 'default',
        iconUrl: cfg.iconUrl || '',
        iconUpdatedAt: cfg.iconUpdatedAt || 0,
      },
    })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : '全局重置失败' }, 500)
  }
})
