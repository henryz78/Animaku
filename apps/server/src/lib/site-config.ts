import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'
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

export const CUSTOM_ICON_FILENAMES = [
  'favicon.ico',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'apple-touch-icon.png',
  'android-chrome-192x192.png',
  'android-chrome-512x512.png',
  'logo.png',
] as const

export type CustomIconFilename = (typeof CUSTOM_ICON_FILENAMES)[number]

function getSiteConfigFilePath(): string {
  return resolve(config.dataDir, 'site-config.json')
}

export function getCustomIconsDir(): string {
  return resolve(config.dataDir, 'icons')
}

export function getCustomIconPath(filename: CustomIconFilename): string {
  return resolve(getCustomIconsDir(), filename)
}

export function hasCustomIcon(filename: CustomIconFilename): boolean {
  return existsSync(getCustomIconPath(filename))
}

export function getCustomFaviconPath(): string {
  const newPath = getCustomIconPath('favicon.ico')
  if (existsSync(newPath)) {
    return newPath
  }
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

function buildIcoBuffer(png16: Buffer, png32: Buffer): Buffer {
  const icoHeader = Buffer.alloc(6)
  icoHeader.writeUInt16LE(0, 0)
  icoHeader.writeUInt16LE(1, 2)
  icoHeader.writeUInt16LE(2, 4)

  const e16 = Buffer.alloc(16)
  e16.writeUInt8(16, 0)
  e16.writeUInt8(16, 1)
  e16.writeUInt16LE(1, 4)
  e16.writeUInt16LE(32, 6)
  e16.writeUInt32LE(png16.length, 8)
  e16.writeUInt32LE(38, 12)

  const e32 = Buffer.alloc(16)
  e32.writeUInt8(32, 0)
  e32.writeUInt8(32, 1)
  e32.writeUInt16LE(1, 4)
  e32.writeUInt16LE(32, 6)
  e32.writeUInt32LE(png32.length, 8)
  e32.writeUInt32LE(38 + png16.length, 12)

  return Buffer.concat([icoHeader, e16, e32, png16, png32])
}

export interface GeneratedIconSuite {
  'favicon.ico': Buffer
  'favicon-16x16.png': Buffer
  'favicon-32x32.png': Buffer
  'apple-touch-icon.png': Buffer
  'android-chrome-192x192.png': Buffer
  'android-chrome-512x512.png': Buffer
  'logo.png': Buffer
}

/**
 * 工业级多尺寸图标与站点 Logo 衍生管道：
 * 1. 严格正方形宽高比居中包含（fit: contain, position: center）
 * 2. 采用高质量 Lanczos3 重采样算法
 * 3. 16x16 / 32x32 微尺寸自适应锐化，防止小图在浏览器标签页糊成一团
 * 4. logo.png (192x192) 专供站内导航栏与品牌 UI，原图过小时启用 withoutEnlargement 避免虚假放大失真
 * 5. 生成标准封装的 Windows 多分辨率 ICO
 */
export async function generateIconSuite(inputBuf: Buffer): Promise<GeneratedIconSuite> {
  let sourceImg: ReturnType<typeof sharp> | null = null

  // 若输入为标准 ICO 文件，解析提取其中面积最大的有效位图，避免二次包装失真
  if (
    inputBuf.length > 4 &&
    inputBuf[0] === 0x00 &&
    inputBuf[1] === 0x00 &&
    inputBuf[2] === 0x01 &&
    inputBuf[3] === 0x00
  ) {
    const count = inputBuf.readUInt16LE(4)
    let bestEntry: { w: number; h: number; size: number; offset: number } | null = null
    let maxArea = 0
    for (let i = 0; i < count; i++) {
      const offset = 6 + i * 16
      const w = inputBuf[offset] || 256
      const h = inputBuf[offset + 1] || 256
      const area = w * h
      if (area > maxArea) {
        maxArea = area
        bestEntry = {
          w,
          h,
          size: inputBuf.readUInt32LE(offset + 8),
          offset: inputBuf.readUInt32LE(offset + 12),
        }
      }
    }

    if (bestEntry && bestEntry.offset + bestEntry.size <= inputBuf.length) {
      const data = inputBuf.subarray(bestEntry.offset, bestEntry.offset + bestEntry.size)
      if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
        sourceImg = sharp(data)
      } else if (data.length >= 40 && data.readUInt32LE(0) === 40) {
        // 32bpp DIB 像素转换
        const biBitCount = data.readUInt16LE(14)
        if (biBitCount === 32) {
          const w = bestEntry.w
          const h = bestEntry.h
          const rawRgba = Buffer.alloc(w * h * 4)
          const pixelOffset = 40
          for (let y = 0; y < h; y++) {
            const srcRow = h - 1 - y
            for (let x = 0; x < w; x++) {
              const srcIdx = pixelOffset + (srcRow * w + x) * 4
              const dstIdx = (y * w + x) * 4
              rawRgba[dstIdx] = data[srcIdx + 2]
              rawRgba[dstIdx + 1] = data[srcIdx + 1]
              rawRgba[dstIdx + 2] = data[srcIdx]
              rawRgba[dstIdx + 3] = data[srcIdx + 3]
            }
          }
          sourceImg = sharp(rawRgba, { raw: { width: w, height: h, channels: 4 } })
        }
      }
    }
  }

  if (!sourceImg) {
    sourceImg = sharp(inputBuf)
  }

  sourceImg = sourceImg.rotate()

  async function renderVariant(
    size: number,
    opts: { sharpen?: boolean; withoutEnlargement?: boolean } = {},
  ): Promise<Buffer> {
    let stage = sourceImg!.clone().resize(size, size, {
      fit: 'contain',
      position: 'center',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: 'lanczos3',
      withoutEnlargement: opts.withoutEnlargement ?? false,
    })

    if (opts.sharpen) {
      stage = stage.sharpen({ sigma: 0.5, m1: 0.5, m2: 2.0 })
    }

    return stage.png({ compressionLevel: 9 }).toBuffer()
  }

  const png16 = await renderVariant(16, { sharpen: true })
  const png32 = await renderVariant(32, { sharpen: true })
  const png180 = await renderVariant(180)
  const png192 = await renderVariant(192)
  const png512 = await renderVariant(512)
  const logoPng = await renderVariant(192, { withoutEnlargement: true })
  const icoBuf = buildIcoBuffer(png16, png32)

  return {
    'favicon.ico': icoBuf,
    'favicon-16x16.png': png16,
    'favicon-32x32.png': png32,
    'apple-touch-icon.png': png180,
    'android-chrome-192x192.png': png192,
    'android-chrome-512x512.png': png512,
    'logo.png': logoPng,
  }
}

