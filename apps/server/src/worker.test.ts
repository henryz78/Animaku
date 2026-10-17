import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import app from './worker'

const template = `<!doctype html><html><head>
<title>Animaku</title>
<meta name="description" content="Original description" />
<meta property="og:title" content="Animaku" />
<meta name="twitter:title" content="Animaku" />
<script type="application/ld+json" data-animaku-jsonld="1">{"@type":"WebSite","name":"Animaku"}</script>
</head><body><h1 class="sr-only">Animaku</h1></body></html>`

function mockBindings(options: { fallback?: boolean; databaseError?: boolean } = {}) {
  let reads = 0
  const assetPaths: string[] = []
  const statement = {
    bind: (..._values: unknown[]) => statement,
    first: async <T>() => {
      reads++
      if (options.databaseError) throw new Error('D1 temporarily unavailable')
      return { value: JSON.stringify({ siteName: 'HY 动漫', siteTagline: '测试站点' }) } as T
    },
    all: async <T>() => ({ results: [] as T[] }),
    run: async () => ({ meta: { changes: 0 } }),
  }
  return {
    DB: { prepare: (_sql: string) => statement },
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input)
        const pathname = new URL(url).pathname
        assetPaths.push(pathname)
        if (pathname === '/assets/app.js') {
          return new Response('console.log("asset")', {
            headers: { 'Content-Type': 'application/javascript', ETag: 'original-js' },
          })
        }
        if (pathname.endsWith('.png') || (options.fallback && pathname !== '/index.html')) {
          return new Response('Not found', { status: 404 })
        }
        return new Response(template, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: 'original-html', 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
        })
      },
    },
    assetPaths,
    reads: () => reads,
  }
}

test('Worker applies D1 branding to the raw HTML title, social tags and WebSite data', async () => {
  const env = mockBindings()
  const response = await app.request('https://animaku.test/', {}, env)
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.ok(html.includes('<title>HY 动漫 - 测试站点</title>'))
  assert.ok(html.includes('property="og:title" content="HY 动漫 - 测试站点"'))
  assert.ok(html.includes('name="twitter:title" content="HY 动漫 - 测试站点"'))
  assert.ok(html.includes('"name": "HY 动漫"'))
  assert.ok(html.includes('<h1 class="sr-only">HY 动漫 - 测试站点</h1>'))
  assert.equal(env.reads(), 1)
  assert.equal(response.headers.get('ETag'), null)
  assert.equal(response.headers.get('Last-Modified'), null)
  assert.equal(response.headers.get('Cache-Control'), 'no-cache')
})

test('Worker brands the index.html fallback when a deep route has no physical asset', async () => {
  const env = mockBindings({ fallback: true })
  const response = await app.request('https://animaku.test/subject/1948?ep=1', {}, env)
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes('<title>HY 动漫 - 测试站点</title>'))
  assert.deepEqual(env.assetPaths, ['/subject/1948', '/index.html'])
})

test('Worker leaves static JS and missing image responses untouched without reading D1', async () => {
  const env = mockBindings()
  const script = await app.request('https://animaku.test/assets/app.js', {}, env)
  assert.equal(await script.text(), 'console.log("asset")')
  assert.equal(script.headers.get('ETag'), 'original-js')
  const image = await app.request('https://animaku.test/missing.png', {}, env)
  assert.equal(image.status, 404)
  assert.equal(env.reads(), 0)
})

test('Worker still serves the app shell when D1 branding is temporarily unavailable', async () => {
  const env = mockBindings({ databaseError: true })
  const response = await app.request('https://animaku.test/', {}, env)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), template)
})

