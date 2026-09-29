import { create } from 'zustand'
import { api } from '../lib/api'

export interface SiteConfigState {
  siteName: string
  siteTagline: string
  iconMode: 'default' | 'upload' | 'url'
  iconUrl: string
  iconUpdatedAt: number
  isLoaded: boolean

  // 管理模式会话状态（仅当前会话有效）
  adminSecret: string
  isAdminUnlocked: boolean

  fetchConfig: () => Promise<void>
  unlockAdmin: (secret: string) => Promise<boolean>
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

const ADMIN_STORAGE_KEY = 'animaku-admin-secret'

function getSavedAdminSecret(): string {
  try {
    return sessionStorage.getItem(ADMIN_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function saveAdminSecretToSession(secret: string) {
  try {
    if (secret) {
      sessionStorage.setItem(ADMIN_STORAGE_KEY, secret)
    } else {
      sessionStorage.removeItem(ADMIN_STORAGE_KEY)
    }
  } catch {}
}

export function updateDocumentFavicon(
  iconMode: 'default' | 'upload' | 'url',
  iconUrl?: string,
  iconUpdatedAt?: number,
) {
  if (typeof document === 'undefined') return
  let href = '/favicon.ico'
  if (iconMode === 'upload' && iconUpdatedAt) {
    href = `/api/site/favicon?v=${iconUpdatedAt}`
  } else if (iconMode === 'url' && iconUrl) {
    href = iconUrl
  }

  const existingIcons = document.querySelectorAll<HTMLLinkElement>("link[rel*='icon']")
  if (existingIcons.length > 0) {
    existingIcons.forEach((el) => {
      el.href = href
    })
  } else {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = href
    document.head.appendChild(link)
  }
}

const initialSecret = getSavedAdminSecret()

export const useSiteConfigStore = create<SiteConfigState>((set, get) => ({
  siteName: '',
  siteTagline: '',
  iconMode: 'default',
  iconUrl: '',
  iconUpdatedAt: 0,
  isLoaded: false,

  adminSecret: initialSecret,
  isAdminUnlocked: Boolean(initialSecret),

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
        set({
          siteName: res.siteName || '',
          siteTagline: res.siteTagline || '',
          iconMode: res.iconMode || 'default',
          iconUrl: res.iconUrl || '',
          iconUpdatedAt: res.iconUpdatedAt || 0,
          isLoaded: true,
        })

        updateDocumentFavicon(res.iconMode || 'default', res.iconUrl, res.iconUpdatedAt)
      }
    } catch (err) {
      console.warn('[site-config] 加载站点配置失败:', err)
      set({ isLoaded: true })
    }
  },

  unlockAdmin: async (secret: string) => {
    const trimmed = secret.trim()
    if (!trimmed) return false

    try {
      const res = await api<{ ok: boolean }>('/api/admin/verify', {
        method: 'POST',
        headers: {
          'X-Admin-Secret': trimmed,
        },
      })

      if (res && res.ok) {
        saveAdminSecretToSession(trimmed)
        set({
          adminSecret: trimmed,
          isAdminUnlocked: true,
        })
        return true
      }
      return false
    } catch {
      return false
    }
  },

  lockAdmin: () => {
    saveAdminSecretToSession('')
    set({
      adminSecret: '',
      isAdminUnlocked: false,
    })
  },

  saveConfig: async (data) => {
    const { adminSecret } = get()
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
      headers: {
        'X-Admin-Secret': adminSecret,
      },
      body: JSON.stringify(data),
    })

    if (res && res.ok && res.data) {
      set({
        siteName: res.data.siteName || '',
        siteTagline: res.data.siteTagline || '',
        iconMode: res.data.iconMode || 'default',
        iconUrl: res.data.iconUrl || '',
        iconUpdatedAt: res.data.iconUpdatedAt || 0,
      })
      updateDocumentFavicon(res.data.iconMode, res.data.iconUrl, res.data.iconUpdatedAt)
    }
  },

  uploadIcon: async (file: File) => {
    const { adminSecret } = get()
    const formData = new FormData()
    formData.append('file', file)

    const res = await api<{
      ok: boolean
      iconMode: 'upload'
      iconUpdatedAt: number
    }>('/api/admin/site/upload-icon', {
      method: 'POST',
      headers: {
        'X-Admin-Secret': adminSecret,
      },
      body: formData,
    })

    if (res && res.ok) {
      set({
        iconMode: 'upload',
        iconUpdatedAt: res.iconUpdatedAt,
      })
      updateDocumentFavicon('upload', undefined, res.iconUpdatedAt)
    }
  },

  resetIcon: async () => {
    const { adminSecret } = get()
    const res = await api<{
      ok: boolean
      iconMode: 'default'
      iconUpdatedAt: number
    }>('/api/admin/site/reset-icon', {
      method: 'POST',
      headers: {
        'X-Admin-Secret': adminSecret,
      },
    })

    if (res && res.ok) {
      set({
        iconMode: 'default',
        iconUpdatedAt: res.iconUpdatedAt,
      })
      updateDocumentFavicon('default')
    }
  },

  resetAllConfig: async () => {
    const { adminSecret } = get()
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
      headers: {
        'X-Admin-Secret': adminSecret,
      },
    })

    if (res && res.ok) {
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
    const { adminSecret } = get()
    const res = await api<{
      ok: boolean
      submitted?: number
      message?: string
    }>('/api/admin/indexnow', {
      method: 'POST',
      headers: {
        'X-Admin-Secret': adminSecret,
      },
      body: JSON.stringify({ forceAll: true }),
    })
    return res
  },
}))
