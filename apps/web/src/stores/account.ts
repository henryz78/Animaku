import { create } from 'zustand'
import { api, ApiError } from '../lib/api'
import { rememberOfflineProfile } from '../offline/profile'

export type AccountUser = {
  id: string
  username: string
  role: 'user' | 'admin'
  createdAt: number
}

type AccountState = {
  user: AccountUser | null
  available: boolean
  loading: boolean
  initialized: boolean
  init: () => Promise<void>
  login: (username: string, password: string) => Promise<AccountUser>
  register: (username: string, password: string) => Promise<AccountUser>
  logout: () => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
}

let initPromise: Promise<void> | null = null

export const useAccountStore = create<AccountState>((set) => ({
  user: null,
  available: true,
  loading: false,
  initialized: false,

  init: async () => {
    if (initPromise) return initPromise
    initPromise = (async () => {
      set({ loading: true })
      try {
        const result = await api<{ ok: boolean; user: AccountUser | null; available?: boolean }>('/api/account/me')
        rememberOfflineProfile(result.user || null)
        set({ user: result.user || null, available: result.available !== false, initialized: true })
      } catch (error) {
        // The account is now the entry point for the application. Keep the
        // failure visible on the login screen instead of silently falling
        // back to an anonymous session.
        const unauthenticated = error instanceof ApiError && (error.status === 401 || error.status === 403)
        if (unauthenticated) rememberOfflineProfile(null)
        set({ user: null, available: unauthenticated, initialized: true })
      } finally {
        set({ loading: false })
      }
    })()
    try {
      await initPromise
    } finally {
      initPromise = null
    }
  },

  login: async (username, password) => {
    const result = await api<{ user: AccountUser }>('/api/account/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    set({ user: result.user, available: true, initialized: true })
    rememberOfflineProfile(result.user)
    return result.user
  },

  register: async (username, password) => {
    const result = await api<{ user: AccountUser }>('/api/account/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    set({ user: result.user, available: true, initialized: true })
    rememberOfflineProfile(result.user)
    return result.user
  },

  logout: async () => {
    try {
      await api('/api/account/logout', { method: 'POST' })
    } finally {
      rememberOfflineProfile(null)
      set({ user: null, initialized: true })
    }
  },

  changePassword: async (currentPassword, newPassword) => {
    const result = await api<{ user: AccountUser }>('/api/account/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    set({ user: result.user })
  },
}))
