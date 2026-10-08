import { create } from 'zustand'
import { pluginApi, danmakuApi } from '../lib/plugin-api'
import { bangumiApi } from '../lib/bangumi'
import { pickPlaybackSrc, withFullProxy } from '../lib/playback-src'
import { resolveDanmakuEpisode } from '../lib/use-danmaku-session'
import { cacheSettings, offlineProfile } from './profile'
import { deleteTask, readStore, readTasks, saveFile, saveTask } from './db'
import { CHUNK_BYTES, taskIdentity, type BufferHealth, type CacheInput, type OfflineTask } from './types'
import { parseContentRange, planHls, variantUrl } from './hls'
import { prepareOfflineShell } from './register'

export const useOfflineStore = create<{
  tasks: OfflineTask[]; initialized: boolean; error: string; waitingForPlayback: boolean
}>(() => ({ tasks: [], initialized: false, error: '', waitingForPlayback: false }))
let initializing: Promise<void> | undefined
let running: Promise<void> | undefined
let controller: AbortController | undefined
let activeId = ''
let playingId = ''
let healthySince = 0
const pausedByUser = new Set<string>()
const reserved = new Set<string>()
const pinnedByUser = new Set<string>()
let enqueueChain: Promise<unknown> = Promise.resolve()

export async function initializeOffline(): Promise<void> {
  if (initializing) return initializing
  initializing = (async () => {
    try {
      const tasks = await readTasks()
      const recover = async () => {
        for (const task of tasks) {
          if (task.status === 'downloading' || task.status === 'queued') {
            task.status = 'paused'
            await saveTask(task)
          }
        }
      }
      if (navigator.locks) await navigator.locks.request('animaku-offline-download', { ifAvailable: true }, async (lock) => { if (lock) await recover() })
      else await recover()
      useOfflineStore.setState({ tasks, initialized: true })
    } catch (error) {
      useOfflineStore.setState({ initialized: true, error: message(error) })
    }
    window.addEventListener('animaku:offline-owner', () => {
      controller?.abort()
      useOfflineStore.setState({ waitingForPlayback: false })
    })
    window.addEventListener('offline', () => controller?.abort())
    window.addEventListener('online', () => { void pump() })
  })()
  return initializing
}
function message(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return '本机可用空间不足，请清理缓存或降低空间上限'
  return error instanceof Error ? error.message : '缓存操作失败'
}
function publish(task: OfflineTask): void {
  useOfflineStore.setState((state) => ({ tasks: state.tasks.map((row) => row.id === task.id ? { ...task } : row) }))
}
async function update(task: OfflineTask): Promise<void> { if (pinnedByUser.has(task.id)) task.automatic = false; await saveTask(task); publish(task) }
function assertActive(signal: AbortSignal, task: OfflineTask): void {
  signal.throwIfAborted()
  if (offlineProfile()?.id !== task.owner) throw new DOMException('账号已退出', 'AbortError')
}
/** Only automatic, completed, idle entries may be evicted. Pinned/manual entries survive. */
export async function ensureRoom(task: Pick<OfflineTask, 'id' | 'owner'>, bytes: number): Promise<void> {
  const settings = await cacheSettings(task.owner)
  const cap = settings.limitGB * 1024 ** 3
  const estimate = await navigator.storage?.estimate?.()
  let usage = useOfflineStore.getState().tasks.filter((row) => row.owner === task.owner).reduce((sum, row) => sum + row.bytes, 0)
  let available = estimate?.quota == null ? Infinity : Math.max(0, estimate.quota - (estimate.usage || 0))
  const usedInTabs = await cacheLocks()
  const candidates = useOfflineStore.getState().tasks
    .filter((row) => row.owner === task.owner && row.automatic && row.status === 'ready' && row.id !== task.id && row.id !== playingId && !reserved.has(row.id) && !usedInTabs.has(`animaku-offline-use:${row.id}`))
    .sort((a, b) => a.lastUsed - b.lastUsed)
  for (const candidate of candidates) {
    if (usage + bytes <= cap && bytes + 8 * 1024 ** 2 < available) break
    await deleteTask(candidate.id)
    usage -= candidate.bytes
    available += candidate.bytes
    useOfflineStore.setState((state) => ({ tasks: state.tasks.filter((row) => row.id !== candidate.id) }))
  }
  if (usage + bytes > cap || bytes + 8 * 1024 ** 2 >= available) {
    throw new Error('已到空间上限。手动缓存和正在播放的剧集会保留，请清理后继续')
  }
}
async function storeBytes(task: OfflineTask, name: string, blob: Blob, mime: string, signal: AbortSignal, offset?: number): Promise<void> {
  assertActive(signal, task)
  await ensureRoom(task, blob.size)
  assertActive(signal, task)
  const next = { ...task, automatic: pinnedByUser.has(task.id) ? false : task.automatic, bytes: task.bytes + blob.size, completed: task.completed + 1 }
  await saveFile(next, { key: `${task.id}/${name}`, taskId: task.id, name, blob, mime, offset })
  Object.assign(task, next)
  publish(task)
}
export async function enqueueCache(inputs: CacheInput[], automatic = false): Promise<void> {
  const work = enqueueChain.then(async () => {
    await initializeOffline()
    const owner = offlineProfile()?.id
    if (!owner) throw new Error('请先联网登录后再缓存')
    if (useOfflineStore.getState().error) throw new Error(useOfflineStore.getState().error)
    const additions = inputs.filter((input) => !useOfflineStore.getState().tasks.some((row) => taskIdentity(row, row.owner) === taskIdentity(input, owner)))
    if (!additions.length) {
      for (const input of inputs) {
        const existing = useOfflineStore.getState().tasks.find((row) => taskIdentity(row, row.owner) === taskIdentity(input, owner))
        if (existing) await upgradeCached(taskIdentity(input, owner), input, automatic)
      }
      void pump()
      return
    }
    await prepareOfflineShell()
    // This may be denied by the browser. Quota checks and eviction remain necessary.
    await navigator.storage?.persist?.().catch(() => false)
    for (const input of inputs) {
      const existing = useOfflineStore.getState().tasks.find((row) => taskIdentity(row, row.owner) === taskIdentity(input, owner))
      if (existing) {
        await upgradeCached(taskIdentity(input, owner), input, automatic)
        continue
      }
      const task: OfflineTask = { ...input, id: crypto.randomUUID(), owner, automatic, status: 'queued', bytes: 0, completed: 0, total: 0, createdAt: Date.now(), lastUsed: Date.now() }
      await saveTask(task)
      useOfflineStore.setState((state) => ({ tasks: [...state.tasks, task] }))
    }
    void pump()
  })
  enqueueChain = work.catch(() => {})
  return work
}
async function upgradeCached(identity: string, input: CacheInput, automatic: boolean): Promise<void> {
  const existing = useOfflineStore.getState().tasks.find((row) => taskIdentity(row, row.owner) === identity)
  if (!existing) return
  const task = { ...existing }
  if (!automatic) { pinnedByUser.add(task.id); task.automatic = false }
  if (input.includeDanmaku) {
    task.includeDanmaku = true
    if (input.comments) task.comments = input.comments
    else if (!task.comments?.length && task.status === 'ready') { task.danmakuPending = true; task.status = 'queued'; task.comments = undefined }
  }
  await update(task)
}
export async function pauseCache(id: string): Promise<void> {
  const locks = await cacheLocks()
  if (locks.has('animaku-offline-download') && !activeId) throw new Error('其他标签页正在下载，请在那个页面暂停后再操作')
  pausedByUser.add(id)
  if (activeId === id) { controller?.abort(); await running }
  const task = useOfflineStore.getState().tasks.find((row) => row.id === id && row.owner === offlineProfile()?.id)
  if (task && task.status !== 'ready') await update({ ...task, status: 'paused' })
}
export async function resumeCache(id: string): Promise<void> {
  const task = useOfflineStore.getState().tasks.find((row) => row.id === id && row.owner === offlineProfile()?.id)
  if (!task || task.status === 'ready' || task.status === 'downloading') return
  await prepareOfflineShell()
  pausedByUser.delete(id)
  await update({ ...task, status: 'queued', error: undefined })
  void pump()
}
export async function removeCache(id: string): Promise<void> {
  const task = useOfflineStore.getState().tasks.find((row) => row.id === id && row.owner === offlineProfile()?.id)
  if (!task) return
  if (id === playingId || reserved.has(id) || (await cacheLocks()).has(`animaku-offline-use:${id}`)) throw new Error('请先关闭此剧集的播放或导出，再删除')
  await pauseCache(id)
  await deleteTask(id)
  pausedByUser.delete(id)
  useOfflineStore.setState((state) => ({ tasks: state.tasks.filter((row) => row.id !== id) }))
}
export async function touchCache(id: string): Promise<void> {
  const task = useOfflineStore.getState().tasks.find((row) => row.id === id)
  if (task) await update({ ...task, lastUsed: Date.now() })
}
async function cacheLocks(): Promise<Set<string | undefined>> {
  if (!navigator.locks) return new Set()
  const state = await navigator.locks.query()
  return new Set([...(state.held || []), ...(state.pending || [])].map((lock) => lock.name))
}
function holdUseLock(id: string): () => void {
  let released = false; let release: (() => void) | undefined
  if (navigator.locks) void navigator.locks.request(`animaku-offline-use:${id}`, { mode: 'shared' }, () => released ? undefined : new Promise<void>((resolve) => { release = resolve })).catch(() => {})
  return () => { released = true; release?.() }
}
export function protectCache(id: string): () => void { reserved.add(id); const release = holdUseLock(id); return () => { reserved.delete(id); release() } }
let releasePlayingLock: (() => void) | undefined
export function setPlayingCache(id: string): void {
  if (id === playingId) return
  releasePlayingLock?.(); playingId = id
  releasePlayingLock = id ? holdUseLock(id) : undefined
}
export function playbackHealth(health: BufferHealth): void {
  const poor = !health.paused && (health.starving || (!health.fullyBuffered && health.ahead < 3))
  if (poor) {
    healthySince = 0
    useOfflineStore.setState({ waitingForPlayback: true })
    controller?.abort()
  } else if (health.paused || health.fullyBuffered || health.ahead >= 8) {
    if (!healthySince) healthySince = Date.now()
    if (health.paused || Date.now() - healthySince >= 3000) {
      useOfflineStore.setState({ waitingForPlayback: false })
      void pump()
    }
  } else healthySince = 0
}
export function releasePlayback(): void {
  setPlayingCache(''); healthySince = 0
  useOfflineStore.setState({ waitingForPlayback: false })
  void pump()
}
async function pump(): Promise<void> {
  if (running || useOfflineStore.getState().error || useOfflineStore.getState().waitingForPlayback || !navigator.onLine) return
  const owner = offlineProfile()?.id
  const task = useOfflineStore.getState().tasks.find((row) => row.owner === owner && row.status === 'queued')
  if (!task) return
  activeId = task.id
  const abort = new AbortController()
  controller = abort
  let acquired = true
  const download = async () => {
    // A different tab may have completed work while this tab waited.
    const fresh = await readTasks()
    useOfflineStore.setState({ tasks: fresh })
    const next = fresh.find((row) => row.id === task.id)
    if (next?.status === 'queued') await run({ ...next }, abort.signal)
  }
  running = (async () => {
    if (navigator.locks) await navigator.locks.request('animaku-offline-download', { ifAvailable: true }, async (lock) => { if (lock) await download(); else acquired = false })
    else await download()
  })()
  try { await running }
  catch (error) { useOfflineStore.setState({ error: message(error) }) }
  finally { running = undefined; controller = undefined; activeId = '' }
  if (acquired) void pump()
  else window.setTimeout(() => { void pump() }, 5000)
}
async function run(task: OfflineTask, signal: AbortSignal): Promise<void> {
  try {
    task.status = 'downloading'; task.error = undefined
    await update(task)
    assertActive(signal, task)
    if (!task.danmakuPending) {
    const result = await pluginApi.resolve(task.plugin, task.pageUrl, { signal, refresh: true, title: task.title, episode: task.episode, bangumiId: task.bangumiId })
    const resolved = result.data
    const chosen = pickPlaybackSrc(resolved)
    if (!chosen.src) throw new Error('未解析到可下载的视频地址')
    let src = chosen.src
    let response: Response
    const hls = resolved.format === 'hls' || /\.m3u8(?:\?|$)/i.test(src)
    try { response = await fetchMedia(src, signal, hls ? undefined : 'bytes=0-0') }
    catch (error) {
      if (signal.aborted || !resolved.proxyUrl || src === resolved.proxyUrl) throw error
      src = withFullProxy(resolved.proxyUrl)
      response = await fetchMedia(src, signal, hls ? undefined : 'bytes=0-0')
    }
    const cacheResponse = async (response: Response, url: string) => {
      if (hls || /mpegurl/i.test(response.headers.get('Content-Type') || '')) {
        if (response.status === 206) response = await fetchMedia(url, signal)
        await downloadHls(task, response, url, signal)
      } else {
        if (response.status === 206 && !parseContentRange(response.headers.get('Content-Range'))) {
          await response.body?.cancel()
          response = await fetchMedia(url, signal)
        }
        await downloadMp4(task, response, url, signal)
      }
    }
    try { await cacheResponse(response, src) }
    catch (error) {
      const fallback = resolved.proxyUrl ? withFullProxy(resolved.proxyUrl) : ''
      if (signal.aborted || !fallback || src === fallback || !(error instanceof TypeError || error instanceof MediaRequestError && error.status === 403)) throw error
      src = fallback
      await cacheResponse(await fetchMedia(src, signal, hls ? undefined : 'bytes=0-0'), src)
      task.warning = '此片源通过服务器代理缓存，会增加服务器请求用量'
    }
    }
    if (task.includeDanmaku && task.comments === undefined) {
      try {
        try {
          const official = task.officialEpisodes || (await bangumiApi.episodes(task.bangumiId, { signal })).data
          if (!official.some((episode) => episode.type === 0 && episode.sort === task.episode)) throw new Error('无法确认官方集数，未保存猜测匹配的弹幕')
          const meta = await danmakuApi.bangumiByBgm(task.bangumiId, { signal })
          const episode = resolveDanmakuEpisode(meta.data.episodes || [], task.episode, official)
          if (!episode) throw new Error('没有可靠匹配的弹幕集数')
          task.comments = (await danmakuApi.comments(episode.episodeId, { signal })).data
        } catch (error) { if (signal.aborted) throw error }
        if (!task.comments?.length) task.comments = (await danmakuApi.bilibili(`bgm${task.bangumiId}`, task.episode, { signal })).data
        if (!Array.isArray(task.comments)) { task.comments = undefined; throw new Error('弹幕接口没有返回有效列表') }
        if (!task.comments.length) task.warning = '视频已缓存，此集弹幕没有返回内容'
      } catch (error) {
        if (signal.aborted) throw error
        task.warning = `视频已缓存，弹幕未保存：${message(error)}`
      }
    }
    assertActive(signal, task)
    task.danmakuPending = false
    task.status = 'ready'
    await update(task)
  } catch (error) {
    task.status = signal.aborted ? (pausedByUser.has(task.id) || offlineProfile()?.id !== task.owner ? 'paused' : 'queued') : 'error'
    task.error = signal.aborted ? undefined : message(error)
    await update(task).catch((storageError) => useOfflineStore.setState({ error: message(storageError) }))
  }
}
async function fetchMedia(url: string, signal: AbortSignal, range?: string): Promise<Response> {
  const target = new URL(url, location.href)
  if (!/^https?:$/.test(target.protocol)) throw new Error('此视频地址无法下载')
  const response = await fetch(target, { signal, credentials: target.origin === location.origin ? 'same-origin' : 'omit', headers: range ? { Range: range } : undefined })
  if (!response.ok) throw new MediaRequestError(response.status)
  return response
}
class MediaRequestError extends Error {
  constructor(public status: number) { super(`片源返回 ${status}，可稍后重试或换源`) }
}
async function resetForSource(task: OfflineTask, fingerprint: string, signal: AbortSignal): Promise<void> {
  if (task.fingerprint && task.fingerprint !== fingerprint) {
    // Expired signatures or a changed rendition must not combine different bytes.
    assertActive(signal, task)
    await deleteTask(task.id)
    task.bytes = 0; task.completed = 0
    task.warning = '片源链接或文件已变化，已重新下载，避免混合不同版本的视频'
  }
  task.fingerprint = fingerprint
  await update(task)
}
async function downloadHls(task: OfflineTask, initial: Response, src: string, signal: AbortSignal): Promise<void> {
  let text = await initial.text()
  let base = initial.url || new URL(src, location.href).href
  for (let depth = 0; depth < 4; depth++) {
    const variant = variantUrl(text, base)
    if (!variant) break
    const response = await fetchMedia(variant, signal)
    base = response.url || variant; text = await response.text()
  }
  if (variantUrl(text, base)) throw new Error('播放列表嵌套层级过多')
  const plan = planHls(text, base)
  await resetForSource(task, JSON.stringify([plan.playlist, plan.assets]), signal)
  task.format = 'hls'; task.entry = 'index.m3u8'; task.total = plan.assets.length + 1
  task.tsExport = !plan.encrypted && !plan.fragmented && !/#EXT-X-(?:KEY|DISCONTINUITY)/.test(plan.playlist)
  await update(task)
  for (const asset of plan.assets) {
    assertActive(signal, task)
    const cached = await readStore<import('./types').MediaFile | undefined>('files', `${task.id}/${asset.name}`)
    if (cached) { if (asset.kind === 'segment' && task.tsExport) task.tsExport = await isTs(cached.blob); continue }
    const range = asset.range ? `bytes=${asset.range.start}-${asset.range.start + asset.range.length - 1}` : undefined
    const response = await fetchMedia(asset.url, signal, range)
    if (asset.range) {
      const actual = parseContentRange(response.headers.get('Content-Range'))
      if (response.status !== 206 || actual?.start !== asset.range.start || actual.end !== asset.range.start + asset.range.length - 1) throw new Error('片源不支持正确的分片范围下载')
    }
    const blob = await boundedBlob(response, 32 * 1024 ** 2, signal)
    if (!blob.size || (asset.range && blob.size !== asset.range.length) || (asset.kind === 'key' && blob.size !== 16)) throw new Error('片源返回的分片或密钥内容不完整')
    if (asset.kind === 'segment' && task.tsExport) task.tsExport = await isTs(blob)
    const mime = asset.kind === 'key' ? 'application/octet-stream' : asset.kind === 'map' || asset.name.endsWith('.mp4') ? 'video/mp4' : 'video/mp2t'
    await storeBytes(task, asset.name, blob, mime, signal)
  }
  if (!await readStore('files', `${task.id}/index.m3u8`)) await storeBytes(task, 'index.m3u8', new Blob([plan.playlist]), 'application/vnd.apple.mpegurl', signal)
}
async function isTs(blob: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await blob.slice(0, 376).arrayBuffer())
  return blob.size % 188 === 0 && bytes[0] === 0x47 && bytes[188] === 0x47
}
async function downloadMp4(task: OfflineTask, probe: Response, src: string, signal: AbortSignal): Promise<void> {
  const range = parseContentRange(probe.headers.get('Content-Range'))
  const validator = probe.headers.get('ETag') || probe.headers.get('Last-Modified')
  const ranged = probe.status === 206 && range?.start === 0 && range.end === 0
  // Without validators, restart after pause rather than risk mixed revisions.
  const fingerprint = JSON.stringify([src, range?.total, validator || crypto.randomUUID()])
  await resetForSource(task, fingerprint, signal)
  task.format = 'mp4'; task.entry = 'video.mp4'; task.totalBytes = ranged ? range!.total : Number(probe.headers.get('Content-Length')) || undefined
  task.total = task.totalBytes ? Math.ceil(task.totalBytes / CHUNK_BYTES) : 0
  if (task.totalBytes) await ensureRoom(task, Math.max(0, task.totalBytes - task.bytes))
  await update(task)
  if (ranged) {
    await probe.body?.cancel()
    for (let offset = 0; offset < range!.total; offset += CHUNK_BYTES) {
      const name = `chunk-${offset}`
      assertActive(signal, task)
      if (await readStore('files', `${task.id}/${name}`)) continue
      const end = Math.min(offset + CHUNK_BYTES, range!.total) - 1
      const response = await fetchMedia(src, signal, `bytes=${offset}-${end}`)
      const actual = parseContentRange(response.headers.get('Content-Range'))
      if (response.status !== 206 || actual?.start !== offset || actual.end !== end || actual.total !== range!.total || (validator && (response.headers.get('ETag') || response.headers.get('Last-Modified')) !== validator)) throw new Error('视频文件或字节范围发生变化，请重新缓存')
      const blob = await boundedBlob(response, CHUNK_BYTES, signal)
      if (blob.size !== end - offset + 1) throw new Error('视频分块不完整')
      await storeBytes(task, name, blob, 'video/mp4', signal, offset)
    }
  } else {
    if (probe.status === 206) throw new Error('片源返回了不正确的下载范围')
    // Non-range servers cannot resume byte downloads. Read/write bounded chunks,
    // and restart after interruption instead of buffering a whole video in RAM.
    if (task.bytes) {
      await deleteTask(task.id); task.bytes = 0; task.completed = 0; await update(task)
    }
    const reader = probe.body?.getReader()
    if (!reader) throw new Error('浏览器不支持此视频的流式下载')
    let buffer = new Uint8Array(CHUNK_BYTES)
    let used = 0; let offset = 0
    try {
      while (true) {
        assertActive(signal, task)
        const { done, value } = await reader.read()
        if (done) break
        for (let start = 0; start < value.length;) {
          const count = Math.min(CHUNK_BYTES - used, value.length - start)
          buffer.set(value.subarray(start, start + count), used); used += count; start += count
          if (used === CHUNK_BYTES) {
            await storeBytes(task, `chunk-${offset}`, new Blob([buffer]), 'video/mp4', signal, offset)
            offset += used; used = 0; buffer = new Uint8Array(CHUNK_BYTES)
          }
        }
      }
      if (used) await storeBytes(task, `chunk-${offset}`, new Blob([buffer.slice(0, used)]), 'video/mp4', signal, offset)
    } finally { await reader.cancel().catch(() => {}) }
    if (!task.bytes || (task.totalBytes && task.bytes !== task.totalBytes)) throw new Error('视频下载未完整结束')
    task.totalBytes = task.bytes; task.total = task.completed
  }
  const first = await readStore<import('./types').MediaFile | undefined>('files', `${task.id}/chunk-0`)
  const bytes = first ? new Uint8Array(await first.blob.slice(0, 12).arrayBuffer()) : []
  if (String.fromCharCode(...Array.from(bytes).slice(4, 8)) !== 'ftyp') throw new Error('此片源不是标准 MP4，暂不支持保存为 MP4')
}
async function boundedBlob(response: Response, limit: number, signal: AbortSignal): Promise<Blob> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('无法读取媒体内容')
  const parts: Uint8Array<ArrayBuffer>[] = []; let bytes = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw new Error('此片源单个分片过大，请换源缓存')
      parts.push(new Uint8Array(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
  return new Blob(parts)
}
