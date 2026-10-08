import { useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAccountStore } from '../stores/account'
import { useSettingsStore } from '../stores/settings'
import { VideoPlayerSuspense } from '../player/lazy'
import { initializeOffline, pauseCache, resumeCache, removeCache, useOfflineStore, setPlayingCache, touchCache, ensureRoom } from '../offline/manager'
import { cacheSettings, offlineProfile, saveCacheSettings } from '../offline/profile'
import { exportCache, exportDanmaku } from '../offline/export'
import { offlineResume, saveOfflineProgress } from '../offline/progress'
import { DEFAULT_CACHE_SETTINGS, mediaUrl, type CacheSettings, type OfflineTask } from '../offline/types'

const buttonClass = 'shrink-0 whitespace-nowrap rounded-xl border border-[var(--kz-border)] px-3 py-2 text-sm disabled:opacity-40'
const statusText = { queued: '排队中', downloading: '下载中', paused: '已暂停', ready: '已完成', error: '需要重试' }
export function formatBytes(bytes: number): string { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB` }

export function OfflinePage() {
  const account = useAccountStore()
  const [profile, setProfile] = useState(offlineProfile)
  const [online, setOnline] = useState(navigator.onLine)
  const tasks = useOfflineStore((state) => state.tasks)
  const error = useOfflineStore((state) => state.error)
  const initialized = useOfflineStore((state) => state.initialized)
  const waiting = useOfflineStore((state) => state.waitingForPlayback)
  const [settings, setSettings] = useState<CacheSettings>(DEFAULT_CACHE_SETTINGS)
  const [selected, setSelected] = useState<string[]>([])
  const [playing, setPlaying] = useState<OfflineTask | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const owner = account.user?.id || profile?.id
  const mine = tasks.filter((task) => task.owner === owner)
  useEffect(() => {
    void initializeOffline()
    if (!account.initialized && navigator.onLine) void account.init()
    const update = () => { setProfile(offlineProfile()); setOnline(navigator.onLine) }
    const connected = () => { update(); void useAccountStore.getState().init() }
    window.addEventListener('animaku:offline-owner', update)
    window.addEventListener('online', connected); window.addEventListener('offline', update)
    return () => { window.removeEventListener('animaku:offline-owner', update); window.removeEventListener('online', connected); window.removeEventListener('offline', update) }
  }, [account.init, account.initialized])
  useEffect(() => { let active = true; if (owner) void cacheSettings(owner).then((value) => { if (active) setSettings(value) }).catch(() => {}); return () => { active = false } }, [owner])
  useEffect(() => { setPlaying(null); setSelected([]) }, [owner])
  const act = async (work: () => Promise<unknown>, success = '') => {
    setBusy(true); setNotice('')
    try { await work(); setNotice(success) } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setNotice(error instanceof Error ? error.message : '操作失败') }
    finally { setBusy(false) }
  }
  const changeSettings = (partial: Partial<CacheSettings>) => {
    if (!owner) return
    const value = { ...settings, ...partial }
    setSettings(value)
    void act(async () => { await saveCacheSettings(owner, value); window.dispatchEvent(new Event('animaku:cache-settings')); await ensureRoom({ id: '', owner }, 0) })
  }
  if (online && (!account.initialized || account.loading)) return <div className="p-8">正在检查登录状态…</div>
  if (!owner || (online && !account.user && account.available)) return <Navigate to="/account?redirect=%2Foffline" replace />
  if (!initialized) return <div className="p-8 text-[var(--kz-fg)]">正在读取本机缓存…</div>
  return <main className="min-h-screen bg-[var(--kz-bg)] px-4 py-6 text-[var(--kz-fg)] sm:px-6">
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">缓存与下载</h1><p className="mt-1 text-sm text-[var(--kz-fg-muted)]">{account.user?.username || profile?.username} · {online && account.user ? '已联网' : '本机离线模式'} · 已用 {formatBytes(mine.reduce((sum, task) => sum + task.bytes, 0))}</p></div><nav className="flex gap-3"><Link className={buttonClass} to="/">返回首页</Link><Link className={buttonClass} to="/settings">设置</Link><button className={buttonClass} onClick={() => void account.logout().catch(() => {})}>退出登录</button></nav></header>
      <section className="rounded-2xl border border-[var(--kz-border)] bg-[var(--kz-bg-elevated)] p-4">
        <div className="flex flex-wrap items-center gap-5">
          <label className="flex items-center gap-2"><input type="checkbox" checked={settings.auto} disabled={busy} onChange={(event) => changeSettings({ auto: event.target.checked })} />观看时自动缓存后续剧集</label>
          <label className="flex items-center gap-2">提前存<select className="rounded-lg border border-[var(--kz-border)] bg-[var(--kz-bg)] p-2" value={settings.ahead} disabled={busy} onChange={(event) => changeSettings({ ahead: Number(event.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} 集</option>)}</select></label>
          <label className="flex items-center gap-2">空间上限<select className="rounded-lg border border-[var(--kz-border)] bg-[var(--kz-bg)] p-2" value={settings.limitGB} disabled={busy} onChange={(event) => changeSettings({ limitGB: Number(event.target.value) })}>{[0.25, 0.5, 1, 2, 5, 10, 20, 50].map((n) => <option key={n} value={n}>{n} GB</option>)}</select></label>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-[var(--kz-fg-muted)]">默认不开启自动缓存，也不缓存弹幕。空间不足时先清理最久未用的自动缓存；手动保存的剧集保留。当前播放缺缓冲时会暂停后台下载。关闭网页后下载暂停，重新打开可继续。浏览器仍可能清理本站存储，重要视频建议导出文件。</p>
        {waiting && <p role="status" className="mt-2 text-sm">正在优先缓冲当前视频，后台下载稍后继续。</p>}
      </section>
      {playing && <OfflinePlayer key={playing.id} task={playing} onClose={() => setPlaying(null)} onError={setNotice} />}
      {(notice || error) && <p role="status" className="rounded-xl border border-[var(--kz-border)] p-3 text-sm">{notice || error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button className={buttonClass} onClick={() => setSelected(mine.map((task) => task.id))}>全选</button><button className={buttonClass} onClick={() => setSelected([])}>清空选择</button>
        <button className={buttonClass} disabled={busy || !selected.length || !online} onClick={() => void act(async () => { for (const id of selected) await resumeCache(id) })}>继续所选</button>
        <button className={buttonClass} disabled={busy || !selected.length} onClick={() => void act(async () => { for (const id of selected) await pauseCache(id) })}>暂停所选</button>
        <button className={buttonClass} disabled={busy || !selected.length} onClick={() => void act(async () => { for (const id of selected) await removeCache(id); setSelected([]) })}>删除所选</button>
        <button className={buttonClass} disabled={busy || !mine.some((task) => task.automatic)} onClick={() => void act(async () => { for (const task of mine.filter((row) => row.automatic && row.id !== playing?.id)) await removeCache(task.id) }, '已清理自动缓存，观看记录会保留')}>清理自动缓存</button>
      </div>
      {!mine.length && <div className="rounded-2xl border border-dashed border-[var(--kz-border)] p-10 text-center"><p>还没有本机缓存</p><p className="mt-2 text-sm text-[var(--kz-fg-muted)]">到番剧播放页面，点击“缓存 / 下载剧集”选择需要保存的集数。</p></div>}
      <div className="grid gap-3 sm:grid-cols-2">{mine.slice().sort((a, b) => b.createdAt - a.createdAt).map((task) => <article key={task.id} className="min-w-0 rounded-2xl border border-[var(--kz-border)] bg-[var(--kz-bg-elevated)] p-4">
        <div className="flex items-start gap-3"><input className="mt-1" aria-label={`选择${task.title}第${task.episode}集`} type="checkbox" checked={selected.includes(task.id)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, task.id] : old.filter((id) => id !== task.id))} /><div className="min-w-0 flex-1"><h2 className="break-words font-semibold">{task.title}</h2><p className="mt-1 break-words text-sm">{task.episodeTitle || `第 ${task.episode} 集`}</p><p className="mt-1 text-xs text-[var(--kz-fg-muted)]">{task.plugin.name} · {task.automatic ? '自动缓存' : '手动保存'} · {statusText[task.status]} · {formatBytes(task.bytes)}{task.includeDanmaku ? ` · 弹幕 ${(task.comments || []).length} 条` : ''}</p></div></div>
        <progress aria-label="缓存进度" className="my-3 h-2 w-full accent-[var(--kz-accent)]" value={task.status === 'ready' ? 1 : task.total ? task.completed / task.total : 0} max={1} />
        {(task.error || task.warning) && <p className="mb-3 text-sm text-[var(--kz-fg-muted)]">{task.error || task.warning}</p>}
        <div className="flex flex-wrap gap-2">
          {task.status === 'ready' ? <><button className={buttonClass} onClick={() => setPlaying(task)}>本机播放</button>{(task.format === 'mp4' || task.tsExport) && <button className={buttonClass} disabled={busy} onClick={() => void act(() => exportCache(task, 'video'), '已开始导出；请保持页面打开。在外部播放器观看不会同步本站进度')}>导出 {task.format === 'mp4' ? 'MP4' : 'TS'}</button>}{task.format === 'hls' && <button className={buttonClass} disabled={busy} onClick={() => void act(() => exportCache(task, 'package'), '已开始导出分片包，请保持页面打开；弹幕可单独导出')}>分片包 ZIP</button>}{!!task.comments?.length && <button className={buttonClass} onClick={() => exportDanmaku(task)}>弹幕 XML</button>}</>
            : task.status === 'queued' || task.status === 'downloading' ? <button className={buttonClass} disabled={busy} onClick={() => void act(() => pauseCache(task.id))}>暂停</button> : <button className={buttonClass} disabled={busy || !online} onClick={() => void act(() => resumeCache(task.id))}>继续 / 重试</button>}
          <button className={buttonClass} disabled={busy || playing?.id === task.id} onClick={() => void act(() => removeCache(task.id))}>删除</button>
        </div>
      </article>)}</div>
      <p className="text-xs leading-relaxed text-[var(--kz-fg-muted)]">缓存属于当前设备和浏览器，不会占用服务器视频存储，也不会包含在数据备份中。普通 MP4 可导出 MP4；符合条件的 HLS 可合并成 TS，其他已支持的 HLS 可导出分片包。弹幕不会烧录到视频。离线观看进度在本机保存，联网登录同一账号后补同步；外部播放器的进度无法读取。</p>
    </div>
  </main>
}
function OfflinePlayer({ task, onClose, onError }: { task: OfflineTask; onClose: () => void; onError: (message: string) => void }) {
  const player = useSettingsStore((state) => state.player)
  const danmaku = useSettingsStore((state) => state.danmaku)
  const [resume, setResume] = useState<number | null>(null)
  const last = useRef({ position: 0, duration: 0 })
  const lastSave = useRef(0)
  const saveChain = useRef(Promise.resolve())
  useEffect(() => {
    let active = true
    setPlayingCache(task.id)
    void touchCache(task.id).catch(() => {})
    void offlineResume(task).then((time) => { if (active) setResume(time) }).catch(() => { if (active) setResume(0) })
    const flush = () => {
      const value = { ...last.current }
      if (!value.duration) return
      saveChain.current = saveChain.current.then(() => saveOfflineProgress(task, value.position, value.duration)).catch(() => onError('观看记录保存失败，请检查本机存储空间'))
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => { active = false; flush(); setPlayingCache(''); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', flush) }
  }, [task.id, onError])
  const onProgress = (position: number, duration: number) => {
    last.current = { position, duration }
    if (Date.now() - lastSave.current > 3000 || duration - position < 2) {
      lastSave.current = Date.now()
      saveChain.current = saveChain.current.then(() => saveOfflineProgress(task, position, duration)).catch(() => onError('观看记录保存失败，请检查本机存储空间'))
    }
  }
  // The shared player only emits saved progress after valid playback for an
  // identified subject. Offline playback needs the same subject/episode identity.
  return <section className="overflow-hidden rounded-2xl border border-[var(--kz-border)]"><div className="flex items-center justify-between gap-3 p-3"><span className="min-w-0 truncate">本机播放 · {task.title} · 第 {task.episode} 集</span><button className={buttonClass} onClick={onClose}>关闭播放器</button></div>{resume !== null && <VideoPlayerSuspense bangumiId={task.bangumiId} episodeNumber={task.episode} title={task.title} src={mediaUrl(task)} formatHint={task.format} initialTime={resume} comments={task.comments || []} danmaku={danmaku} player={player} onPlayerChange={useSettingsStore.getState().setPlayer} onDanmakuChange={useSettingsStore.getState().setDanmaku} onToggleDanmaku={() => useSettingsStore.getState().setDanmaku({ enabled: !useSettingsStore.getState().danmaku.enabled })} onProgress={onProgress} onMediaLoadFailed={() => onError('本机媒体无法播放，可能已被浏览器清理。请删除后重新缓存。')} />}</section>
}
