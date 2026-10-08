/* Media and account snapshots live on this device. Never cache API responses. */
const DB_NAME = 'animaku-offline-v1'
const SHELL_PREFIX = 'animaku-offline-shell-'
let preparing
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'PREPARE_OFFLINE') return
  preparing ||= prepareShell().finally(() => { preparing = undefined })
  event.waitUntil(preparing.then(() => event.ports[0]?.postMessage({ ok: true }), (error) => event.ports[0]?.postMessage({ ok: false, error: error.message })))
})
async function prepareShell() {
  const response = await fetch('/offline-assets.json', { cache: 'no-store' })
  if (!response.ok) throw new Error('离线页面清单不可用，请使用正式构建版本')
  const { version, assets } = await response.json()
  if (!Array.isArray(assets) || assets.some((path) => typeof path !== 'string' || !path.startsWith('/assets/'))) throw new Error('无效的离线页面清单')
  const cacheName = SHELL_PREFIX + version
  const cache = await caches.open(cacheName)
  // A failed warm-up cannot replace the last complete offline shell.
  for (const path of assets) {
    if (await cache.match(path)) continue
    const asset = await fetch(path, { cache: 'reload' })
    if (!asset.ok) throw new Error('离线播放器文件下载失败')
    await cache.put(path, asset)
  }
  const html = await fetch('/', { cache: 'no-store' })
  if (!html.ok || !html.headers.get('Content-Type')?.includes('text/html')) throw new Error('离线页面下载失败')
  await cache.put('/offline', html)
  await cache.put('/__complete', new Response(String(Date.now())))
  // Keep two complete releases so an already open tab can still load its chunks.
  const complete = await shellCaches()
  for (const entry of complete.slice(2)) await caches.delete(entry.name)
}
async function shellCaches() {
  const entries = []
  for (const name of await caches.keys()) {
    if (!name.startsWith(SHELL_PREFIX)) continue
    const cache = await caches.open(name)
    const ready = await cache.match('/__complete')
    if (ready) entries.push({ name, time: Number(await ready.text()), cache })
  }
  return entries.sort((a, b) => b.time - a.time)
}
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !['GET', 'HEAD'].includes(event.request.method)) return
  if (url.pathname.startsWith('/_offline/media/')) {
    event.respondWith(offlineMedia(event.request, url).catch(() => new Response('缓存不可用，请重新打开缓存中心', { status: 503 })))
  } else if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => {
      for (const entry of await shellCaches()) {
        const html = await entry.cache.match('/offline')
        if (html) return html
      }
      return new Response('请先联网登录，并完成至少一次缓存。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }))
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      for (const entry of await shellCaches()) {
        const asset = await entry.cache.match(event.request)
        if (asset) return asset
      }
      return fetch(event.request)
    })().catch(() => new Response('离线文件缺失', { status: 503 })))
  }
})
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    // Only the authenticated app initializes the schema.
    request.onupgradeneeded = () => request.transaction.abort()
  })
}
function get(db, store, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
function filesFor(db, id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction('fileMeta').objectStore('fileMeta').index('taskId').getAll(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function offlineMedia(request, url) {
  const [id, name] = url.pathname.slice('/_offline/media/'.length).split('/').map(decodeURIComponent)
  const db = await database()
  let streaming = false
  try {
    const [task, owner] = await Promise.all([get(db, 'tasks', id), get(db, 'meta', 'owner')])
    if (!owner || task?.owner !== owner || task.status !== 'ready') return new Response('此账号没有已完成的缓存', { status: 403 })
    const exporting = /^export\.(mp4|ts|zip)$/.test(name)
    const attachment = exporting ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${task.title}-第${task.episode}集.${name.split('.').pop()}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'))}` } : {}
    if (task.format === 'mp4' && (name === 'video.mp4' || name === 'export.mp4')) {
      const files = (await filesFor(db, id)).filter((file) => file.offset !== undefined).sort((a, b) => a.offset - b.offset)
      let expected = 0
      for (const file of files) {
        if (file.offset !== expected) return new Response('缓存不完整', { status: 503 })
        expected += file.size
      }
      if (expected !== task.totalBytes) return new Response('缓存不完整', { status: 503 })
      const range = requestedRange(task.totalBytes, request.headers.get('Range'))
      const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...attachment }
      if (!range) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${task.totalBytes}` } })
      headers['Content-Length'] = String(range.end - range.start + 1)
      if (request.headers.has('Range')) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${task.totalBytes}`
      const chunks = async function* () {
        for (const file of files) {
          if (file.offset + file.size <= range.start || file.offset > range.end) continue
          if (await get(db, 'meta', 'owner') !== owner) throw new Error('账号已退出')
          const row = await get(db, 'files', file.key)
          if (!row) throw new Error('缓存分块缺失')
          const blob = new Blob([row.blob])
          yield new Uint8Array(await blob.slice(Math.max(0, range.start - file.offset), Math.min(file.size, range.end - file.offset + 1)).arrayBuffer())
        }
      }
      // A tiny range probe needs only a bounded concrete body; avoid keeping
      // the IndexedDB connection open for a two-byte streaming response.
      if (request.method !== 'HEAD' && range.end - range.start + 1 <= 4 * 1024 * 1024) {
        const parts = []
        for await (const part of chunks()) parts.push(part)
        return new Response(new Blob(parts, { type: 'video/mp4' }), { status: request.headers.has('Range') ? 206 : 200, headers })
      }
      streaming = request.method !== 'HEAD'
      return new Response(streaming ? streamFiles(chunks(), db, id, url.searchParams.get('exportId')) : null, { status: request.headers.has('Range') ? 206 : 200, headers })
    }
    if (exporting && task.format === 'hls') {
      let files = await filesFor(db, id)
      const read = async (file) => {
        if (await get(db, 'meta', 'owner') !== owner) throw new Error('账号已退出')
        const value = await get(db, 'files', file.key)
        if (!value) throw new Error('缓存分片缺失')
        return new Blob([value.blob], { type: file.mime })
      }
      if (name === 'export.ts') {
        const manifest = files.find((file) => file.name === 'index.m3u8')
        const text = manifest ? await (await read(manifest)).text() : ''
        if (!text || /#EXT-X-(?:KEY|MAP|DISCONTINUITY)/.test(text)) return exportError('此片源不能直接合并成 TS，请导出分片包 ZIP')
        const byName = new Map(files.map((file) => [file.name, file]))
        files = text.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => byName.get(line))
        for (const file of files) {
          if (!file || file.size % 188) return exportError('此片源不是标准 TS，请导出分片包 ZIP')
          const bytes = new Uint8Array(await (await read(file)).slice(0, 376).arrayBuffer())
          if (bytes[0] !== 0x47 || bytes[188] !== 0x47) return exportError('此片源不是标准 TS，请导出分片包 ZIP')
        }
      } else if (name !== 'export.zip') return exportError('此视频不是 MP4')
      const size = files.reduce((sum, file) => sum + file.size, 0)
      if (name === 'export.zip' && (files.length >= 65535 || size + files.length * 256 >= 0xffffffff)) return exportError('分片包过大，暂不支持 ZIP64')
      const chunks = name === 'export.zip' ? zipChunks(files, read) : (async function* () { for (const file of files) yield new Uint8Array(await (await read(file)).arrayBuffer()) })()
      streaming = request.method !== 'HEAD'
      return new Response(streaming ? streamFiles(chunks, db, id, url.searchParams.get('exportId')) : null, { headers: { ...attachment, 'Content-Type': name === 'export.zip' ? 'application/zip' : 'video/mp2t', 'Cache-Control': 'no-store' } })
    }
    const file = await get(db, 'files', `${id}/${name}`)
    if (!file) return new Response('分片不存在', { status: 404 })
    return rangedResponse(new Blob([file.blob], { type: file.mime }), request)
  } finally { if (!streaming) db.close() }
}
function exportError(message) { return new Response(null, { status: 415, headers: { 'X-Export-Error': encodeURIComponent(message) } }) }
function streamFiles(iterator, db, taskId, exportId) {
  // An anchor download outlives the exporting component's click handler. Keep
  // its bytes protected until the browser consumes or cancels the response.
  let stopped = false; let release
  if (self.navigator.locks) void self.navigator.locks.request(`animaku-offline-use:${taskId}`, { mode: 'shared' }, () => stopped ? undefined : new Promise((resolve) => { release = resolve }))
  const finish = (error) => {
    if (stopped) return
    stopped = true; release?.(); db.close()
    if (exportId) void self.clients.matchAll({ type: 'window', includeUncontrolled: false }).then((clients) => {
      for (const client of clients) client.postMessage({ type: 'OFFLINE_EXPORT_DONE', exportId, error: error ? String(error.message || error) : undefined })
    })
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await iterator.next()
        if (result.done) { controller.close(); finish() }
        else controller.enqueue(result.value)
      } catch (error) { controller.error(error); finish(error) }
    },
    async cancel() { finish(new Error('导出已取消')); await iterator.return?.() },
  })
}
function requestedRange(size, header) {
  if (!header) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return null
  const suffix = !match[1]
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1])
  const end = suffix || !match[2] ? size - 1 : Math.min(Number(match[2]), size - 1)
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size ? { start, end } : null
}
function rangedResponse(blob, request) {
  const headers = { 'Content-Type': blob.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  const range = request.headers.get('Range')
  if (!range) return new Response(blob, { headers: { ...headers, 'Content-Length': String(blob.size) } })
  const parsed = requestedRange(blob.size, range)
  const fail = () => new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${blob.size}` } })
  if (!parsed) return fail()
  const { start, end } = parsed
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${blob.size}` } })
}
/** Uncompressed standard ZIP. Only one bounded media part is held in memory. */
async function* zipChunks(files, read) {
  const directory = []; let offset = 0; let directoryBytes = 0
  const encoder = new TextEncoder()
  const crcTable = new Uint32Array(256)
  for (let i = 0; i < 256; i++) { let value = i; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); crcTable[i] = value }
  for (const file of files) {
    const data = new Uint8Array(await (await read(file)).arrayBuffer())
    let crc = 0xffffffff
    for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
    crc = (crc ^ 0xffffffff) >>> 0
    const name = encoder.encode(file.name)
    const local = new Uint8Array(30 + name.length); const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true)
    view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, name.length, true); local.set(name, 30)
    const central = new Uint8Array(46 + name.length); const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true)
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46)
    directory.push(central); directoryBytes += central.length; offset += local.length + data.length
    yield local; yield data
  }
  for (const entry of directory) yield entry
  const end = new Uint8Array(22); const view = new DataView(end.buffer)
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true); view.setUint32(12, directoryBytes, true); view.setUint32(16, offset, true)
  yield end
}
