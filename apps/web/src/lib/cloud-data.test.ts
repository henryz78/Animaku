import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import ts from 'typescript'

// Use the real Zustand persistence and production sync code, with isolated
// browser storage and an in-memory account API instead of another dependency.
function load(path: string, dependencies: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
  const module = { exports: {} as any }
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports,
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    console, ...globals,
  })
  return module.exports
}

const shared = load('../../../../packages/shared/src/history.ts')
const historyHelpers = load('./watch-history.ts', { '@animaku/shared': shared })
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
const entry = (position = 120, updatedAt = 200, overrides: Record<string, unknown> = {}) => ({
  id: 'legacy-id', bangumiId: 1948, episode: 1, road: 0,
  title: 'Test anime', pluginName: 'source-a', pageUrl: '/episode/1',
  position, duration: 1500, updatedAt, ...overrides,
})
const snapshot = (items: unknown[]) => ({ version: 0, state: { items } })

function fixture(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]))
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  const windowMock = new EventTarget()
  const documentMock = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const debouncedStorage = load('./debounced-storage.ts', {}, {
    localStorage: storage, window: windowMock, document: documentMock,
    setTimeout, clearTimeout,
  })
  let clock = 200
  const history = load('../stores/history.ts', {
    zustand: { create }, 'zustand/middleware': { persist, createJSONStorage },
    '@animaku/shared': shared, '../lib/watch-history': historyHelpers,
    '../lib/debounced-storage': debouncedStorage,
    '../lib/storage': { migrateLocalStorageKey() {} },
  }, { localStorage: storage, Date: { now: () => clock } }).useHistoryStore
  let remote: Record<string, unknown> = {}
  const calls: { method: string; data?: Record<string, unknown> }[] = []
  let beforeRead: (() => Promise<void>) | null = null
  let fail = false
  const otherStores = { persist: { rehydrate: async () => {} } }
  const cloud = load('./cloud-data.ts', {
    './api': { api: async (_path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method || 'GET'
      calls.push({ method })
      if (fail) throw new Error('offline')
      if (method === 'GET') {
        await beforeRead?.()
        return { data: plain(remote), updatedAt: 100 }
      }
      remote = JSON.parse(init!.body!).data
      calls[calls.length - 1].data = remote
      return { ok: true }
    } },
    '../stores/history': { useHistoryStore: history },
    '../stores/plugins': { usePluginStore: otherStores },
    '../stores/search-history': { useSearchHistoryStore: otherStores },
    '../stores/settings': { useSettingsStore: otherStores },
    '../stores/source-bindings': { useSourceBindingStore: otherStores },
    '../stores/watched': { useWatchedStore: otherStores },
    './watch-history': historyHelpers,
  }, { window: { localStorage: storage } })
  return {
    history, cloud, storage, calls,
    save(item: ReturnType<typeof entry>) { clock = item.updatedAt; history.getState().upsert(item) },
    setRemote(data: Record<string, unknown>) { remote = data },
    remote: () => remote,
    delayRead(run: () => Promise<void>) { beforeRead = run },
    fail(value: boolean) { fail = value },
  }
}

test('continuous 10s progress updates persist immediately and enter the cloud snapshot', () => {
  const p = fixture({ 'animaku-history': snapshot([entry(5, 0)]) })
  for (let i = 1; i <= 12; i++) p.save(entry(i * 10, i * 10_000))
  const disk = JSON.parse(p.storage.getItem('animaku-history')!)
  const collected = p.cloud.collectCloudData()['animaku-history']
  assert.equal(disk.state.items[0].position, 120)
  assert.equal(collected.state.items[0].position, 120)
})

test('the running store remains authoritative when disk still contains an older copy', () => {
  const p = fixture()
  p.save(entry(120, 200))
  p.storage.setItem('animaku-history', JSON.stringify(snapshot([entry(5, 100)])))
  assert.equal(p.cloud.collectCloudData()['animaku-history'].state.items[0].position, 120)
  assert.equal(p.cloud.collectCloudData(p.storage)['animaku-history'].state.items[0].position, 5)
})

test('blocked history writes do not interrupt playback or erase the live snapshot', () => {
  const p = fixture()
  p.storage.setItem = () => { throw new Error('quota exceeded') }
  assert.doesNotThrow(() => p.save(entry(135, 300)))
  assert.equal(p.cloud.collectCloudData()['animaku-history'].state.items[0].position, 135)
})

test('a newer local episode survives merging, persistence, rehydration and upload', async () => {
  const p = fixture()
  p.save(entry(120, 200))
  p.setRemote({ 'animaku-history': snapshot([entry(5, 100, { pluginName: 'source-b', road: 1 })]) })
  await p.cloud.syncCloudData()
  assert.equal(p.history.getState().items.length, 1)
  assert.equal(p.history.getState().items[0].position, 120)
  assert.equal((p.remote()['animaku-history'] as any).state.items[0].position, 120)
  assert.equal(p.history.getState().items[0].pluginName, 'source-a')
})

