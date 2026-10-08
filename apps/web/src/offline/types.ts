import type { BangumiEpisode, DanmakuComment, PluginMeta, WatchHistoryEntry } from '@animaku/shared'

export const DB_NAME = 'animaku-offline-v1'
export const MEDIA_PREFIX = '/_offline/media/'
export const CHUNK_BYTES = 4 * 1024 * 1024
export type OfflineProfile = { id: string; username: string }
export type CacheSettings = { auto: boolean; ahead: number; limitGB: number }
export const DEFAULT_CACHE_SETTINGS: CacheSettings = { auto: false, ahead: 2, limitGB: 2 }
export type CacheInput = {
  bangumiId: number; episode: number; title: string; episodeTitle: string
  cover?: string; road: number; pageUrl: string; sourceUrl?: string
  plugin: PluginMeta; officialEpisodes?: BangumiEpisode[]
  comments?: DanmakuComment[]; includeDanmaku: boolean
}
export type OfflineTask = CacheInput & {
  id: string; owner: string; automatic: boolean
  status: 'queued' | 'downloading' | 'paused' | 'ready' | 'error'
  bytes: number; completed: number; total: number; totalBytes?: number
  format?: 'hls' | 'mp4'; entry?: string; fingerprint?: string
  createdAt: number; lastUsed: number; error?: string; warning?: string
  danmakuPending?: boolean
  tsExport?: boolean
}
export type MediaFile = {
  key: string; taskId: string; name: string; blob: Blob; mime: string
  /** Byte offset for progressive MP4 chunks. HLS files use complete individual blobs. */
  offset?: number
}
export type MediaMeta = Omit<MediaFile, 'blob'> & { size: number }
export type PendingProgress = WatchHistoryEntry & { owner: string }
export type BufferHealth = { starving: boolean; ahead: number; paused: boolean; fullyBuffered?: boolean }
export function taskIdentity(task: CacheInput, owner: string): string {
  return JSON.stringify([owner, task.bangumiId, task.episode, task.plugin.name, task.road, task.pageUrl])
}
export function mediaUrl(task: OfflineTask): string {
  return `${MEDIA_PREFIX}${encodeURIComponent(task.id)}/${task.entry || 'video.mp4'}`
}