/**
 * 保存自定义 Favicon 文件并自动衍生全套规格到 data/icons 目录
 */
export async function saveCustomFavicon(buf: Buffer): Promise<void> {
  const check = validateIconBuffer(buf)
  if (!check.valid) {
    throw new Error(check.error || '非法图标文件')
  }

  const iconsDir = getCustomIconsDir()
  if (!existsSync(iconsDir)) {
    mkdirSync(iconsDir, { recursive: true })
  }

  const suite = await generateIconSuite(buf)

  for (const filename of CUSTOM_ICON_FILENAMES) {
    writeFileSync(resolve(iconsDir, filename), suite[filename])
  }

  // 兼容老路径 data/favicon.ico
  try {
    writeFileSync(resolve(config.dataDir, 'favicon.ico'), suite['favicon.ico'])
  } catch {}

  saveSiteConfig({
    iconMode: 'upload',
    iconUpdatedAt: Date.now(),
  })
}

/**
 * 删除自定义 Favicon 并恢复默认图标模式
 */
export function resetCustomFavicon(): void {
  const dir = getCustomIconsDir()
  if (existsSync(dir)) {
    for (const file of CUSTOM_ICON_FILENAMES) {
      const p = resolve(dir, file)
      if (existsSync(p)) {
        try {
          unlinkSync(p)
        } catch (err) {
          console.warn(`[site-config] 删除 custom icon ${file} 失败:`, err)
        }
      }
    }
  }

  const legacyIco = resolve(config.dataDir, 'favicon.ico')
  if (existsSync(legacyIco)) {
    try {
      unlinkSync(legacyIco)
    } catch {}
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
  const dir = getCustomIconsDir()
  if (existsSync(dir)) {
    for (const file of CUSTOM_ICON_FILENAMES) {
      const p = resolve(dir, file)
      if (existsSync(p)) {
        try {
          unlinkSync(p)
        } catch (err) {
          console.warn(`[site-config] 删除 custom icon ${file} 失败:`, err)
        }
      }
    }
  }

  const legacyIco = resolve(config.dataDir, 'favicon.ico')
  if (existsSync(legacyIco)) {
    try {
      unlinkSync(legacyIco)
    } catch {}
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
