import test from 'node:test'
import assert from 'node:assert/strict'
import { parseContentRange, planHls, variantUrl } from './hls'
import { taskIdentity } from './types'

const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n#EXT-X-ENDLIST'
test('HLS resolves relative segment URLs and rewrites all playback to local files', () => {
  const result = planHls(playlist, 'https://cdn.example/season/index.m3u8?token=abc')
  assert.deepEqual(result.assets.map((asset) => asset.url), ['https://cdn.example/season/a.ts', 'https://cdn.example/season/b.ts'])
  assert.match(result.playlist, /part-0.ts\n/)
  assert.equal(result.playlist.includes('https:'), false)
})
test('AES key rotation, init maps and discontinuities remain in the offline playlist', () => {
  const result = planHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="first.key",IV=0x123\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="20@10"\n#EXTINF:5,\na.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=AES-128,URI="second.key"\n#EXTINF:5,\nb.m4s\n#EXT-X-ENDLIST', 'https://cdn.example/index.m3u8')
  assert.equal(result.encrypted, true); assert.equal(result.fragmented, true)
  assert.match(result.playlist, /IV=0x123/); assert.match(result.playlist, /#EXT-X-DISCONTINUITY/)
  assert.deepEqual(result.assets[1].range, { start: 10, length: 20 })
  assert.equal(result.playlist.includes('BYTERANGE='), false)
})
test('implicit byte ranges are materialized and local files no longer request original ranges', () => {
  const result = planHls('#EXTM3U\n#EXT-X-BYTERANGE:20@10\n#EXTINF:5,\nvideo.ts\n#EXT-X-BYTERANGE:30\n#EXTINF:5,\nvideo.ts\n#EXT-X-ENDLIST', 'https://cdn.example/index.m3u8')
  assert.deepEqual(result.assets.map((asset) => asset.range), [{ start: 10, length: 20 }, { start: 30, length: 30 }])
  assert.equal(result.playlist.includes('#EXT-X-BYTERANGE'), false)
})
test('rejects live, DRM, missing range starts and external audio rather than producing broken files', () => {
  assert.throws(() => planHls(playlist.replace('#EXT-X-ENDLIST', ''), 'https://cdn.example/'), /直播/)
  assert.throws(() => planHls(playlist.replace('#EXTINF:5,', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:5,'), 'https://cdn.example/'), /DRM/)
  assert.throws(() => planHls(playlist.replace('a.ts', '#EXT-X-BYTERANGE:20\na.ts'), 'https://cdn.example/'), /起点/)
  assert.throws(() => variantUrl('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"', 'https://cdn.example/'), /音画分轨/)
  assert.throws(() => variantUrl('#EXTM3U\n#EXT-X-MEDIA:URI="audio.m3u8",TYPE=AUDIO', 'https://cdn.example/'), /音画分轨/)
})
test('master playlists select a declared rendition and Content-Range validation rejects corruption', () => {
  assert.equal(variantUrl('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000\nhigh.m3u8', 'https://cdn.example/main.m3u8'), 'https://cdn.example/low.m3u8')
  assert.deepEqual(parseContentRange('bytes 0-99/100'), { start: 0, end: 99, total: 100 })
  for (const value of [null, 'bytes 100-99/100', 'bytes 0-100/100', 'bytes 0-1/*', 'bytes -1-2/10']) assert.equal(parseContentRange(value), null)
})
test('duplicate identities include account, canonical episode and actual source/road', () => {
  const input = { bangumiId: 547888, episode: 67, plugin: { name: 'source' }, road: 0, pageUrl: 'https://source/ep-1' } as any
  assert.notEqual(taskIdentity(input, 'user1'), taskIdentity(input, 'user2'))
  assert.notEqual(taskIdentity(input, 'user1'), taskIdentity({ ...input, road: 1 }, 'user1'))
  assert.notEqual(taskIdentity(input, 'user1'), taskIdentity({ ...input, episode: 68 }, 'user1'))
})
