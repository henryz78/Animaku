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
  if (copy.state && typeof copy.state === 'object' && !Array.isArray(copy.state)) {
    const state = { ...(copy.state as Record<string, unknown>) }
    delete state.bangumiToken
    copy.state = state
  }
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

function mergePersistedState(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const leftState = left.state
  const rightState = right.state
  if (!leftState || typeof leftState !== 'object' || Array.isArray(leftState) || !rightState || typeof rightState !== 'object' || Array.isArray(rightState)) {
    return { ...right, ...left }
  }
  const mergedState = { ...(rightState as Record<string, unknown>), ...(leftState as Record<string, unknown>) }
  for (const key of ['items', 'queries', 'plugins', 'pluginOrder']) {
    const localItems = (leftState as Record<string, unknown>)[key]
    const remoteItems = (rightState as Record<string, unknown>)[key]
    if (Array.isArray(localItems) && Array.isArray(remoteItems)) mergedState[key] = dedupeArray([...remoteItems, ...localItems])
  }
  for (const key of ['records', 'bindings']) {
    const localMap = (leftState as Record<string, unknown>)[key]
    const remoteMap = (rightState as Record<string, unknown>)[key]
    if (localMap && typeof localMap === 'object' && !Array.isArray(localMap) && remoteMap && typeof remoteMap === 'object' && !Array.isArray(remoteMap)) {
      mergedState[key] = { ...(remoteMap as Record<string, unknown>), ...(localMap as Record<string, unknown>) }
    }
  }
  return { ...right, ...left, state: mergedState }
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
    } else if (left && typeof left === 'object' && right && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      // Persisted Zustand stores keep user data under `state`; merge the
      // collections/maps there instead of dropping another device's entries.
      merged[key] = mergePersistedState(left as Record<string, unknown>, right as Record<string, unknown>)
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
    let nextValue = sanitizeValue(key, data[key])
    // Keep the locally stored Bangumi credential on this device while the
    // rest of the settings are replaced by the merged cloud snapshot.
    if (key === 'animaku-settings') {
      const existing = parseStored(storage.getItem(key))
      const currentState = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>).state
        : undefined
      if (currentState && typeof currentState === 'object' && !Array.isArray(currentState) && nextValue && typeof nextValue === 'object' && !Array.isArray(nextValue)) {
        const next = { ...(nextValue as Record<string, unknown>) }
        const nextState = next.state
        if (nextState && typeof nextState === 'object' && !Array.isArray(nextState)) {
          const token = (currentState as Record<string, unknown>).bangumiToken
          if (typeof token === 'string' && token) next.state = { ...(nextState as Record<string, unknown>), bangumiToken: token }
        }
        nextValue = next
      }
    }
    storage.setItem(key, JSON.stringify(nextValue))
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
