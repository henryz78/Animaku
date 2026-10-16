import test from 'node:test'
import assert from 'node:assert/strict'
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
