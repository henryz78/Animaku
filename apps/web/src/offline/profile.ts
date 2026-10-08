import { readStore, writeStore } from './db'
import { DEFAULT_CACHE_SETTINGS, type CacheSettings, type OfflineProfile } from './types'

const PROFILE_KEY = 'animaku.offline-profile'
export function offlineProfile(): OfflineProfile | null {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null')
    return typeof value?.id === 'string' && typeof value?.username === 'string'
      ? { id: value.id, username: value.username } : null
  } catch { return null }
}
export function rememberOfflineProfile(profile: OfflineProfile | null): void {
  const previous = offlineProfile()?.id
  if (profile) localStorage.setItem(PROFILE_KEY, JSON.stringify({ id: profile.id, username: profile.username }))
  else localStorage.removeItem(PROFILE_KEY)
  void writeStore('meta', profile?.id || null, 'owner').catch(() => {})
  if (previous !== profile?.id) window.dispatchEvent(new Event('animaku:offline-owner'))
}
export async function cacheSettings(owner: string): Promise<CacheSettings> {
  const value = await readStore<Partial<CacheSettings> | undefined>('meta', `settings:${owner}`)
  return {
    auto: value?.auto === true,
    ahead: Math.max(1, Math.min(5, Math.floor(Number(value?.ahead) || DEFAULT_CACHE_SETTINGS.ahead))),
    limitGB: Math.max(0.25, Math.min(50, Number(value?.limitGB) || DEFAULT_CACHE_SETTINGS.limitGB)),
  }
}
export const saveCacheSettings = (owner: string, value: CacheSettings) => writeStore('meta', value, `settings:${owner}`)
