import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { WatchSession } from '../lib/use-watch-session'
import { enqueueCache, initializeOffline, releasePlayback } from './manager'
import { cacheSettings, offlineProfile } from './profile'
import type { CacheInput } from './types'

export function cacheInputs(w: WatchSession, includeDanmaku: boolean, episodes: number[]): CacheInput[] {
  const selection = w.selection
  if (!selection) return []
  return w.slots.filter((slot) => episodes.includes(slot.canonicalEp)).map((slot) => ({
    bangumiId: w.bangumiId, episode: slot.canonicalEp, title: w.title,
    episodeTitle: slot.displayTitle, cover: slot.imageMedium || w.cover,
    road: w.visibleRoad, pageUrl: slot.pageUrl, sourceUrl: selection.source.src,
    plugin: selection.plugin, includeDanmaku,
    // Preserve exactly the selected pools/offsets for the currently playing ep.
    comments: includeDanmaku && w.episode?.pageUrl === slot.pageUrl && w.dm.visibleComments.length
      ? w.dm.visibleComments : undefined,
  }))
}
export function useAutomaticCache(w: WatchSession): void {
  useEffect(() => { void initializeOffline(); return releasePlayback }, [])
  useEffect(() => {
    if (!w.mediaSrc || !w.episode || w.episode.road !== w.visibleRoad) return
    let cancelled = false
    const queue = async () => {
      const owner = offlineProfile()?.id
      if (!owner) return
      const settings = await cacheSettings(owner)
      if (!settings.auto || cancelled) return
      const current = w.slots.findIndex((slot) => slot.pageUrl === w.episode?.pageUrl)
      if (current < 0) return
      const next = w.slots.slice(current + 1, current + 1 + settings.ahead).map((slot) => slot.canonicalEp)
      if (next.length) await enqueueCache(cacheInputs(w, false, next), true)
    }
    const trigger = () => { void queue().catch(() => {}) }
    trigger()
    window.addEventListener('animaku:cache-settings', trigger)
    return () => { cancelled = true; window.removeEventListener('animaku:cache-settings', trigger) }
  }, [w.mediaSrc, w.episode, w.selection, w.slots, w.visibleRoad])
}
export function CacheEpisodePicker({ session: w }: { session: WatchSession }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [danmaku, setDanmaku] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
  if (!w.selection || !w.slots.length) return null
  const submit = async () => {
    setBusy(true); setNotice('')
    try {
      await enqueueCache(cacheInputs(w, danmaku, selected))
      setNotice('已加入缓存队列，可在缓存与下载中心查看。请保持页面打开。')
      setOpen(false)
    } catch (error) { setNotice(error instanceof Error ? error.message : '添加失败') }
    finally { setBusy(false) }
  }
  return <div className="mb-3 space-y-2 text-sm">
    <div className="flex flex-wrap items-center gap-3">
      <button className="rounded-xl border border-[var(--kz-border)] px-4 py-2" onClick={() => { setSelected([w.episode?.episode ?? w.slots[0].canonicalEp]); setDanmaku(false); setNotice(''); setOpen(true) }}>缓存 / 下载剧集</button>
      <Link to="/offline" className="text-[var(--kz-accent)]">缓存与下载中心 →</Link>
    </div>
    {!open && notice && <p role="status" className="text-[var(--kz-fg-muted)]">{notice}</p>}
    <dialog ref={dialog} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="cache-picker-title" className="m-auto w-[min(92vw,680px)] rounded-2xl border border-[var(--kz-border)] bg-[var(--kz-bg-elevated)] p-5 text-[var(--kz-fg)] backdrop:bg-black/50">
      <div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="cache-picker-title" className="text-lg font-semibold">选择保存的剧集</h2><p className="text-sm text-[var(--kz-fg-muted)]">{w.title} · {w.selection.plugin.name} · 当前线路</p></div><button aria-label="关闭选集" onClick={() => setOpen(false)} className="px-2 py-1">✕</button></div>
      <div className="mb-3 flex gap-4"><button onClick={() => setSelected(w.slots.map((slot) => slot.canonicalEp))}>全选</button><button onClick={() => setSelected([])}>清空</button><label className="ml-auto flex items-center gap-2"><input type="checkbox" checked={danmaku} onChange={(event) => setDanmaku(event.target.checked)} />同时缓存弹幕</label></div>
      <div className="grid max-h-[45vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">{w.slots.map((slot) => <label key={slot.pageUrl} title={slot.displayTitle} className="flex min-w-0 items-center gap-2 rounded-xl border border-[var(--kz-border)] p-3"><input type="checkbox" checked={selected.includes(slot.canonicalEp)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, slot.canonicalEp] : old.filter((ep) => ep !== slot.canonicalEp))} /><span className="min-w-0 truncate">{slot.displayTitle}</span></label>)}</div>
      <p className="my-3 text-xs text-[var(--kz-fg-muted)]">保存到本机浏览器，完成后可以离线观看，也可以导出文件。弹幕单独保存，不会写进视频画面。</p>
      {notice && <p role="alert" className="my-3 text-sm">{notice}</p>}
      <button disabled={busy || !selected.length} onClick={() => void submit()} className="w-full rounded-xl bg-[var(--kz-accent)] px-4 py-3 font-medium text-white disabled:opacity-50">{busy ? '正在准备离线播放器…' : `保存 ${selected.length} 集`}</button>
    </dialog>
  </div>
}
