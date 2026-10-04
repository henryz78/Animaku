import { create } from 'zustand'
import { api } from '../lib/api'

export interface SiteConfigState {
  siteName: string
  siteTagline: string
  iconMode: 'default' | 'upload' | 'url'
  iconUrl: string
  iconUpdatedAt: number
  isLoaded: boolean

  // 管理模式会话状态（由当前账号的管理员权限自动验证）
  isAdminUnlocked: boolean

  fetchConfig: () => Promise<void>
  unlockAdmin: () => Promise<boolean>
  lockAdmin: () => void
  saveConfig: (data: {
    siteName: string
    siteTagline: string
    iconMode: 'default' | 'upload' | 'url'
    iconUrl: string
  }) => Promise<void>
  uploadIcon: (file: File) => Promise<void>
  resetIcon: () => Promise<void>
  resetAllConfig: () => Promise<void>
  triggerIndexNow: () => Promise<{ ok: boolean; submitted?: number; message?: string }>
}

const SITE_CONFIG_CACHE_KEY = 'animaku-site-config-cache'

interface CachedSiteConfig {
  siteName: string
  siteTagline: string
  iconMode: 'default' | 'upload' | 'url'
  iconUrl: string
  iconUpdatedAt: number
}

function getInitialSiteConfig(): CachedSiteConfig {
  if (typeof document === 'undefined') {
    return {
      siteName: '',
      siteTagline: '',
      iconMode: 'default',
      iconUrl: '',
      iconUpdatedAt: 0,
    }
  }

  // 1. 优先从 localStorage 读取历史持久化配置
  try {
    const raw = localStorage.getItem(SITE_CONFIG_CACHE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CachedSiteConfig>
      if (parsed && typeof parsed === 'object') {
        return {
          siteName: typeof parsed.siteName === 'string' ? parsed.siteName : '',
          siteTagline: typeof parsed.siteTagline === 'string' ? parsed.siteTagline : '',
          iconMode: ['default', 'upload', 'url'].includes(parsed.iconMode as string)
            ? (parsed.iconMode as 'default' | 'upload' | 'url')
            : 'default',
          iconUrl: typeof parsed.iconUrl === 'string' ? parsed.iconUrl : '',
          iconUpdatedAt: typeof parsed.iconUpdatedAt === 'number' ? parsed.iconUpdatedAt : 0,
        }
      }
    }
  } catch {}

  // 2. 首次访问从服务端 SSR 注入的 meta[name="application-name"] 同步继承（首屏 0 闪烁）
  const metaApp = document.querySelector('meta[name="application-name"]')?.getAttribute('content')?.trim()
  if (metaApp && metaApp !== 'Animaku 动漫' && metaApp !== 'Animaku') {
    return {
      siteName: metaApp,
      siteTagline: '',
      iconMode: 'default',
      iconUrl: '',
      iconUpdatedAt: 0,
    }
  }

  return {
    siteName: '',
    siteTagline: '',
    iconMode: 'default',
    iconUrl: '',
    iconUpdatedAt: 0,
  }
}

function saveSiteConfigToCache(data: CachedSiteConfig) {
  try {
    localStorage.setItem(SITE_CONFIG_CACHE_KEY, JSON.stringify(data))
  } catch {}
}

function clearSiteConfigCache() {
  try {
    localStorage.removeItem(SITE_CONFIG_CACHE_KEY)
  } catch {}
}

export function updateDocumentFavicon(
  iconMode: 'default' | 'upload' | 'url',
  iconUrl?: string,
  iconUpdatedAt?: number,
) {
  if (typeof document === 'undefined') return

  if (iconMode === 'url' && iconUrl) {
    const existingIcons = document.querySelectorAll<HTMLLinkElement>(
      "link[rel*='icon'], link[rel='apple-touch-icon']",
    )
    existingIcons.forEach((el) => {
      el.href = iconUrl
    })
    return
  }

  const v = iconUpdatedAt ? `?v=${iconUpdatedAt}` : ''
  const links = document.querySelectorAll<HTMLLinkElement>(
    "link[rel*='icon'], link[rel='apple-touch-icon'], link[rel='manifest']",
  )

  links.forEach((el) => {
    const rawHref = el.getAttribute('href') || ''
    const clean = rawHref.split('?')[0]
    if (clean.endsWith('/favicon.ico')) {
      el.href = `/favicon.ico${v}`
    } else if (clean.endsWith('/favicon-32x32.png')) {
      el.href = `/favicon-32x32.png${v}`
    } else if (clean.endsWith('/favicon-16x16.png')) {
      el.href = `/favicon-16x16.png${v}`
    } else if (clean.endsWith('/apple-touch-icon.png')) {
      el.href = `/apple-touch-icon.png${v}`
    } else if (clean.endsWith('/android-chrome-192x192.png')) {
      el.href = `/android-chrome-192x192.png${v}`
    } else if (clean.endsWith('/site.webmanifest')) {
      el.href = `/site.webmanifest${v}`
    }
  })
}

const initialConfig = getInitialSiteConfig()

if (initialConfig.iconMode !== 'default' || initialConfig.iconUpdatedAt > 0) {
  updateDocumentFavicon(initialConfig.iconMode, initialConfig.iconUrl, initialConfig.iconUpdatedAt)
}

