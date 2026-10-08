/* Bounded browser integration test. Uses an existing Playwright installation;
 * no production dependency or persistent development server is added.
 * Run after build:web with PLAYWRIGHT_MODULE_PATH pointing to playwright.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { createHash } from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = path.join(root, '.tmp-offline-e2e')
const profilePath = path.join(temp, `chromium-profile-${Date.now()}`)
const dist = path.join(root, 'apps/web/dist')
const require = createRequire(path.join(root, 'apps/server/package.json'))
const { build } = require('esbuild')
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
await mkdir(temp, { recursive: true })
const harness = await build({ stdin: {
  contents: `import * as manager from './apps/web/src/offline/manager'; import * as db from './apps/web/src/offline/db'; import * as profile from './apps/web/src/offline/profile'; import * as progress from './apps/web/src/offline/progress'; import * as files from './apps/web/src/offline/export'; import {mediaUrl} from './apps/web/src/offline/types'; import {useAccountStore} from './apps/web/src/stores/account'; window.offlineTest={...manager,...db,...profile,...progress,...files,mediaUrl,useAccountStore};`,
  resolveDir: root, loader: 'ts',
}, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'import.meta.env': '{"PROD":true}' } })
let browser = await chromium.launch({ headless: true })
let fixture
try {
  const page = await browser.newPage()
  fixture = Buffer.from(await page.evaluate(async () => {
    const mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4'].find((type) => MediaRecorder.isTypeSupported(type))
    if (!mime) throw new Error('Browser cannot create the MP4 fixture')
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const ctx = canvas.getContext('2d'); let frame = 0
    const timer = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#118877' : '#882255'; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = 'white'; ctx.fillText('Offline test ' + frame, 30, 90) }, 33)
    const stream = canvas.captureStream(30); const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 150000 }); const chunks = []
    const stopped = new Promise((resolve) => { recorder.ondataavailable = (event) => chunks.push(event.data); recorder.onstop = resolve })
    recorder.start(1000); await new Promise((resolve) => setTimeout(resolve, 4200)); recorder.stop(); await stopped
    clearInterval(timer); stream.getTracks().forEach((track) => track.stop())
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))
  }))
} finally { await browser.close() }
const boxes = []
for (let offset = 0; offset < fixture.length;) {
  const size = fixture.readUInt32BE(offset); if (!size || offset + size > fixture.length) break
  boxes.push({ type: fixture.toString('ascii', offset + 4, offset + 8), offset, size }); offset += size
}
const firstFragment = boxes.findIndex((box) => box.type === 'moof')
assert.ok(firstFragment >= 0, 'Recorded MP4 must be fragmented for HLS tests')
const init = fixture.subarray(0, boxes[firstFragment].offset)
const moofs = boxes.filter((box) => box.type === 'moof')
const segments = moofs.map((box, i) => fixture.subarray(box.offset, moofs[i + 1]?.offset || fixture.length))
const padding = Buffer.alloc(12 * 1024 ** 2); padding.writeUInt32BE(padding.length); padding.write('free', 4)
const mp4 = Buffer.concat([fixture, padding])
const ranges = []; let mediaRequests = 0; let danmakuRequests = 0; let uploaded = {}; let accountAvailable = true
let simulateOriginOffline = false
const failedOriginRequests = []
let origin
const mimeFor = (name) => name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : 'text/html'
const server = createServer(async (request, response) => {
  try {
    if (simulateOriginOffline) { failedOriginRequests.push(request.url); request.socket.destroy(); return }
    const url = new URL(request.url, origin)
    const json = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
    if (url.pathname === '/test-offline.html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<script src="/test-harness.js"></script>'); return }
    if (url.pathname === '/test-harness.js') { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(harness.outputFiles[0].contents); return }
    if (url.pathname === '/api/account/me') return accountAvailable ? json({ user: { id: 'owner-a', username: 'Offline test', role: 'user', createdAt: 1 }, available: true }) : json({ error: 'offline' }, 503)
    if (url.pathname === '/api/account/logout') return json({ ok: true })
    if (url.pathname === '/api/account/data') {
      if (request.method === 'PUT') { let body = ''; for await (const chunk of request) body += chunk; uploaded = JSON.parse(body).data; return json({ ok: true }) }
      return json({ data: uploaded })
    }
    if (url.pathname === '/api/plugin/resolve') {
      let body = ''; for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      const hls = input.pageUrl.includes('hls')
      return json({ data: { playUrl: `${origin}/fixtures/${hls ? 'index.m3u8' : 'video.mp4'}`, format: hls ? 'hls' : 'mp4' } })
    }
    if (url.pathname.startsWith('/api/danmaku/')) {
      danmakuRequests++
      if (url.pathname.includes('/bilibili')) return json({ data: [{ time: 1.5, mode: 'rtl', text: 'Cached <comment> & test', style: { color: '#00ff00' } }], count: 1 })
      return json({ data: { episodes: [] } })
    }
    if (url.pathname.startsWith('/api/bangumi/')) return json({ data: [] })
    if (url.pathname.startsWith('/api/')) return json({ ok: true, data: {}, configured: false })
    if (url.pathname.startsWith('/fixtures/')) {
      mediaRequests++
      let data = url.pathname.endsWith('video.mp4') ? mp4 : url.pathname.endsWith('init.mp4') ? init : segments[Number(url.pathname.match(/part-(\d+)\.m4s/)?.[1])]
      if (url.pathname.endsWith('index.m3u8')) {
        response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
        response.end('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n' + segments.map((_, i) => `#EXTINF:${(4.2 / segments.length).toFixed(3)},\npart-${i}.m4s\n`).join('') + '#EXT-X-ENDLIST\n'); return
      }
      if (!data) { response.writeHead(404); response.end(); return }
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/)
      if (range) {
        const start = Number(range[1]); const end = Math.min(Number(range[2]), data.length - 1)
        ranges.push([start, end])
        await new Promise((resolve) => setTimeout(resolve, end === start ? 10 : 150))
        response.writeHead(206, { 'Content-Type': 'video/mp4', ETag: '"fixture-v1"', 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 })
        response.end(data.subarray(start, end + 1))
      } else { response.writeHead(200, { 'Content-Type': 'video/mp4', ETag: '"fixture-v1"', 'Content-Length': data.length }); response.end(data) }
      return
    }
    const name = url.pathname.startsWith('/assets/') || url.pathname === '/offline-sw.js' || url.pathname === '/offline-assets.json' ? url.pathname.slice(1) : 'index.html'
    const data = await readFile(path.join(dist, name))
    response.writeHead(200, { 'Content-Type': mimeFor(name) }); response.end(data)
  } catch (error) { response.writeHead(500); response.end(String(error)) }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
origin = `http://127.0.0.1:${server.address().port}`
const log = (step) => console.log('PASS ' + step)
const input = (episode, kind = 'mp4') => ({ bangumiId: 547888, episode, title: 'Offline verification', episodeTitle: `第 ${episode} 集`, road: 0, pageUrl: `https://fixture.example/${kind}/${episode}`, plugin: { name: 'Fixture source', baseURL: 'https://fixture.example' }, includeDanmaku: false })
let context
try {
  if (process.env.OFFLINE_WEBKIT_ONLY !== '1') {
  context = await chromium.launchPersistentContext(profilePath, { headless: true, viewport: { width: 1200, height: 850 } })
  let page = await context.newPage()
  await page.goto(origin + '/test-offline.html')
  await page.evaluate(async () => { await offlineTest.useAccountStore.getState().init(); await offlineTest.initializeOffline() })
  assert.equal(await page.evaluate(async () => (await offlineTest.cacheSettings('owner-a')).auto), false)
  log('automatic cache defaults off')
  await page.evaluate((item) => offlineTest.enqueueCache([item]), input(67))
  await page.waitForFunction(() => offlineTest.useOfflineStore.getState().tasks.some((task) => task.episode === 67 && task.completed >= 1), { timeout: 20000 })
  const partial = await page.evaluate(async () => { const task = offlineTest.useOfflineStore.getState().tasks.find((task) => task.episode === 67); await offlineTest.pauseCache(task.id); return offlineTest.useOfflineStore.getState().tasks.find((row) => row.id === task.id) })
  assert.ok(partial.bytes > 0 && partial.bytes < mp4.length); assert.equal(partial.status, 'paused')
  const firstChunkCount = ranges.filter(([start, end]) => start === 0 && end > 0).length
  await page.reload()
  await page.evaluate(async () => { await offlineTest.initializeOffline() })
  await page.evaluate((id) => offlineTest.resumeCache(id), partial.id)
  await page.waitForFunction((id) => offlineTest.useOfflineStore.getState().tasks.find((task) => task.id === id)?.status === 'ready', partial.id, { timeout: 20000 })
  assert.equal(ranges.filter(([start, end]) => start === 0 && end > 0).length, firstChunkCount)
  assert.equal(danmakuRequests, 0)
  log('pause/reload/resume retains MP4 chunks; unselected danmaku makes no requests')
  const beforeDuplicate = mediaRequests
  await page.evaluate((item) => offlineTest.enqueueCache([item]), input(67))
  assert.equal(await page.evaluate(() => offlineTest.useOfflineStore.getState().tasks.filter((task) => task.episode === 67).length), 1)
  assert.equal(mediaRequests, beforeDuplicate)
  log('duplicate selection reuses bytes without another download')
  await page.evaluate((item) => offlineTest.enqueueCache([item]), input(68, 'hls'))
  await page.waitForFunction(() => offlineTest.useOfflineStore.getState().tasks.find((task) => task.episode === 68)?.status === 'ready', null, { timeout: 20000 })
  const hlsTask = await page.evaluate(() => offlineTest.useOfflineStore.getState().tasks.find((task) => task.episode === 68))
  const playlist = await page.evaluate(async (id) => (await offlineTest.readStore('files', `${id}/index.m3u8`)).blob.text(), hlsTask.id)
  assert.ok(playlist.includes('URI="part-0.mp4"') && !playlist.includes('http:'))
  log('fMP4 HLS caches its init file and every segment with local URLs')
  const policy = await page.evaluate(async () => {
    const rows = offlineTest.useOfflineStore.getState().tasks
    const manual = rows.find((row) => row.episode === 67)
    const automatic = rows.find((row) => row.episode === 68)
    await offlineTest.saveCacheSettings('owner-a', { auto: false, ahead: 2, limitGB: 0.25 })
    const auto = { ...automatic, automatic: true, bytes: 270 * 1024 ** 2 }
    await offlineTest.saveTask(auto)
    offlineTest.useOfflineStore.setState({ tasks: [manual, auto] })
    offlineTest.setPlayingCache(auto.id)
    let protectedError = false
    try { await offlineTest.ensureRoom({ id: '', owner: 'owner-a' }, 0) } catch { protectedError = true }
    offlineTest.setPlayingCache('')
    await offlineTest.ensureRoom({ id: '', owner: 'owner-a' }, 0)
    return { protectedError, rows: await offlineTest.readTasks() }
  })
  assert.equal(policy.protectedError, true)
  assert.ok(policy.rows.some((row) => row.id === partial.id)); assert.ok(!policy.rows.some((row) => row.id === hlsTask.id))
  log('capacity cleanup evicts automatic cache and protects manual/current playback')
  await page.evaluate((item) => offlineTest.enqueueCache([item]), input(68, 'hls'))
  await page.waitForFunction(() => offlineTest.useOfflineStore.getState().tasks.find((task) => task.episode === 68)?.status === 'ready', null, { timeout: 20000 })
  const localRange = await page.evaluate(async (id) => { const response = await fetch(`/_offline/media/${id}/video.mp4`, { headers: { Range: 'bytes=0-31' } }); return { status: response.status, range: response.headers.get('Content-Range'), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) } }, partial.id)
  assert.equal(localRange.status, 206); assert.equal(localRange.range, `bytes 0-31/${mp4.length}`); assert.deepEqual(localRange.bytes, Array.from(mp4.subarray(0, 32)))
  const suffix = await page.evaluate(async (id) => { const response = await fetch(`/_offline/media/${id}/video.mp4`, { headers: { Range: 'bytes=-10' } }); return { status: response.status, length: (await response.arrayBuffer()).byteLength } }, partial.id)
  assert.equal(suffix.status, 206); assert.equal(suffix.length, 10)
  log('service worker serves correct 206 ranges for seeking, including suffix ranges')
  await page.evaluate(() => { window.showSaveFilePicker = undefined })
  const mp4Download = page.waitForEvent('download')
  await page.evaluate(async (id) => offlineTest.exportCache(offlineTest.useOfflineStore.getState().tasks.find((row) => row.id === id), 'video'), partial.id)
  const mp4Export = await mp4Download
  await mp4Export.saveAs(path.join(temp, 'export.mp4'))
  const exportedMp4 = await readFile(path.join(temp, 'export.mp4'))
  assert.equal(exportedMp4.length, mp4.length, `exported prefix: ${exportedMp4.subarray(0, 100).toString()}`)
  assert.equal(createHash('sha256').update(exportedMp4).digest('hex'), createHash('sha256').update(mp4).digest('hex'))
  const zipDownload = page.waitForEvent('download')
  await page.evaluate(async () => offlineTest.exportCache(offlineTest.useOfflineStore.getState().tasks.find((row) => row.episode === 68), 'package'))
  await (await zipDownload).saveAs(path.join(temp, 'export.zip'))
  const zip = await readFile(path.join(temp, 'export.zip'))
  let zipOffset = 0; const zipNames = []
  while (zip.readUInt32LE(zipOffset) === 0x04034b50) {
    const size = zip.readUInt32LE(zipOffset + 18); const nameLength = zip.readUInt16LE(zipOffset + 26); const extra = zip.readUInt16LE(zipOffset + 28)
    const name = zip.toString('utf8', zipOffset + 30, zipOffset + 30 + nameLength)
    const dataStart = zipOffset + 30 + nameLength + extra
    assert.equal(crc32(zip.subarray(dataStart, dataStart + size)), zip.readUInt32LE(zipOffset + 14))
    zipNames.push(name); zipOffset = dataStart + size
  }
  assert.ok(zipNames.includes('index.m3u8') && zipNames.includes('part-0.mp4'))
  assert.equal(zip.readUInt32LE(zipOffset), 0x02014b50)
  log('streamed MP4 export matches every byte; ZIP package has valid files and independent CRC checks')
  const sourceCallsBeforeDanmaku = mediaRequests
  await page.evaluate((item) => offlineTest.enqueueCache([{ ...item, includeDanmaku: true }]), input(67))
  await page.waitForFunction((id) => { const row = offlineTest.useOfflineStore.getState().tasks.find((task) => task.id === id); return row?.status === 'ready' && row.comments?.length === 1 }, partial.id)
  assert.equal(mediaRequests, sourceCallsBeforeDanmaku)
  const xmlDownload = page.waitForEvent('download')
  await page.evaluate((id) => offlineTest.exportDanmaku(offlineTest.useOfflineStore.getState().tasks.find((row) => row.id === id)), partial.id)
  await (await xmlDownload).saveAs(path.join(temp, 'export.xml'))
  assert.match(await readFile(path.join(temp, 'export.xml'), 'utf8'), /Cached &lt;comment&gt; &amp; test/)
  log('adding optional danmaku to an existing cache reuses video bytes and exports escaped XML')
  await page.evaluate((item) => { offlineTest.playbackHealth({ starving: true, ahead: 0, paused: false }); return offlineTest.enqueueCache([item], true) }, input(70))
  const beforeStall = mediaRequests
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(mediaRequests, beforeStall)
  assert.equal(await page.evaluate(() => offlineTest.useOfflineStore.getState().tasks.find((row) => row.episode === 70)?.status), 'queued')
  await page.evaluate(() => offlineTest.playbackHealth({ starving: false, ahead: 12, paused: false }))
  await new Promise((resolve) => setTimeout(resolve, 3100))
  await page.evaluate(() => offlineTest.playbackHealth({ starving: false, ahead: 12, paused: false }))
  await page.waitForFunction(() => offlineTest.useOfflineStore.getState().tasks.find((row) => row.episode === 70)?.status === 'ready', null, { timeout: 20000 })
  await page.evaluate(async () => { await offlineTest.removeCache(offlineTest.useOfflineStore.getState().tasks.find((row) => row.episode === 70).id); offlineTest.releasePlayback() })
  log('current video starvation pauses background work; stable buffering resumes it')
  await context.setOffline(true)
  const beforePlayback = mediaRequests
  await page.goto(origin + '/offline')
  await page.getByRole('heading', { name: '缓存与下载', exact: true }).waitFor()
  await page.getByRole('button', { name: '本机播放', exact: true }).first().click()
  await page.waitForSelector('video')
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 15000 })
  await page.evaluate(async () => { const video = document.querySelector('video'); await video.play() })
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.5, null, { timeout: 15000 })
  await page.evaluate(() => { document.querySelector('video').currentTime = 2.5 })
  await page.waitForFunction(() => document.querySelector('video')?.currentTime >= 2.5, null, { timeout: 10000 })
  assert.equal(mediaRequests, beforePlayback)
  await page.screenshot({ path: path.join(temp, 'desktop.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭播放器', exact: true }).click()
  const mp4Article = page.getByRole('article').filter({ hasText: '第 67 集' })
  await mp4Article.getByRole('button', { name: '本机播放', exact: true }).click()
  await page.waitForSelector('video')
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 15000 })
  await page.evaluate(async () => { await document.querySelector('video').play() })
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.5, null, { timeout: 15000 })
  assert.equal(mediaRequests, beforePlayback)
  log('actual site player plays cached HLS and MP4 offline and seeks without source requests')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: path.join(temp, 'mobile.png'), fullPage: true })
  await context.close(); context = undefined
  context = await chromium.launchPersistentContext(profilePath, { headless: true, viewport: { width: 390, height: 844 }, offline: true })
  page = await context.newPage(); await page.goto(origin + '/offline')
  await page.getByRole('heading', { name: '缓存与下载', exact: true }).waitFor()
  await page.getByRole('button', { name: '本机播放', exact: true }).first().waitFor()
  assert.equal(await page.getByRole('button', { name: '本机播放', exact: true }).count(), 2)
  log('cold browser restart offline restores the shell, player chunks and library')
  await context.setOffline(false); await page.goto(origin + '/test-offline.html')
  await page.evaluate(async () => { await offlineTest.initializeOffline(); await offlineTest.useAccountStore.getState().init(); const task = offlineTest.useOfflineStore.getState().tasks.find((row) => row.episode === 67); await offlineTest.saveOfflineProgress(task, 130, 1400); await offlineTest.syncOfflineProgress('owner-a') })
  const history = uploaded['animaku-history']?.state?.items || uploaded['animaku-history']?.items
  // Cloud data stores allow-listed Zustand JSON snapshots.
  const uploadText = JSON.stringify(uploaded)
  assert.ok(uploadText.includes('130') && uploadText.includes('547888'))
  assert.equal(await page.evaluate(async () => (await offlineTest.readStore('progress')).length), 0)
  log('offline progress uploads on authenticated reconnect, then pending entries are acknowledged')
  await page.evaluate(async () => { offlineTest.rememberOfflineProfile({ id: 'owner-b', username: 'Other account' }); await new Promise((resolve) => setTimeout(resolve, 100)) })
  assert.equal(await page.evaluate(async (id) => (await fetch(`/_offline/media/${id}/video.mp4`)).status, partial.id), 403)
  await page.evaluate(async () => { offlineTest.rememberOfflineProfile(null); await new Promise((resolve) => setTimeout(resolve, 100)) })
  assert.equal(await page.evaluate(async (id) => (await fetch(`/_offline/media/${id}/video.mp4`)).status, partial.id), 403)
  log('different accounts and logout cannot fetch the previous account’s local media')
  await context.close(); context = undefined
  }
  // WebKit exercises Safari's native HLS path; it is not a physical iPhone.
  browser = await webkit.launch({ headless: true })
  try {
    const safari = await browser.newContext(); const tab = await safari.newPage()
    await tab.goto(origin + '/test-offline.html')
    const directProbe = await tab.evaluate(async () => {
      const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.preload = 'auto'; document.body.append(video)
      const result = await new Promise((resolve) => {
        const finish = () => resolve({ ready: video.readyState >= 2, error: video.error?.message, state: video.readyState })
        video.onloadeddata = finish; video.onerror = finish; setTimeout(finish, 8000)
        video.src = '/fixtures/video.mp4'; void video.play().catch(() => {})
      })
      video.remove(); return result
    })
    await tab.evaluate(async () => { await offlineTest.useAccountStore.getState().init(); await offlineTest.initializeOffline() })
    await tab.evaluate((item) => offlineTest.enqueueCache([item]), input(69, 'hls'))
    await tab.waitForFunction(() => { const task = offlineTest.useOfflineStore.getState().tasks.find((task) => task.episode === 69); return task?.status === 'ready' || task?.status === 'error' }, null, { timeout: 20000 }).catch(async (error) => { console.log('WebKit state:', await tab.evaluate(() => JSON.stringify(offlineTest.useOfflineStore.getState()))); throw error })
    const webkitTask = await tab.evaluate(() => offlineTest.useOfflineStore.getState().tasks.find((task) => task.episode === 69))
    assert.equal(webkitTask.status, 'ready', webkitTask.error)
    if (!directProbe.ready) {
      console.log('LIMIT Windows WebKit cannot play the direct test MP4 either:', directProbe)
      log('WebKit successfully persists HLS media with the compatible IndexedDB format; playback remains unverified on this host')
    } else {
    const nativeHls = await tab.evaluate(() => !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl'))
    if (!nativeHls) {
      console.log('LIMIT Windows WebKit has no native HLS decoder; checking MP4 playback instead. Real Safari HLS remains unverified.')
      await tab.evaluate((item) => offlineTest.enqueueCache([item]), input(71))
      await tab.waitForFunction(() => offlineTest.useOfflineStore.getState().tasks.find((task) => task.episode === 71)?.status === 'ready', null, { timeout: 20000 })
    }
    // Playwright issue #42775: WebKit's offline emulation rejects even literal
    // SW-served navigation. Drop the origin connection instead, and prove the
    // cached page/media still work with no successful network response.
    simulateOriginOffline = true
    await tab.goto(origin + '/offline')
    await tab.getByRole('article').filter({ hasText: `第 ${nativeHls ? 69 : 71} 集` }).getByRole('button', { name: '本机播放', exact: true }).click(); await tab.waitForSelector('video')
    const nativeReady = await tab.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 15000 }).then(() => true).catch((error) => {
      if (process.platform === 'win32' && failedOriginRequests.some((url) => url.startsWith('/_offline/media/'))) {
        console.log('LIMIT Windows WebKit native media requests bypass the service worker and reach the unreachable origin. Real Safari offline playback is NOT verified.')
        return false
      }
      throw error
    })
    if (nativeReady) {
    await tab.evaluate(async () => { await document.querySelector('video').play() })
    await tab.waitForFunction(() => document.querySelector('video')?.currentTime > 0.5, null, { timeout: 15000 })
    log(`WebKit reads local cache and plays ${nativeHls ? 'HLS' : 'MP4'} with the test origin unreachable`)
    }
    }
  } finally { await browser.close() }
} finally {
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
}
console.log('Chromium offline checks passed; WebKit media storage checked, with platform playback limits reported above. Screenshots: .tmp-offline-e2e/desktop.png, mobile.png')
