import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { parsePluginRule } from '@animaku/shared'
import xifanRule from '../../../web/src/data/default-plugins/xifan-next.json'
import moonciRule from '../../../web/src/data/default-plugins/moonci.json'
import girigiriRule from '../../../web/src/data/default-plugins/girigiri.json'
import omofunRule from '../../../web/src/data/default-plugins/omofun.json'
import { resolveXifanNext } from './xifan-next'
import { chaptersMoonci, resolveMoonci } from './moonci'
import { chaptersGirigiri } from './girigiri'
import { searchOmofun } from './omofun'

function mockWorkerFetch(t: TestContext, fetcher: typeof fetch) {
  const runtime = globalThis as typeof globalThis & { __ANIMAKU_WORKER__?: boolean }
  const previous = runtime.__ANIMAKU_WORKER__
  runtime.__ANIMAKU_WORKER__ = true
  t.after(() => { runtime.__ANIMAKU_WORKER__ = previous })
  t.mock.method(globalThis, 'fetch', fetcher)
}

test('Xifan fallback-only playback honors the selected source and keeps MP4 format', async (t) => {
  const requests: Record<string, unknown>[] = []
  mockWorkerFetch(t, async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ ok: true, url: 'https://cdn.example.org/first.mp4', candidates: [
      { source_code: 'first', url: 'https://cdn.example.org/first.mp4' },
      { source_code: 'chosen', source_name: 'Chosen line', url: 'https://cdn.example.org/chosen.mp4' },
    ] })
  })
  const result = await resolveXifanNext(parsePluginRule(xifanRule), 'https://next.xifanacg.com/play/123?source=chosen')
  assert.equal(result.playUrl, 'https://cdn.example.org/chosen.mp4')
  assert.equal(result.format, 'mp4')
  assert.deepEqual(requests, [{ action: 'fallback', episode_id: 123, source: 'chosen' }])
})

test('Xifan accepts candidate-only HLS responses and resolves a relative high-resolution rendition', async (t) => {
  mockWorkerFetch(t, async (input) => {
    if (String(input).includes('/issue-web-playback')) {
      return Response.json({ ok: true, candidates: [{ source_code: 'hls', url: 'https://cdn.example.org/master.m3u8' }] })
    }
    return new Response('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n720/index.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\n1080/index.m3u8\n')
  })
  const result = await resolveXifanNext(parsePluginRule(xifanRule), '123')
  assert.equal(result.playUrl, 'https://cdn.example.org/1080/index.m3u8')
  assert.equal(result.format, 'hls')
})

test('Moonci prioritizes the later road while preserving its episode URLs', async (t) => {
  const html = '<ul class="hl-plays-list"><li><a href="/anime/41/play/1-1.html">第1集</a></li></ul>' +
    '<ul class="hl-plays-list"><li><a href="/anime/41/play/2-1.html">第1集</a></li></ul>'
  mockWorkerFetch(t, async () => new Response(html))
  const result = await chaptersMoonci(parsePluginRule(moonciRule), 'https://moonci.com/anime/41.html')
  assert.equal(result.roads.length, 2)
  assert.ok(result.roads[0].data[0].endsWith('/2-1.html'))
  assert.ok(result.roads[1].data[0].endsWith('/1-1.html'))
})

test('Moonci parses player data containing nested metadata without truncating JSON', async (t) => {
  const player = { url: 'https://cdn.example.org/episode.mp4', encrypt: 0, vod_data: { nested: { title: '测试番' } } }
  mockWorkerFetch(t, async () => new Response(`<script>var player_aaaa=${JSON.stringify(player)}</script>`))
  const result = await resolveMoonci(parsePluginRule(moonciRule), 'https://moonci.com/anime/41/play/1-1.html')
  assert.equal(result.playUrl, player.url)
})

test('Girigiri nested desktop/mobile containers produce one road and label resolution-only episodes', async (t) => {
  mockWorkerFetch(t, async () => new Response('<div class="anthology-list-box"><div class="anthology-list-play"><a href="/playGV123-1-2.html">1080P</a></div></div>'))
  const result = await chaptersGirigiri(parsePluginRule(girigiriRule), 'https://ani.girigirilove.com/animeGV123.html')
  assert.equal(result.roads.length, 1)
  assert.equal(result.roads[0].data.length, 1)
  assert.equal(result.roads[0].identifier[0], '第02集 (1080P)')
})

test('Omofun ranks the exact show ahead of its OAD and sequel even if returned last', async (t) => {
  const names = ['测试番 OAD', '测试番 第二季', '测试番']
  const html = names.map((name, i) => `<a href="/anime/${String(i + 1).repeat(16)}.html" title="${name}">${name}</a>`).join('')
  mockWorkerFetch(t, async () => new Response(html))
  const result = await searchOmofun(parsePluginRule(omofunRule), '测试番')
  assert.equal(result.items.length, 3)
  assert.equal(result.items[0].name, '测试番')
})
