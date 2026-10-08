import { historyId, type WatchHistoryEntry } from '@animaku/shared'

export const MAX_HISTORY_ITEMS = 200
export const WATCH_PROGRESS_FLUSH_EVENT = 'animaku:watch-progress-flush'

/** First group wins ties; a later save may intentionally have a lower position. */
export function mergeWatchHistory(...groups: unknown[][]): WatchHistoryEntry[] {
  const latest = new Map<string, WatchHistoryEntry>()
  for (const items of groups) {
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const item = raw as WatchHistoryEntry
      if (!Number.isFinite(item.bangumiId) || item.bangumiId <= 0) continue
      const episode = item.episode ?? 1
      if (!Number.isFinite(episode) || episode < 0) continue
      const id = historyId(item.bangumiId, item.pluginName, episode, item.road)
      const updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : 0
      const previous = latest.get(id)
      if (!previous || updatedAt > previous.updatedAt) {
        latest.set(id, { ...item, id, episode, road: item.road ?? 0, updatedAt })
      }
    }
  }
  return [...latest.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_HISTORY_ITEMS)
}