test('a newer cloud episode wins, including a deliberate rewind to a lower position', async () => {
  const p = fixture()
  p.save(entry(600, 100))
  p.setRemote({ 'animaku-history': snapshot([entry(30, 200, { pluginName: 'source-b', pageUrl: '/new-source/1' })]) })
  await p.cloud.syncCloudData()
  assert.equal(p.history.getState().items[0].position, 30)
  assert.equal(p.history.getState().items[0].pageUrl, '/new-source/1')
})

test('legacy duplicate records are normalized by timestamp on local and cloud-only restore', () => {
  const rows = [entry(5, 100), entry(120, 200), entry(99, 50, { bangumiId: 400602, episode: undefined })]
  const p = fixture({ 'animaku-history': snapshot(rows) })
  assert.deepEqual(plain(p.history.getState().items.map((i: any) => [i.id, i.position])), [
    ['1948::ep1', 120], ['400602::ep1', 99],
  ])
  const merged = p.cloud.mergeCloudData({}, { 'animaku-history': snapshot(rows) })
  assert.deepEqual(plain(merged['animaku-history'].state.items.map((i: any) => i.position)), [120, 99])
})

test('equal timestamps keep the local choice and missing timestamps do not beat a dated record', () => {
  const p = fixture()
  const merged = p.cloud.mergeCloudData(
    { 'animaku-history': snapshot([entry(120, 200)]) },
    { 'animaku-history': snapshot([entry(5, 200), entry(8, NaN)]) },
  )
  assert.equal(merged['animaku-history'].state.items[0].position, 120)
})

test('different episodes and shows are kept, sorted newest first and capped at 200', () => {
  const rows = Array.from({ length: 220 }, (_, i) => entry(i, i, { episode: i }))
  rows.push(entry(99, 300, { bangumiId: 400602 }))
  const result = historyHelpers.mergeWatchHistory(rows, [null, {}, entry(1, 2, { episode: -1 })])
  assert.equal(result.length, 200)
  assert.equal(result[0].bangumiId, 400602)
  assert.equal(result[1].episode, 219)
  assert.equal(result[199].episode, 21)
})

test('sync takes progress updated while waiting for the cloud GET', async () => {
  const p = fixture()
  p.save(entry(120, 200))
  let release!: () => void
  p.delayRead(() => new Promise<void>((resolve) => { release = resolve }))
  const syncing = p.cloud.syncCloudData()
  p.save(entry(135, 300))
  release()
  await syncing
  assert.equal((p.remote()['animaku-history'] as any).state.items[0].position, 135)
})

test('account-page and background sync share one in-flight upload', async () => {
  const p = fixture()
  p.save(entry())
  let release!: () => void
  p.delayRead(() => new Promise<void>((resolve) => { release = resolve }))
  const first = p.cloud.syncCloudData()
  const second = p.cloud.syncCloudData()
  assert.equal(first, second)
  release()
  await Promise.all([first, second])
  assert.deepEqual(p.calls.map((call) => call.method), ['GET', 'PUT'])
})

test('an offline sync retains local progress and can retry successfully', async () => {
  const p = fixture()
  p.save(entry())
  p.fail(true)
  await assert.rejects(p.cloud.syncCloudData(), /offline/u)
  assert.equal(p.history.getState().items[0].position, 120)
  p.fail(false)
  await p.cloud.syncCloudData()
  assert.equal((p.remote()['animaku-history'] as any).state.items[0].position, 120)
})

test('history merging preserves other data and keeps Bangumi credentials on-device', async () => {
  const p = fixture({
    'animaku-settings': { version: 0, state: { theme: 'light', bangumiToken: 'device-only-token' } },
    'animaku-history': snapshot([entry()]),
    'unrelated-site': { secret: 'not-an-app-key' },
  })
  p.setRemote({
    'animaku-settings': { version: 0, state: { theme: 'dark' } },
    'animaku-search-history': { state: { queries: ['test'] } },
  })
  await p.cloud.syncCloudData()
  assert.equal(JSON.parse(p.storage.getItem('animaku-settings')!).state.bangumiToken, 'device-only-token')
  assert.equal(JSON.stringify(p.remote()).includes('device-only-token'), false)
  assert.equal('unrelated-site' in p.remote(), false)
  assert.equal((p.remote()['animaku-settings'] as any).state.theme, 'light')
  assert.deepEqual((p.remote()['animaku-search-history'] as any).state.queries, ['test'])
})
