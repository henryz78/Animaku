import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const hookCode = ts.transpileModule(
  readFileSync(new URL('./usePlaybackStats.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText

function fixture() {
  const video = { currentTime: 0, duration: 1500, paused: false }
  const videoRef: { current: typeof video | null } = { current: video }
  const windowMock = new EventTarget()
  const documentMock = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const saves: { episode: number; position: number; duration: number }[] = []
  const views: unknown[] = []
  const watched: unknown[] = []
  let flushes = 0
  let now = 0
  let episode = 1
  let src = 'episode-1.m3u8'
  let saveVersion = ''
  const refs: { current: any }[] = []
  const states: unknown[] = []
  const effects: { deps: unknown[]; cleanup?: () => void }[] = []
  let refIndex = 0, stateIndex = 0, effectIndex = 0
  let pending: { index: number; deps: unknown[]; run: () => (() => void) | undefined }[] = []
  windowMock.addEventListener('progress-flush', () => { flushes++ })
  const module = { exports: {} as any }
  runInNewContext(hookCode, {
    module, exports: module.exports,
    require(name: string) {
      if (name === 'react') return {
        useRef(initial: unknown) { const i = refIndex++; return refs[i] ||= { current: initial } },
        useState(initial: unknown) {
          const i = stateIndex++
          if (!(i in states)) states[i] = initial
          return [states[i], (value: unknown) => { states[i] = value }]
        },
        useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
          const i = effectIndex++
          const prev = effects[i]
          if (prev && deps.length === prev.deps.length && deps.every((value, j) => Object.is(value, prev.deps[j]))) return
          pending.push({ index: i, deps, run })
        },
      }
      if (name === '@animaku/shared') return { STATS_VALID_PLAY_THRESHOLD_SEC: 15 }
      if (name === '../../lib/api') return { statsApi: { recordPlayView: (...args: unknown[]) => { views.push(args); return Promise.resolve() } } }
      if (name === '../../stores/watched') return { useWatchedStore: { getState: () => ({ markWatched: (...args: unknown[]) => watched.push(args) }) } }
      if (name === '../../lib/watch-history') return { WATCH_PROGRESS_FLUSH_EVENT: 'progress-flush' }
      throw new Error(`Unexpected dependency: ${name}`)
    },
    window: Object.assign(windowMock, { setInterval: () => 1, clearInterval() {} }),
    document: documentMock, Date: { now: () => now }, performance: { now: () => now }, Event,
  })
  let result: any
  const render = () => {
    refIndex = stateIndex = effectIndex = 0
    const savedEpisode = episode
    const version = saveVersion
    result = module.exports.usePlaybackStats({
      videoRef, hlsRef: { current: null }, activeSrc: src,
      bangumiId: 1948, episodeNumber: episode, episodeIndex: episode - 1,
      onProgress: (position: number, duration: number) => {
        saves.push({ episode: savedEpisode, position, duration, ...version && { version } })
      },
    })
    const changed = pending
    pending = []
    // React runs previous cleanups before setting up the new episode's effects.
    changed.forEach(({ index }) => effects[index]?.cleanup?.())
    changed.forEach(({ index, deps, run }) => { effects[index] = { deps, cleanup: run() } })
    return result
  }
  render()
  return {
    video, videoRef, saves, views, watched,
    flushes: () => flushes,
    tick(time: number, seeking = false) {
      now += 1000
      video.currentTime = time
      result.handleTimeUpdateStats(time, video.duration, seeking)
    },
    qualify() { for (let i = 1; i <= 16; i++) this.tick(i) },
    pause() { video.paused = true; result.handlePauseStats(video.currentTime, video.duration) },
    end() { result.handleEndedStats() },
    hide() { documentMock.visibilityState = 'hidden'; documentMock.dispatchEvent(new Event('visibilitychange')) },
    pagehide() { windowMock.dispatchEvent(new Event('pagehide')) },
    next() { episode++; src = `episode-${episode}.m3u8`; video.currentTime = 0; render() },
    rerender(version = '') { saveVersion = version; render() },
    unmount() { effects.forEach((effect) => effect.cleanup?.()); effects.length = 0 },
  }
}

test('keeps the 15s valid-play threshold and does not create records on a quick preview', () => {
  const p = fixture()
  p.tick(1)
  p.tick(2)
  p.pause()
  p.hide()
  p.pagehide()
  p.unmount()
  assert.equal(p.saves.length, 0)
  assert.equal(p.views.length, 0)
})

test('periodic progress and pause save the current position without adding play views', () => {
  const p = fixture()
  p.qualify()
  assert.equal(p.saves[0].position, 16)
  for (let i = 17; i <= 26; i++) p.tick(i)
  assert.equal(p.saves.at(-1)!.position, 26)
  p.video.currentTime = 27.25
  p.pause()
  assert.equal(p.saves.at(-1)!.position, 27.25)
  assert.equal(p.views.length, 1)
  assert.equal(p.flushes(), 1)
  p.unmount()
})

test('tab hide captures time since the last tick and teardown keeps that latest snapshot', () => {
  const p = fixture()
  p.qualify()
  p.video.currentTime = 18.75
  p.hide()
  assert.equal(p.saves.at(-1)!.position, 18.75)
  p.video.currentTime = 0
  p.videoRef.current = null
  p.unmount()
  assert.equal(p.saves.at(-1)!.position, 18.75)
  assert.equal(p.views.length, 1)
})

test('pagehide saves the current position and requests a cloud sync', () => {
  const p = fixture()
  p.qualify()
  p.video.currentTime = 19.5
  p.pagehide()
  assert.equal(p.saves.at(-1)!.position, 19.5)
  assert.equal(p.flushes(), 1)
  p.unmount()
})

test('changing episodes saves the old snapshot with the old callback after media reset', () => {
  const p = fixture()
  p.qualify()
  p.tick(17.5)
  p.next()
  assert.deepEqual(p.saves.at(-1), { episode: 1, position: 17.5, duration: 1500 })
  p.tick(1)
  p.pause()
  assert.equal(p.saves.some((save) => save.episode === 2), false)
  p.video.paused = false
  for (let i = 2; i <= 17; i++) p.tick(i)
  assert.equal(p.saves.at(-1)!.episode, 2)
  p.unmount()
})

test('same-episode callback updates are reflected in the snapshot without resetting playback', () => {
  const p = fixture()
  p.qualify()
  p.rerender('new-metadata')
  p.tick(17)
  p.unmount()
  assert.equal((p.saves.at(-1) as any).version, 'new-metadata')
  assert.equal(p.views.length, 1)
})

test('ending saves the final position before an automatic episode change', () => {
  const p = fixture()
  p.qualify()
  p.video.currentTime = p.video.duration
  p.end()
  p.next()
  assert.deepEqual(p.saves.at(-1), { episode: 1, position: 1500, duration: 1500 })
  assert.equal(p.views.length, 1)
  p.unmount()
})

test('seek-only activity cannot bypass the valid-play threshold', () => {
  const p = fixture()
  for (let i = 1; i <= 20; i++) p.tick(i * 10, true)
  p.pagehide()
  p.unmount()
  assert.equal(p.views.length, 0)
  assert.equal(p.saves.length, 0)
})
