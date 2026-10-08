import { historyId } from '@animaku/shared'
import { acknowledgeProgress, readStore, savePending } from './db'
import { useAccountStore } from '../stores/account'
import { useHistoryStore } from '../stores/history'
import { mergeWatchHistory, WATCH_PROGRESS_FLUSH_EVENT } from '../lib/watch-history'
import { syncCloudData } from '../lib/cloud-data'
import type { OfflineTask, PendingProgress } from './types'

export async function saveOfflineProgress(task: OfflineTask, position: number, duration: number): Promise<void> {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || position < 0 || duration <= 0) return
  await savePending({ owner: task.owner, id: historyId(task.bangumiId, task.plugin.name, task.episode, task.road), bangumiId: task.bangumiId, episode: task.episode, title: task.title, cover: task.cover, road: task.road, pluginName: task.plugin.name, pageUrl: task.pageUrl, sourceUrl: task.sourceUrl, position, duration, updatedAt: Date.now() })
  window.dispatchEvent(new Event(WATCH_PROGRESS_FLUSH_EVENT))
}
export async function offlineResume(task: OfflineTask): Promise<number> {
  const entry = await readStore<PendingProgress | undefined>('progress', `${task.owner}:${historyId(task.bangumiId, task.plugin.name, task.episode, task.road)}`)
  const online = useAccountStore.getState().user?.id === task.owner ? useHistoryStore.getState().forBangumi(task.bangumiId) : undefined
  const newest = entry && (!online || entry.updatedAt >= online.updatedAt) ? entry : online
  if (newest?.episode !== task.episode || newest.duration - newest.position <= 60) return 0
  return newest.position || 0
}
let syncing: Promise<void> | undefined
export function syncOfflineProgress(owner: string): Promise<void> {
  if (syncing) return syncing.then(() => syncOfflineProgress(owner))
  syncing = (async () => {
    const entries = (await readStore<PendingProgress[]>('progress')).filter((entry) => entry.owner === owner)
    if (!entries.length || useAccountStore.getState().user?.id !== owner) return
    const apply = () => useHistoryStore.setState((state) => ({ items: mergeWatchHistory(entries, state.items) }))
    apply()
    await syncCloudData()
    // Another caller may already have started a sync before pending history was
    // applied. A second fresh snapshot ensures the upload includes these saves.
    if (useAccountStore.getState().user?.id !== owner) return
    apply()
    await syncCloudData()
    if (useAccountStore.getState().user?.id === owner) await acknowledgeProgress(entries)
  })().finally(() => { syncing = undefined })
  return syncing
}
