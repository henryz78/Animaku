import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import * as mediaFormat from '../media/format.ts'

// Run the production hook with deterministic media events and timers, without
// a browser or a new React testing dependency. This verifies its event wiring.
const hookCode = ts.transpileModule(
  readFileSync(new URL('./useMediaEngine.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText

class TestVideo extends EventTarget {
  currentTime = 10
  duration = 100
  readyState = 2
  paused = false
  seeking = false
  ended = false
  volume = 0.7
  muted = false
  playbackRate = 1
  bufferedEnd = 10.5
  loadCount = 0
  children: EventTarget[] = []
  buffered = {
    length: 1,
    start: () => 0,
    end: () => this.bufferedEnd,
  }

  get firstChild() { return this.children[0] || null }
  appendChild(child: EventTarget) { this.children.push(child) }
  removeChild(child: EventTarget) { this.children.splice(this.children.indexOf(child), 1) }
  removeAttribute() {}
  load() { this.loadCount++ }
  canPlayType() { return 'probably' }
  emit(name: string) { this.dispatchEvent(new Event(name)) }
  play() {
    this.paused = false
    this.emit('play')
    return Promise.resolve()
  }
  pause() {
    this.paused = true
    this.emit('pause')
  }
}

async function createPlayer(t: { after: (fn: () => void) => void }, format = 'm3u8') {
  const video = new TestVideo()
  const states: unknown[] = []
  const refs: { current: unknown }[] = []
  const effects: { deps: unknown[]; cleanup?: () => void }[] = []
  let stateIndex = 0
  let refIndex = 0
  let effectIndex = 0
  let pendingEffects: (() => void)[] = []
  let now = 0
  let timerId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const react = {
    useCallback: (fn: unknown) => fn,
    useRef: (initial: unknown) => {
      const index = refIndex++
      return refs[index] ||= { current: initial }
    },
    useState: (initial: unknown) => {
      const index = stateIndex++
      if (!(index in states)) states[index] = initial
      return [states[index], (value: unknown) => { states[index] = value }]
    },
    useEffect: (run: () => (() => void) | undefined, deps: unknown[]) => {
      const index = effectIndex++
      const previous = effects[index]
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
      pendingEffects.push(() => {
        previous?.cleanup?.()
        effects[index] = { deps, cleanup: run() }
      })
    },
  }
  const schedule = (callback: () => void, delay: number) => {
    const id = ++timerId
    timers.set(id, { at: now + delay, callback })
    return id
  }
  const module = { exports: {} as { useMediaEngine: (options: unknown) => any } }
  const context = createContext({
    module,
    exports: module.exports,
    require(name: string) {
      if (name === 'react') return react
      if (name === '../media/format') return mediaFormat
      if (name === '@animaku/shared') return { filterM3u8AdsIfApplicable() {} }
      if (name === '../../lib/performance-metrics') return { perfMetrics: { markFirstFrame() {} } }
      throw new Error(`Unexpected dependency: ${name}`)
    },
    window: {
      location: { origin: 'https://animaku.example.test' },
      setTimeout: schedule,
      clearTimeout: (id: number) => timers.delete(id),
    },
    navigator: { userAgent: 'iPhone Safari', platform: 'iPhone', maxTouchPoints: 1 },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3 },
    document: { createElement: () => new EventTarget() },
    URL,
    console,
  })
  runInContext(hookCode, context)
  let src = `https://cdn.example.test/episode-1.${format}`
  const render = () => {
    stateIndex = refIndex = effectIndex = 0
    const result = module.exports.useMediaEngine({
      videoRef: { current: video },
      activeSrc: src,
      playerSettings: { volume: 0.7, speed: 1, autoplay: false },
      withIntentGuard: (_duration: number, action: () => void) => action(),
      shouldSuppressPause: () => false,
    })
    const pending = pendingEffects
    pendingEffects = []
    pending.forEach((run) => run())
    return result
  }
  render()
  // The native-HLS attach path awaits the optional playlist-cleaning step.
  await Promise.resolve()
  video.emit('play')
  t.after(() => effects.forEach((effect) => effect.cleanup?.()))
  return {
    video,
    state: render,
    setSource(next: string) { src = next; render() },
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
  }
}

test('native HLS waiting shows the spinner despite remaining buffered data', async (t) => {
  const p = await createPlayer(t)
  assert.equal(p.state().bufferingUi, false)
  const loads = p.video.loadCount
  p.video.emit('waiting')
  assert.equal(p.state().bufferingUi, true)
  assert.equal(p.video.loadCount, loads, 'showing the spinner must not reload media')
})

test('unchanged timeupdate and canplay keep the spinner until playback resumes', async (t) => {
  const p = await createPlayer(t)
  p.video.emit('waiting')
  for (const event of ['timeupdate', 'canplay', 'play', 'timeupdate']) {
    p.video.emit(event)
    assert.equal(p.state().bufferingUi, true, `${event} alone is not resumed playback`)
  }
  p.video.emit('playing')
  assert.equal(p.state().bufferingUi, false)
})

test('advancing playback clears the spinner even without a playing event', async (t) => {
  const p = await createPlayer(t)
  p.video.emit('waiting')
  p.video.currentTime += 0.25
  p.video.emit('timeupdate')
  assert.equal(p.state().bufferingUi, false)
})

test('progressive MP4 also keeps the spinner through waiting until playing', async (t) => {
  const p = await createPlayer(t, 'mp4')
  p.video.emit('waiting')
  p.video.emit('timeupdate')
  p.video.emit('canplay')
  assert.equal(p.state().bufferingUi, true)
  p.video.emit('playing')
  assert.equal(p.state().bufferingUi, false)
})

test('a seek jump does not incorrectly clear a pending buffering spinner', async (t) => {
  const p = await createPlayer(t)
  p.video.emit('waiting')
  p.video.bufferedEnd = 40
  p.video.currentTime = 20
  p.video.seeking = true
  p.video.emit('seeking')
  p.video.emit('timeupdate')
  p.video.seeking = false
  // The decoder may land slightly past the requested seek position.
  p.video.currentTime = 20.1
  p.video.emit('seeked')
  p.video.emit('timeupdate')
  assert.equal(p.state().bufferingUi, true)
  p.video.currentTime += 0.25
  p.video.emit('timeupdate')
  assert.equal(p.state().bufferingUi, false)
})

test('manual pause hides buffering and resume can show it again', async (t) => {
  const p = await createPlayer(t)
  p.video.emit('waiting')
  p.state().togglePlay()
  assert.equal(p.state().bufferingUi, false)
  p.video.emit('waiting')
  assert.equal(p.state().bufferingUi, false)
  p.state().togglePlay()
  p.video.emit('waiting')
  assert.equal(p.state().bufferingUi, true)
  p.video.emit('playing')
  assert.equal(p.state().bufferingUi, false)
})

test('native pause suppresses waiting even when it bypasses the custom controls', async (t) => {
  const p = await createPlayer(t)
  p.video.emit('waiting')
  p.video.pause()
  p.video.emit('waiting')
  assert.equal(p.state().bufferingUi, false)
})

test('stalled with only a current frame shows the delayed spinner', async (t) => {
  const p = await createPlayer(t)
  p.video.emit('stalled')
  assert.equal(p.state().bufferingUi, false)
  p.video.emit('timeupdate')
  p.advance(280)
  assert.equal(p.state().bufferingUi, true)
})

test('stalled downloads do not show a spinner while future data is playable', async (t) => {
  const p = await createPlayer(t)
  p.video.readyState = 4
  p.video.emit('stalled')
  p.advance(1000)
  assert.equal(p.state().bufferingUi, false)
})

test('pause and playback recovery cancel a pending delayed spinner', async (t) => {
  const p = await createPlayer(t)
  p.video.emit('stalled')
  p.video.pause()
  p.advance(1000)
  assert.equal(p.state().bufferingUi, false)
  await p.video.play()
  p.video.emit('stalled')
  p.video.currentTime += 0.25
  p.video.emit('timeupdate')
  p.advance(1000)
  assert.equal(p.state().bufferingUi, false)
})

test('source changes and playback end clear buffering without a stale timer', async (t) => {
  const p = await createPlayer(t)
  p.video.emit('waiting')
  p.video.ended = true
  p.video.emit('ended')
  p.video.emit('waiting')
  assert.equal(p.state().bufferingUi, false)
  p.video.ended = false
  p.video.emit('stalled')
  p.setSource('https://cdn.example.test/episode-2.m3u8')
  await Promise.resolve()
  p.advance(1000)
  assert.equal(p.state().bufferingUi, false)
})
