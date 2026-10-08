import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Exercise the actual bridge without loading routes or rendering the whole app.
const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const bridge = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'AccountSyncBridge')!
const bridgeCode = ts.transpileModule(`${bridge.getText(ast)}\nmodule.exports = AccountSyncBridge`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture(loggedIn = true) {
  const windowMock = new EventTarget()
  const documentMock = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const requests: { resolve: () => void; reject: () => void }[] = []
  let timer: (() => void) | undefined
  let cleanup: (() => void) | undefined
  const module = { exports: undefined as any }
  runInNewContext(bridgeCode, {
    module,
    useAccountStore: (select: (state: unknown) => unknown) => select({ user: loggedIn ? { id: 'test' } : null }),
    useEffect: (run: () => (() => void) | undefined) => { cleanup = run() },
    syncCloudData: () => new Promise<void>((resolve, reject) => { requests.push({ resolve, reject: () => reject(new Error('offline')) }) }),
    WATCH_PROGRESS_FLUSH_EVENT: 'progress-flush',
    window: Object.assign(windowMock, {
      setInterval(run: () => void, delay: number) { assert.equal(delay, 60_000); timer = run; return 1 },
      clearInterval() { timer = undefined },
    }),
    document: documentMock,
  })
  module.exports()
  return {
    requests,
    flush() { windowMock.dispatchEvent(new Event('progress-flush')) },
    visibility(state: string) { documentMock.visibilityState = state; documentMock.dispatchEvent(new Event('visibilitychange')) },
    interval() { timer?.() },
    stop() { cleanup?.() },
  }
}

test('final progress saves and both tab visibility transitions trigger account sync', async () => {
  const p = fixture()
  p.flush()
  assert.equal(p.requests.length, 1)
  p.requests[0].resolve()
  await settle()
  p.visibility('hidden')
  assert.equal(p.requests.length, 2)
  p.requests[1].resolve()
  await settle()
  p.visibility('visible')
  assert.equal(p.requests.length, 3)
  p.requests[2].resolve()
  await settle()
  p.stop()
})

test('final saves arriving during an upload queue one fresh sync instead of being dropped', async () => {
  const p = fixture()
  p.interval()
  p.flush()
  p.flush()
  p.visibility('hidden')
  assert.equal(p.requests.length, 1)
  p.requests[0].resolve()
  await settle()
  assert.equal(p.requests.length, 2)
  p.requests[1].resolve()
  await settle()
  assert.equal(p.requests.length, 2)
  p.stop()
})

test('network failure allows the next periodic retry', async () => {
  const p = fixture()
  p.flush()
  p.requests[0].reject()
  await settle()
  p.interval()
  assert.equal(p.requests.length, 2)
  p.requests[1].resolve()
  await settle()
  p.stop()
})

test('logout or unmount cancels listeners, timer and queued follow-up sync', async () => {
  const p = fixture()
  p.flush()
  p.flush()
  p.stop()
  p.requests[0].resolve()
  await settle()
  p.flush()
  p.interval()
  p.visibility('hidden')
  assert.equal(p.requests.length, 1)
})

test('logged-out browsers do not start background sync', () => {
  const p = fixture(false)
  p.flush()
  p.interval()
  p.visibility('hidden')
  assert.equal(p.requests.length, 0)
})
