import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { create } from 'zustand'
import ts from 'typescript'

function load(path: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const module = { exports: {} as any }
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => { if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name] }, ...globals })
  return module.exports
}
class ApiError extends Error { constructor(public status: number) { super('API failed') } }
function fixture() {
  const local = new Map<string, string>()
  const meta = new Map<string, unknown>()
  const window = new EventTarget()
  const profile = load('./profile.ts', {
    './types': { DEFAULT_CACHE_SETTINGS: { auto: false, ahead: 2, limitGB: 2 } },
    './db': { readStore: async (_store: string, key: string) => meta.get(key), writeStore: async (_store: string, value: unknown, key: string) => { meta.set(key, value) } },
  }, { window, Event, localStorage: { getItem: (key: string) => local.get(key) || null, setItem: (key: string, value: string) => local.set(key, value), removeItem: (key: string) => local.delete(key) } })
  let reply: unknown = { user: { id: 'owner-a', username: 'Alice', role: 'admin' } }
  const account = load('../stores/account.ts', { zustand: { create }, '../lib/api': { ApiError, api: async () => { if (reply instanceof Error) throw reply; return reply } }, '../offline/profile': profile }).useAccountStore
  return { profile, account, local, meta, window, reply: (value: unknown) => { reply = value } }
}
test('offline snapshot stores only account identity, never admin role or password', async () => {
  const f = fixture(); await f.account.getState().init()
  const saved = JSON.parse(f.local.get('animaku.offline-profile')!)
  assert.deepEqual(saved, { id: 'owner-a', username: 'Alice' })
  assert.equal(f.meta.get('owner'), 'owner-a')
  assert.equal(f.account.getState().user.role, 'admin')
})
test('a real authentication refusal clears offline access while network failure retains local identity', async () => {
  const f = fixture(); await f.account.getState().init()
  f.reply(new TypeError('network unavailable')); await f.account.getState().init()
  assert.equal(f.account.getState().available, false)
  assert.equal(f.profile.offlineProfile().id, 'owner-a')
  assert.equal(f.account.getState().user, null)
  f.reply(new ApiError(401)); await f.account.getState().init()
  assert.equal(f.account.getState().available, true)
  assert.equal(f.profile.offlineProfile(), null)
  assert.equal(f.meta.get('owner'), null)
})
test('logout always removes local access even if its network request fails', async () => {
  const f = fixture(); await f.account.getState().init()
  f.reply(new TypeError('offline'))
  await assert.rejects(f.account.getState().logout())
  assert.equal(f.profile.offlineProfile(), null); assert.equal(f.account.getState().user, null)
})
test('checking the same account does not interrupt in-flight cache downloads', async () => {
  const f = fixture(); let changes = 0
  f.window.addEventListener('animaku:offline-owner', () => { changes++ })
  await f.account.getState().init(); await f.account.getState().init()
  assert.equal(changes, 1)
  f.local.set('animaku.offline-profile', '{invalid-json')
  assert.equal(f.profile.offlineProfile(), null)
})
