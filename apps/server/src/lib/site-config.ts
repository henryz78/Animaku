import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from '../config'

export interface SiteConfig {
  siteName?: string
  siteTagline?: string
  iconMode?: 'default' | 'upload' | 'url'
  iconUrl?: string
  iconUpdatedAt?: number
}

const MAX_ICON_SIZE = 2 * 1024 * 1024 // 2MB

let memoryCache: SiteConfig | null = null

function getSiteConfigFilePath(): string {
  return resolve(config.dataDir, 'site-config.json')
}

export function getCustomFaviconPath(): string {
  return resolve(config.dataDir, 'favicon.ico')
}

/**
 * 读取当前站点配置（内存缓存，首次同步加载）
 */
export function getSiteConfig(): SiteConfig {
  if (memoryCache !== null) {
    return memoryCache
  }

  const filePath = getSiteConfigFilePath()
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        memoryCache = {
          siteName: typeof parsed.siteName === 'string' ? parsed.siteName.trim().slice(0, 50) : undefined,
          siteTagline: typeof parsed.siteTagline === 'string' ? parsed.siteTagline.trim().slice(0, 100) : undefined,
          iconMode: ['default', 'upload', 'url'].includes(parsed.iconMode) ? parsed.iconMode : 'default',
          iconUrl: typeof parsed.iconUrl === 'string' ? parsed.iconUrl.trim().slice(0, 500) : undefined,
          iconUpdatedAt: typeof parsed.iconUpdatedAt === 'number' ? parsed.iconUpdatedAt : undefined,
        }
        return memoryCache
      }
    } catch (err) {
      console.warn('[site-config] 无法解析 site-config.json，已重置为空配置:', err)
    }
  }

  memoryCache = {
    iconMode: existsSync(getCustomFaviconPath()) ? 'upload' : 'default',
  }
  return memoryCache
}

/**
 * 保存站点配置并落盘
 */
export function saveSiteConfig(updates: Partial<SiteConfig>): SiteConfig {
  const current = getSiteConfig()
  const next: SiteConfig = {
    ...current,
    ...updates,
  }

  if (next.siteName) next.siteName = next.siteName.trim().slice(0, 50)
  if (next.siteTagline) next.siteTagline = next.siteTagline.trim().slice(0, 100)
  if (next.iconUrl) next.iconUrl = next.iconUrl.trim().slice(0, 500)

  try {
    if (!existsSync(config.dataDir)) {
      mkdirSync(config.dataDir, { recursive: true })
    }
    writeFileSync(getSiteConfigFilePath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('[site-config] 写入 site-config.json 失败:', err)
    throw new Error('写入站点配置文件失败')
  }

  memoryCache = next
  return memoryCache
}

/**
 * 校验上传的图标 Buffer 是否符合大小与二进制魔数安全规范
 */
export function validateIconBuffer(buf: Buffer): {
  valid: boolean
  mime: string
  error?: string
} {
  if (buf.length > MAX_ICON_SIZE) {
    return {
      valid: false,
      mime: '',
      error: `文件大小超出上限（当前大小 ${(buf.length / 1024 / 1024).toFixed(2)} MB，限制最大 2 MB）`,
    }
  }

  if (buf.length < 4) {
    return { valid: false, mime: '', error: '文件内容过短，非合法图片文件' }
  }

  // 1. ICO 格式: 00 00 01 00
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return { valid: true, mime: 'image/x-icon' }
  }

  // 2. PNG 格式: 89 50 4E 47 (\x89PNG)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { valid: true, mime: 'image/png' }
  }

  // 3. JPEG 格式: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { valid: true, mime: 'image/jpeg' }
  }

  // 4. WebP 格式: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { valid: true, mime: 'image/webp' }
  }

  return {
    valid: false,
    mime: '',
    error: '不支持的文件格式。仅允许上传标准 ICO、PNG、JPEG 或 WebP 格式图标（坚决阻断 SVG 等潜在脚本载体）',
  }
}

/**
 * 保存自定义 Favicon 文件到 data 目录
 */
export function saveCustomFavicon(buf: Buffer): void {
  const check = validateIconBuffer(buf)
  if (!check.valid) {
    throw new Error(check.error || '非法图标文件')
  }

  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true })
  }

  const targetPath = getCustomFaviconPath()
  writeFileSync(targetPath, buf)

  saveSiteConfig({
    iconMode: 'upload',
    iconUpdatedAt: Date.now(),
  })
}

/**
 * 删除自定义 Favicon 并恢复默认图标模式
 */
export function resetCustomFavicon(): void {
  const targetPath = getCustomFaviconPath()
  if (existsSync(targetPath)) {
    try {
      unlinkSync(targetPath)
    } catch (err) {
      console.warn('[site-config] 删除 custom favicon 失败:', err)
    }
  }

  saveSiteConfig({
    iconMode: 'default',
    iconUpdatedAt: Date.now(),
  })
}

/**
 * 全局恢复为官方默认设置（清除 site-config.json 与自定义 Favicon 文件）
 */
export function resetAllSiteConfig(): SiteConfig {
  const customFavicon = getCustomFaviconPath()
  if (existsSync(customFavicon)) {
    try {
      unlinkSync(customFavicon)
    } catch (err) {
      console.warn('[site-config] 删除 custom favicon 失败:', err)
    }
  }

  const configFile = getSiteConfigFilePath()
  if (existsSync(configFile)) {
    try {
      unlinkSync(configFile)
    } catch (err) {
      console.warn('[site-config] 删除 site-config.json 失败:', err)
    }
  }

  memoryCache = {
    siteName: undefined,
    siteTagline: undefined,
    iconMode: 'default',
    iconUrl: undefined,
    iconUpdatedAt: Date.now(),
  }
  return memoryCache
}

/**
 * 检查是否存在自定义 Favicon 文件
 */
export function hasCustomFavicon(): boolean {
  return existsSync(getCustomFaviconPath())
}