function accountBindings() {
  const database = new DatabaseSync(':memory:')
  for (const migration of ['0001_cloudflare.sql', '0002_bangumi_data_mapping.sql', '0003_account_system.sql']) {
    database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  const DB = {
    prepare: (sql: string) => {
      let values: SQLInputValue[] = []
      const statement = {
        bind: (...input: unknown[]) => { values = input as SQLInputValue[]; return statement },
        first: async <T>() => (database.prepare(sql).get(...values) as T | undefined) ?? null,
        all: async <T>() => ({ results: database.prepare(sql).all(...values) as T[] }),
        run: async () => ({ meta: { changes: Number(database.prepare(sql).run(...values).changes) } }),
      }
      return statement
    },
  }
  return { database, DB, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-admin-password-123' }
}

async function loginCookie(env: ReturnType<typeof accountBindings>, username = 'admin', password = env.ADMIN_PASSWORD) {
  const response = await app.request('https://animaku.test/api/account/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  }, env)
  assert.equal(response.status, 200)
  const cookie = response.headers.get('Set-Cookie')?.split(';')[0]
  assert.ok(cookie)
  return cookie
}

function jsonPost(body: unknown, cookie?: string): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }
}

test('fresh D1 disables registration but still allows the configured administrator to log in', async (t) => {
  const env = accountBindings()
  t.after(() => env.database.close())
  const status = await app.request('https://animaku.test/api/account/me', {}, env)
  assert.equal(status.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await status.json(), { ok: true, user: null, available: true, registrationEnabled: false })
  const register = await app.request('https://animaku.test/api/account/register', jsonPost({ username: 'member', password: 'test-password-123' }), env)
  assert.equal(register.status, 403)
  const cookie = await loginCookie(env)
  const settings = await app.request('https://animaku.test/api/admin/accounts/settings', { headers: { Cookie: cookie } }, env)
  assert.equal(settings.status, 200)
  assert.equal(settings.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await settings.json(), { ok: true, registrationEnabled: false })
})

test('administrator switch persists over environment defaults and enforces registration without blocking existing logins', async (t) => {
  const env = { ...accountBindings(), ACCOUNT_REGISTRATION_ENABLED: 'false' }
  t.after(() => env.database.close())
  const cookie = await loginCookie(env)
  const enable = await app.request('https://animaku.test/api/admin/accounts/settings', jsonPost({ registrationEnabled: true }, cookie), env)
  assert.equal(enable.status, 200)
  assert.deepEqual(await enable.json(), { ok: true, registrationEnabled: true })
  const member = await app.request('https://animaku.test/api/account/register', jsonPost({ username: 'member', password: 'test-password-123' }), env)
  assert.equal(member.status, 201)
  const memberCookie = member.headers.get('Set-Cookie')!.split(';')[0]
  for (const request of [{}, { headers: { Cookie: memberCookie } }]) {
    const read = await app.request('https://animaku.test/api/admin/accounts/settings', request, env)
    assert.equal(read.status, 401)
    const change = await app.request('https://animaku.test/api/admin/accounts/settings', jsonPost({ registrationEnabled: false }, 'headers' in request ? memberCookie : undefined), env)
    assert.equal(change.status, 401)
  }
  const publicStatus = await app.request('https://animaku.test/api/account/me', {}, env)
  assert.equal((await publicStatus.json()).registrationEnabled, true)
  const disable = await app.request('https://animaku.test/api/admin/accounts/settings', jsonPost({ registrationEnabled: false }, cookie), env)
  assert.equal(disable.status, 200)
  // Even a subsequently changed legacy variable must not override the saved switch.
  const changedEnv = { ...env, ACCOUNT_REGISTRATION_ENABLED: 'true' }
  const status = await app.request('https://animaku.test/api/account/me', {}, changedEnv)
  assert.equal((await status.json()).registrationEnabled, false)
  const rejected = await app.request('https://animaku.test/api/account/register', jsonPost({ username: 'another', password: 'test-password-123' }), changedEnv)
  assert.equal(rejected.status, 403)
  assert.equal((await rejected.json()).error, 'registration_disabled')
  await loginCookie(changedEnv, 'member', 'test-password-123')
  await loginCookie(changedEnv)
})

test('legacy registration default remains available until saved and malformed settings cannot change it', async (t) => {
  const env = { ...accountBindings(), ACCOUNT_REGISTRATION_ENABLED: 'true' }
  t.after(() => env.database.close())
  const cookie = await loginCookie(env)
  for (const body of [null, [], {}, { registrationEnabled: 'false' }, { registrationEnabled: 1 }]) {
    const response = await app.request('https://animaku.test/api/admin/accounts/settings', jsonPost(body, cookie), env)
    assert.equal(response.status, 400)
  }
  const malformedJson = await app.request('https://animaku.test/api/admin/accounts/settings', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{',
  }, env)
  assert.equal(malformedJson.status, 400)
  const status = await app.request('https://animaku.test/api/account/me', {}, env)
  assert.equal((await status.json()).registrationEnabled, true)
})

test('site branding changes and resets do not erase the registration switch', async (t) => {
  const env = accountBindings()
  t.after(() => env.database.close())
  const cookie = await loginCookie(env)
  await app.request('https://animaku.test/api/admin/accounts/settings', jsonPost({ registrationEnabled: true }, cookie), env)
  const branding = await app.request('https://animaku.test/api/admin/site/config', jsonPost({ siteName: 'HY test' }, cookie), env)
  assert.equal(branding.status, 200)
  for (const path of ['/api/admin/site/reset-icon', '/api/admin/site/reset-all']) {
    const reset = await app.request(`https://animaku.test${path}`, jsonPost({}, cookie), env)
    assert.equal(reset.status, 200)
    const settings = await app.request('https://animaku.test/api/admin/accounts/settings', { headers: { Cookie: cookie } }, env)
    assert.deepEqual(await settings.json(), { ok: true, registrationEnabled: true })
  }
})

test('corrupt stored settings close registration while leaving administrator recovery available', async (t) => {
  const env = { ...accountBindings(), ACCOUNT_REGISTRATION_ENABLED: 'true' }
  t.after(() => env.database.close())
  env.database.prepare('INSERT INTO site_config (key, value, updated_at) VALUES (?, ?, ?)').run('account_registration', '{', Date.now())
  const status = await app.request('https://animaku.test/api/account/me', {}, env)
  assert.equal((await status.json()).registrationEnabled, false)
  const cookie = await loginCookie(env)
  const recovery = await app.request('https://animaku.test/api/admin/accounts/settings', jsonPost({ registrationEnabled: true }, cookie), env)
  assert.equal(recovery.status, 200)
  const recoveredStatus = await app.request('https://animaku.test/api/account/me', {}, env)
  assert.equal((await recoveredStatus.json()).registrationEnabled, true)
})
