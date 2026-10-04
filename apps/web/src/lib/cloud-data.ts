import { api } from './api'
import { useHistoryStore } from '../stores/history'
import { usePluginStore } from '../stores/plugins'
import { useSearchHistoryStore } from '../stores/search-history'
import { useSettingsStore } from '../stores/settings'
import { useSourceBindingStore } from '../stores/source-bindings'
import { useWatchedStore } from '../stores/watched'

/**
 * Only these local stores are eligible for cloud sync. Authentication tokens,
 * admin secrets, plugin result caches and site cache are intentionally absent.
 */
export const CLOUD_DATA_KEYS = [
  'animaku-settings',
  'animaku-history',
  'animaku-plugins',
  'animaku-search-history',
  'animaku-watched-episodes',
  'animaku-source-bindings',
  'animaku:custom-oped-marks',
  'kz-settings-open-sections',
] as const

export type CloudData = Record<string, unknown>

function parseStored(raw: string | null): unknown {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

function sanitizeSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const copy = { ...(value as Record<string, unknown>) }
  // Bangumi is a separate provider. Its access token must stay on-device.
  delete copy.bangumiToken
  return copy
}

function sanitizeValue(key: string, value: unknown): unknown {
  return key === 'animaku-settings' ? sanitizeSettings(value) : value
}

export function collectCloudData(storage: Storage = window.localStorage): CloudData {
  const result: CloudData = {}
  for (const key of CLOUD_DATA_KEYS) {
    const parsed = parseStored(storage.getItem(key))
    if (parsed !== undefined) result[key] = sanitizeValue(key, parsed)
  }
  return result
}

function dedupeArray(items: unknown[]): unknown[] {
  const seen = new Set<string>()
  const result: unknown[] = []
  for (const item of items) {
    let key: string
    try { key = JSON.stringify(item) } catch { continue }
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

/** Merge local and cloud state while keeping local settings/token precedence. */
export function mergeCloudData(local: CloudData, remote: CloudData): CloudData {
  const merged: CloudData = {}
  for (const key of CLOUD_DATA_KEYS) {
    const hasLocal = Object.prototype.hasOwnProperty.call(local, key)
    const hasRemote = Object.prototype.hasOwnProperty.call(remote, key)
    if (!hasLocal && !hasRemote) continue
    if (!hasLocal) {
      merged[key] = remote[key]
      continue
    }
    if (!hasRemote) {
      merged[key] = sanitizeValue(key, local[key])
      continue
    }
    const left = local[key]
    const right = remote[key]
    if (Array.isArray(left) && Array.isArray(right)) {
      merged[key] = dedupeArray([...right, ...left])
    } else if (key === 'animaku-settings' && left && typeof left === 'object' && right && typeof right === 'object') {
      // Local settings win, but remote settings fill keys introduced on a
      // different device. Preserve the local-only Bangumi token as well.
      merged[key] = { ...(right as Record<string, unknown>), ...(left as Record<string, unknown>) }
    } else if (left && typeof left === 'object' && right && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      merged[key] = { ...(right as Record<string, unknown>), ...(left as Record<string, unknown>) }
    } else {
      merged[key] = left
    }
    merged[key] = sanitizeValue(key, merged[key])
  }
  return merged
}

export function applyCloudData(data: CloudData, storage: Storage = window.localStorage): void {
  for (const key of CLOUD_DATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue
    storage.setItem(key, JSON.stringify(sanitizeValue(key, data[key])))
  }
}

async function rehydrateStores(): Promise<void> {
  await Promise.all([
    useSettingsStore.persist.rehydrate(),
    useHistoryStore.persist.rehydrate(),
    usePluginStore.persist.rehydrate(),
    useSearchHistoryStore.persist.rehydrate(),
    useWatchedStore.persist.rehydrate(),
    useSourceBindingStore.persist.rehydrate(),
  ])
}

export async function syncCloudData(): Promise<{ keys: number; remoteUpdatedAt: number }> {
  const remote = await api<{ data?: CloudData; updatedAt?: number }>('/api/account/data')
  const local = collectCloudData()
  const merged = mergeCloudData(local, remote.data || {})
  applyCloudData(merged)
  await rehydrateStores()
  await api('/api/account/data', {
    method: 'PUT',
    body: JSON.stringify({ data: merged }),
  })
  return { keys: Object.keys(merged).length, remoteUpdatedAt: remote.updatedAt || 0 }
}
