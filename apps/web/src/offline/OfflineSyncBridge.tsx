import { useEffect } from 'react'
import { useAccountStore } from '../stores/account'
import { WATCH_PROGRESS_FLUSH_EVENT } from '../lib/watch-history'
import { syncOfflineProgress } from './progress'

export function OfflineSyncBridge() {
  const owner = useAccountStore((state) => state.user?.id)
  useEffect(() => {
    if (!owner) return
    let active = true
    const sync = () => { if (active) void syncOfflineProgress(owner).catch(() => {}) }
    sync()
    window.addEventListener('online', sync)
    window.addEventListener(WATCH_PROGRESS_FLUSH_EVENT, sync)
    const timer = window.setInterval(sync, 60_000)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('online', sync); window.removeEventListener(WATCH_PROGRESS_FLUSH_EVENT, sync) }
  }, [owner])
  return null
}