export const useSiteConfigStore = create<SiteConfigState>((set, get) => ({
  siteName: initialConfig.siteName,
  siteTagline: initialConfig.siteTagline,
  iconMode: initialConfig.iconMode,
  iconUrl: initialConfig.iconUrl,
  iconUpdatedAt: initialConfig.iconUpdatedAt,
  isLoaded: false,

  isAdminUnlocked: false,

  fetchConfig: async () => {
    try {
      const res = await api<{
        ok: boolean
        siteName: string
        siteTagline: string
        iconMode: 'default' | 'upload' | 'url'
        iconUrl: string
        iconUpdatedAt: number
      }>('/api/site/config')

      if (res && res.ok) {
        const nextConfig: CachedSiteConfig = {
          siteName: res.siteName || '',
          siteTagline: res.siteTagline || '',
          iconMode: res.iconMode || 'default',
          iconUrl: res.iconUrl || '',
          iconUpdatedAt: res.iconUpdatedAt || 0,
        }

        set({
          ...nextConfig,
          isLoaded: true,
        })

        saveSiteConfigToCache(nextConfig)
        updateDocumentFavicon(nextConfig.iconMode, nextConfig.iconUrl, nextConfig.iconUpdatedAt)
      }
    } catch (err) {
      console.warn('[site-config] 加载站点配置失败:', err)
      set({ isLoaded: true })
    }
  },

  unlockAdmin: async () => {
    try {
      const res = await api<{ ok: boolean }>('/api/admin/verify', {
        method: 'POST',
      })

      if (res && res.ok) {
        set({ isAdminUnlocked: true })
        return true
      }
      return false
    } catch {
      return false
    }
  },

  lockAdmin: () => {
    set({ isAdminUnlocked: false })
  },

  saveConfig: async (data) => {
    const res = await api<{
      ok: boolean
      data: {
        siteName: string
        siteTagline: string
        iconMode: 'default' | 'upload' | 'url'
        iconUrl: string
        iconUpdatedAt: number
      }
    }>('/api/admin/site/config', {
      method: 'POST',
      body: JSON.stringify(data),
    })

    if (res && res.ok && res.data) {
      const nextConfig: CachedSiteConfig = {
        siteName: res.data.siteName || '',
        siteTagline: res.data.siteTagline || '',
        iconMode: res.data.iconMode || 'default',
        iconUrl: res.data.iconUrl || '',
        iconUpdatedAt: res.data.iconUpdatedAt || 0,
      }
      set(nextConfig)
      saveSiteConfigToCache(nextConfig)
      updateDocumentFavicon(res.data.iconMode, res.data.iconUrl, res.data.iconUpdatedAt)
    }
  },

  uploadIcon: async (file: File) => {
    const formData = new FormData()
    formData.append('file', file)

    const res = await api<{
      ok: boolean
      iconMode: 'upload'
      iconUpdatedAt: number
    }>('/api/admin/site/upload-icon', {
      method: 'POST',
      body: formData,
    })

    if (res && res.ok) {
      const current = get()
      const nextConfig: CachedSiteConfig = {
        siteName: current.siteName,
        siteTagline: current.siteTagline,
        iconMode: 'upload',
        iconUrl: current.iconUrl,
        iconUpdatedAt: res.iconUpdatedAt,
      }
      set({
        iconMode: 'upload',
        iconUpdatedAt: res.iconUpdatedAt,
      })
      saveSiteConfigToCache(nextConfig)
      updateDocumentFavicon('upload', undefined, res.iconUpdatedAt)
    }
  },

  resetIcon: async () => {
    const res = await api<{
      ok: boolean
      iconMode: 'default'
      iconUpdatedAt: number
    }>('/api/admin/site/reset-icon', {
      method: 'POST',
    })

    if (res && res.ok) {
      const current = get()
      const nextConfig: CachedSiteConfig = {
        siteName: current.siteName,
        siteTagline: current.siteTagline,
        iconMode: 'default',
        iconUrl: current.iconUrl,
        iconUpdatedAt: res.iconUpdatedAt,
      }
      set({
        iconMode: 'default',
        iconUpdatedAt: res.iconUpdatedAt,
      })
      saveSiteConfigToCache(nextConfig)
      updateDocumentFavicon('default')
    }
  },

  resetAllConfig: async () => {
    const res = await api<{
      ok: boolean
      data?: {
        siteName?: string
        siteTagline?: string
        iconMode?: 'default' | 'upload' | 'url'
        iconUrl?: string
        iconUpdatedAt?: number
      }
    }>('/api/admin/site/reset-all', {
      method: 'POST',
    })

    if (res && res.ok) {
      clearSiteConfigCache()
      set({
        siteName: '',
        siteTagline: '',
        iconMode: 'default',
        iconUrl: '',
        iconUpdatedAt: res.data?.iconUpdatedAt || Date.now(),
      })
      updateDocumentFavicon('default')
    }
  },

  triggerIndexNow: async () => {
    const res = await api<{
      ok: boolean
      submitted?: number
      message?: string
    }>('/api/admin/indexnow', {
      method: 'POST',
      body: JSON.stringify({ forceAll: true }),
    })
    return res
  },
}))
