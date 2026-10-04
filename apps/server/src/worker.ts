import { Hono } from 'hono'
import {
  fromBangumiCollectionType,
  parseBilibiliInput,
  parseDanmakuComments,
  parseDanmakuXml,
  parseBangumiItem,
  parsePluginRule,
  resolveCountryTag,
  toBangumiCollectionType,
  type BangumiItem,
  type BangumiSubjectMetadata,
} from '@animaku/shared'
import type { PlaybackAsset } from './lib/media/playback-types'
import {
  mapBangumiCharacters,
  mapBangumiEpisode,
  mapBangumiRelations,
  mapBangumiReviews,
  mapBangumiStaff,
  mapBangumiCharacterDetail,
  mapBangumiPersonDetail,
} from './lib/bangumi-metadata'
import { enrichBangumiEpisodesWithTmdb } from './lib/tmdb-episodes'
import {
  clearedSessionCookie,
  createSession,
  deleteSession,
  findSessionUser,
  findStoredUser,
  hashPassword,
  insertUser,
  isRegistrationEnabled,
  normalizeUsername,
  readSessionToken,
  sessionCookie,
  toPublicUser,
  validatePassword,
  validateUsername,
  verifyPassword,
  type AccountDatabase,
} from './lib/account-auth'

const runtime = globalThis as typeof globalThis & {
  __ANIMAKU_WORKER__?: boolean
  __ANIMAKU_WORKER_ENV?: Record<string, string | undefined>
}
runtime.__ANIMAKU_WORKER__ = true

type D1Result<T = unknown> = {
  results?: T[]
  meta?: { changes?: number }
}

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement
  first: <T = unknown>() => Promise<T | null>
  all: <T = unknown>() => Promise<D1Result<T>>
  run: () => Promise<D1Result>
}

type D1Binding = { prepare: (sql: string) => D1Statement }
type AssetBinding = { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }

type WorkerBindings = {
  DB?: D1Binding
  ASSETS?: AssetBinding
  APP_VERSION?: string
  ADMIN_SECRET?: string
  BANGUMI_API?: string
  BANGUMI_NEXT_API?: string
  BANGUMI_USER_AGENT?: string
  DANDAN_APP_ID?: string
  DANDAN_APP_SECRET?: string
  MEDIA_SECRET?: string
  CORS_ORIGINS?: string
  ACCOUNT_REGISTRATION_ENABLED?: string
  UPSTREAM_PROXY_URL?: string
  UPSTREAM_PROXY_TOKEN?: string
  TMDB_API_KEY?: string
}

type WorkerEnv = { Bindings: WorkerBindings }

type BilibiliBangumiMapping = {
  targetId: string
  isHkMoTw: boolean
  title?: string
}

/**
 * Cloudflare does not run the Node startup path that loads bangumi-data into
 * an in-process SQLite database. Read the cross-site mapping from D1 instead.
 */
async function getBilibiliTargetByBangumiId(
  env: WorkerBindings,
  bangumiId: number,
): Promise<BilibiliBangumiMapping | null> {
  if (!env.DB) return null
  try {
    const row = await env.DB
      .prepare('SELECT title, sites FROM bangumi_data_mapping WHERE bangumi_id = ? LIMIT 1')
      .bind(bangumiId)
      .first<{ title?: string; sites?: string }>()
    if (!row?.sites) return null
    const sites = JSON.parse(row.sites) as Record<string, unknown>
    if (typeof sites.bilibili === 'string' && sites.bilibili) {
      return { targetId: sites.bilibili, isHkMoTw: false, title: row.title || undefined }
    }
    if (typeof sites.bilibili_hk_mo_tw === 'string' && sites.bilibili_hk_mo_tw) {
      return { targetId: sites.bilibili_hk_mo_tw, isHkMoTw: true, title: row.title || undefined }
    }
  } catch {
    // The mapping table may not exist during a partially migrated deployment.
  }
  return null
}

const app = new Hono<WorkerEnv>()
const DEFAULT_BANGUMI_API = 'https://bgmapi.anibt.net'
const DEFAULT_BANGUMI_NEXT_API = 'https://next.bgm.tv'
const DEFAULT_DANDAN_API = 'https://api.dandanplay.net'
const FALLBACK_DANDAN_APP_ID = 'hvf6pzvxcm'
const FALLBACK_DANDAN_APP_SECRET = 'IZhcUIakoxFaK9xBBDJ9Bs1OU2s4kK5t'

const defaultSiteConfig = {
  siteName: '',
  siteTagline: '',
  iconMode: 'default',
  iconUrl: '',
  iconUpdatedAt: 0,
} as const

const EGRESS_PROXY_HOSTS = new Set([
  'api.bilibili.com',
  'www.bilibili.com',
  'animoe.org',
  'www.animoe.org',
  'tvtfun.net',
  'www.tvtfun.net',
])

let ruleEnginePromise: Promise<typeof import('./rule-engine')> | null = null
function configureRuntime(env: WorkerBindings) {
  runtime.__ANIMAKU_WORKER_ENV = Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === 'string'),
  ) as Record<string, string | undefined>
}
function getRuleEngine(env: WorkerBindings) {
  configureRuntime(env)
  return (ruleEnginePromise ||= import('./rule-engine'))
}

let sourceRegistryPromise: Promise<typeof import('./lib/source/source-registry')> | null = null
function getSourceRegistry(env: WorkerBindings) {
  configureRuntime(env)
  return (sourceRegistryPromise ||= import('./lib/source/source-registry'))
}

let playbackPromise: Promise<typeof import('./lib/media/playback-registry')> | null = null
function getPlayback(env: WorkerBindings) {
  configureRuntime(env)
  return (playbackPromise ||= import('./lib/media/playback-registry'))
}

async function upstreamJson(
  url: string,
  init: RequestInit = {},
  userAgent = 'Animaku/1.18.7',
): Promise<{ response: Response; data: unknown }> {
  const headers = new Headers(init.headers)
  headers.set('Accept', headers.get('Accept') || 'application/json')
  headers.set('User-Agent', headers.get('User-Agent') || userAgent)
  const response = await fetch(url, { ...init, headers })
  const text = await response.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { response, data }
}

function upstreamError(response: Response, data: unknown) {
  const message =
    data && typeof data === 'object' && 'message' in data
      ? String((data as { message?: unknown }).message || '')
      : `上游请求失败 (${response.status})`
  return { error: 'upstream', message }
}

function allowedOrigin(origin: string | undefined, raw: string | undefined): string | undefined {
  if (!origin) return undefined
  const allowed = (raw || '').split(',').map((value) => value.trim()).filter(Boolean)
  return allowed.includes('*') || allowed.includes(origin) ? origin : undefined
}

app.use('*', async (c, next) => {
  await next()
  const origin = allowedOrigin(c.req.header('Origin'), c.env.CORS_ORIGINS)
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Vary', 'Origin')
  }
})

app.options('*', (c) => {
  const origin = allowedOrigin(c.req.header('Origin'), c.env.CORS_ORIGINS)
  if (origin) c.header('Access-Control-Allow-Origin', origin)
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Secret')
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  return c.body(null, 204)
})

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    runtime: 'cloudflare-worker',
    version: c.env.APP_VERSION || '1.18.7',
    // Keep the official health fields for clients that use the original API.
    danmakuConfigured: true,
    danmakuUsingFallback: !(c.env.DANDAN_APP_ID?.trim() && c.env.DANDAN_APP_SECRET?.trim()),
    d1Configured: Boolean(c.env.DB),
    assetsConfigured: Boolean(c.env.ASSETS),
    originFallbackConfigured: false,
    capabilities: {
      bangumi: true,
      danmaku: true,
      stats: Boolean(c.env.DB),
      account: Boolean(c.env.DB),
      siteConfig: Boolean(c.env.DB),
      pluginRules: 'search-chapters-resolve',
      controlledSources: 'search-chapters-resolve',
      mediaProxy: 'ticket-stream',
    },
  }),
)

function bangumiApi(c: { env: WorkerBindings }) {
  return (c.env.BANGUMI_API || DEFAULT_BANGUMI_API).replace(/\/+$/, '')
}

function bangumiNextApi(c: { env: WorkerBindings }) {
  return (c.env.BANGUMI_NEXT_API || DEFAULT_BANGUMI_NEXT_API).replace(/\/+$/, '')
}

function bangumiUserAgent(c: { env: WorkerBindings }) {
  return c.env.BANGUMI_USER_AGENT || 'uerax/Animaku/1.18.7 (https://github.com/henryz78/Animaku)'
}

function subjectItem(raw: unknown): BangumiItem | unknown {
  if (!raw || typeof raw !== 'object') return raw
  const item = raw as Record<string, unknown>
  const subject = item.subject && typeof item.subject === 'object'
    ? {
        ...(item.subject as Record<string, unknown>),
        watchers: item.watchers ?? (item.subject as Record<string, unknown>).watchers,
        count: item.count ?? (item.subject as Record<string, unknown>).count,
        heat: item.heat ?? item.count ?? (item.subject as Record<string, unknown>).heat,
      }
    : item
  try {
    return parseBangumiItem(subject)
  } catch {
    return subject
  }
}

function normalizeCalendar(raw: unknown): unknown[][] {
  if (!Array.isArray(raw)) return Array.from({ length: 7 }, () => [])
  const days = Array.from({ length: 7 }, () => [] as unknown[])
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as { weekday?: { id?: number }; items?: unknown[] }
    const day = Number(value.weekday?.id || 0)
    if (day >= 1 && day <= 7 && Array.isArray(value.items)) {
      days[day - 1].push(...value.items.map(subjectItem))
    }
  }
  return days
}

app.get('/api/bangumi/calendar', async (c) => {
  const urls = [
    `${bangumiApi(c)}/calendar`,
    `${bangumiNextApi(c)}/p1/calendar`,
  ]
  for (const url of urls) {
    try {
      const { response, data } = await upstreamJson(url, {}, bangumiUserAgent(c))
      if (response.ok) return c.json({ data: normalizeCalendar(data) })
    } catch {
      /* try the next upstream */
    }
  }
  return c.json({ error: 'upstream', message: 'Bangumi 日历暂时不可用' }, 502)
})

app.get('/api/bangumi/trending', async (c) => {
  const url = new URL(`${bangumiNextApi(c)}/p1/trending/subjects`)
  url.searchParams.set('type', c.req.query('type') || '2')
  for (const key of ['limit', 'offset', 'type']) {
    const value = c.req.query(key)
    if (value) url.searchParams.set(key, value)
  }
  try {
    const { response, data } = await upstreamJson(url.toString(), {}, bangumiUserAgent(c))
    if (!response.ok) return c.json(upstreamError(response, data), 502)
    const items = data && typeof data === 'object' && Array.isArray((data as { data?: unknown[] }).data)
      ? (data as { data: unknown[] }).data.map(subjectItem)
      : []
    return c.json({ data: items })
  } catch (error) {
    return c.json({ error: 'upstream', message: String(error) }, 502)
  }
})

app.post('/api/bangumi/search', async (c) => {
  const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : ''
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50)
  const offset = Math.max(Number(body.offset) || 0, 0)
  const requestedSort = typeof body.sort === 'string' ? body.sort.toLowerCase() : 'heat'
  const sortByDate = requestedSort === 'date' || requestedSort === 'airdate'
  const upstreamSort = sortByDate || !['match', 'heat', 'rank', 'score'].includes(requestedSort) ? 'heat' : requestedSort
  const tags = Array.isArray(body.tags) ? body.tags.map((value) => String(value).trim()).filter(Boolean).slice(0, 8) : []
  const airDate = Array.isArray(body.airDate)
    ? body.airDate.filter((value): value is string => typeof value === 'string' && /^(>=|<=|>|<)?\d{4}-\d{2}-\d{2}$/.test(value.trim())).map((value) => value.trim())
    : []
  const year = body.year != null && Number.isFinite(Number(body.year)) ? Math.trunc(Number(body.year)) : null
  if (year != null && year >= 1900 && year <= 2100 && airDate.length === 0) {
    airDate.push(`>=${year}-01-01`, `<${year + 1}-01-01`)
  }
  const rawTypes = Array.isArray(body.type)
    ? body.type
    : body.type != null && Number(body.type) > 0
      ? [Number(body.type)]
      : [2, 6]
  const types = rawTypes.map(Number).filter((value) => Number.isFinite(value) && value > 0)
  const filter: Record<string, unknown> = {
    type: types.length > 0 ? types : [2, 6],
    nsfw: false,
    rank: ['>=0', '<=99999'],
  }
  if (tags.length) filter.tag = tags
  if (airDate.length) filter.air_date = airDate
  if (upstreamSort === 'rank' || upstreamSort === 'score') filter.rank = ['>0', '<=99999']
  // Bangumi v0 requires a keyword even for tag/year/type-only searches.
  // Keep the Cloudflare entrypoint aligned with the official server route.
  const upstreamKeyword = keyword || '*'
  try {
    const { response, data } = await upstreamJson(
      `${bangumiApi(c)}/v0/search/subjects?limit=${limit}&offset=${offset}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: upstreamKeyword, sort: upstreamSort, filter }),
      },
      bangumiUserAgent(c),
    )
    if (!response.ok) return c.json(upstreamError(response, data), 502)
    if (!data || typeof data !== 'object' || !Array.isArray((data as { data?: unknown[] }).data)) return c.json(data)
    const mapped = (data as { data: unknown[] }).data.map(subjectItem)
    if (!sortByDate) return c.json({ ...(data as Record<string, unknown>), data: mapped })
    const sorted = [...mapped].sort((left, right) => {
      const a = left as { airDate?: string }
      const b = right as { airDate?: string }
      return String(b.airDate || '').localeCompare(String(a.airDate || ''))
    })
    return c.json({ ...(data as Record<string, unknown>), data: sorted })
  } catch (error) {
    return c.json({ error: 'upstream', message: String(error) }, 502)
  }
})

app.get('/api/bangumi/subjects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad_request', message: '无效的 subjectId' }, 400)
  try {
    const { response, data } = await upstreamJson(`${bangumiApi(c)}/v0/subjects/${id}`, {}, bangumiUserAgent(c))
    if (!response.ok) return c.json(upstreamError(response, data), 502)
    return c.json({ data: data && typeof data === 'object' ? parseBangumiItem(data as Record<string, unknown>) : data })
  } catch (error) {
    return c.json({ error: 'upstream', message: String(error) }, 502)
  }
})

app.get('/api/bangumi/subjects/:id/episodes', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad_request', message: '无效的 subjectId' }, 400)
  try {
    const episodeResult = await upstreamJson(`${bangumiApi(c)}/v0/episodes?subject_id=${id}&limit=200`, {}, bangumiUserAgent(c))
    if (!episodeResult.response.ok) return c.json(upstreamError(episodeResult.response, episodeResult.data), 502)
    const rows = Array.isArray(episodeResult.data)
      ? episodeResult.data
      : (episodeResult.data as { data?: unknown[] })?.data || []
    let episodes = rows.map(mapBangumiEpisode)
    if (c.env.TMDB_API_KEY && episodes.some((episode) => episode.type === 0)) {
      try {
        const subjectResult = await upstreamJson(`${bangumiApi(c)}/v0/subjects/${id}`, {}, bangumiUserAgent(c))
        if (subjectResult.response.ok && subjectResult.data && typeof subjectResult.data === 'object') {
          const subject = parseBangumiItem(subjectResult.data as Record<string, unknown>)
          episodes = await enrichBangumiEpisodesWithTmdb(subject, episodes, c.env.TMDB_API_KEY)
        }
      } catch {
        // TMDB is optional; preserve the official episode response if enrichment fails.
      }
    }
    return c.json({ data: episodes })
  } catch (error) {
    return c.json({ error: 'upstream', message: String(error) }, 502)
  }
})

app.get('/api/bangumi/subjects/:id/metadata', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'bad_request', message: '无效的 subjectId' }, 400)
  }
  const limit = Math.min(Math.max(Number(c.req.query('reviewsLimit')) || 20, 1), 50)
  const offset = Math.max(Number(c.req.query('reviewsOffset')) || 0, 0)
  const results = await Promise.allSettled([
    upstreamJson(`${bangumiApi(c)}/v0/subjects/${id}/characters`, {}, bangumiUserAgent(c)),
    upstreamJson(`${bangumiApi(c)}/v0/subjects/${id}/persons`, {}, bangumiUserAgent(c)),
    upstreamJson(`${bangumiApi(c)}/v0/subjects/${id}/subjects`, {}, bangumiUserAgent(c)),
    upstreamJson(`${bangumiNextApi(c)}/p1/subjects/${id}/reviews?limit=${limit}&offset=${offset}`, {}, bangumiUserAgent(c)),
  ])
  const dataAt = (index: number): unknown => {
    const result = results[index]
    return result?.status === 'fulfilled' && result.value.response.ok ? result.value.data : null
  }
  const reviews = mapBangumiReviews(dataAt(3))
  const metadata = {
    characters: mapBangumiCharacters(dataAt(0)),
    staff: mapBangumiStaff(dataAt(1)),
    relations: mapBangumiRelations(dataAt(2)),
    reviews: reviews.data,
    reviewsTotal: reviews.total,
    reviewsUnavailable: dataAt(3) == null,
  } satisfies BangumiSubjectMetadata
  return c.json(
    { data: metadata },
    200,
    {
      'Cache-Control': 'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400',
    },
  )
})

app.get('/api/bangumi/characters/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad_request', message: '无效的 characterId' }, 400)
  const results = await Promise.allSettled([
    upstreamJson(`${bangumiApi(c)}/v0/characters/${id}`, {}, bangumiUserAgent(c)),
    upstreamJson(`${bangumiApi(c)}/v0/characters/${id}/subjects`, {}, bangumiUserAgent(c)),
  ])
  const detail = results[0]
  if (detail?.status !== 'fulfilled' || !detail.value.response.ok) {
    return c.json({ error: 'upstream', message: detail?.status === 'fulfilled' ? detail.value.data : '角色详情请求失败' }, 502)
  }
  const works = results[1]?.status === 'fulfilled' && results[1].value.response.ok ? results[1].value.data : []
  return c.json({ data: mapBangumiCharacterDetail(detail.value.data, works) })
})

app.get('/api/bangumi/persons/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad_request', message: '无效的 personId' }, 400)
  const results = await Promise.allSettled([
    upstreamJson(`${bangumiApi(c)}/v0/persons/${id}`, {}, bangumiUserAgent(c)),
    upstreamJson(`${bangumiApi(c)}/v0/persons/${id}/subjects`, {}, bangumiUserAgent(c)),
    upstreamJson(`${bangumiApi(c)}/v0/persons/${id}/characters`, {}, bangumiUserAgent(c)),
  ])
  const detail = results[0]
  if (detail?.status !== 'fulfilled' || !detail.value.response.ok) {
    return c.json({ error: 'upstream', message: detail?.status === 'fulfilled' ? detail.value.data : '人员详情请求失败' }, 502)
  }
  const works = results[1]?.status === 'fulfilled' && results[1].value.response.ok ? results[1].value.data : []
  const characters = results[2]?.status === 'fulfilled' && results[2].value.response.ok ? results[2].value.data : []
  return c.json({ data: mapBangumiPersonDetail(detail.value.data, works, characters) })
})

function authorization(c: { req: { header: (name: string) => string | undefined } }) {
  return c.req.header('Authorization') || ''
}

async function authenticatedJson(c: { env: WorkerBindings; req: { header: (name: string) => string | undefined } }, url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const token = authorization(c)
  if (token) headers.set('Authorization', token)
  return upstreamJson(url, { ...init, headers }, bangumiUserAgent(c))
}

app.get('/api/bangumi/me', async (c) => {
  if (!authorization(c)) return c.json({ error: 'unauthorized', message: '缺少 Access Token' }, 401)
  try {
    const { response, data } = await authenticatedJson(c, `${bangumiApi(c)}/v0/me`)
    if (!response.ok) return c.json(upstreamError(response, data), response.status === 401 ? 401 : 502)
    const value = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    return c.json({ data: {
      id: Number(value.id || 0),
      username: String(value.username || value.nickname || ''),
      nickname: String(value.nickname || value.username || ''),
      avatar: value.avatar && typeof value.avatar === 'object' ? value.avatar : undefined,
    } })
  } catch (error) {
    return c.json({ error: 'upstream', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

async function currentUsername(c: any): Promise<string | null> {
  if (!authorization(c)) return null
  const { response, data } = await authenticatedJson(c, `${bangumiApi(c)}/v0/me`)
  if (!response.ok || !data || typeof data !== 'object') return null
  const value = data as Record<string, unknown>
  return value.username ? String(value.username) : value.id ? String(value.id) : null
}

app.get('/api/bangumi/collections', async (c) => {
  if (!authorization(c)) return c.json({ error: 'unauthorized', message: '缺少 Access Token' }, 401)
  try {
    const username = await currentUsername(c)
    if (!username) return c.json({ error: 'unauthorized', message: '无法获取用户信息或 Access Token 无效' }, 401)
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 24, 1), 50)
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
    const url = new URL(`${bangumiApi(c)}/v0/users/${encodeURIComponent(username)}/collections`)
    url.searchParams.set('subject_type', '2')
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))
    if (c.req.query('type')) url.searchParams.set('type', c.req.query('type') || '')
    const { response, data } = await authenticatedJson(c, url.toString())
    if (!response.ok) return c.json(upstreamError(response, data), 502)
    const rows = data && typeof data === 'object' && Array.isArray((data as { data?: unknown[] }).data)
      ? (data as { data: unknown[] }).data : []
    const mapped = rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object')).map((row) => {
      const subject = row.subject && typeof row.subject === 'object' ? parseBangumiItem(row.subject as Record<string, unknown>) : undefined
      return {
        subjectId: Number(row.subject_id || (subject as BangumiItem | undefined)?.id || 0),
        type: fromBangumiCollectionType(Number(row.type || 0)),
        updatedAt: String(row.updated_at || ''),
        epStatus: row.ep_status == null ? undefined : Number(row.ep_status),
        rate: row.rate == null ? undefined : Number(row.rate),
        comment: row.comment == null ? undefined : String(row.comment),
        subject,
      }
    })
    return c.json({ data: mapped, total: Number((data as { total?: number })?.total || mapped.length), limit, offset })
  } catch (error) {
    return c.json({ error: 'upstream', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.put('/api/bangumi/collections/:subjectId', async (c) => {
  if (!authorization(c)) return c.json({ error: 'unauthorized', message: '缺少 Access Token' }, 401)
  const body = (await c.req.json<{ type?: number }>().catch(() => ({}))) as { type?: number }
  const localType = Number(body.type)
  const bgmType = [1, 2, 3, 4, 5].includes(localType)
    ? toBangumiCollectionType(localType as 1 | 2 | 3 | 4 | 5)
    : null
  if (bgmType == null) return c.json({ error: 'bad_request', message: '无效收藏类型' }, 400)
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: bgmType }),
  }
  try {
    const first = await authenticatedJson(c, `${bangumiApi(c)}/v0/users/-/collections/${c.req.param('subjectId')}`, init)
    if (!first.response.ok && first.response.status !== 204) {
      const fallback = await authenticatedJson(c, `${bangumiApi(c)}/v0/users/-/collections/${c.req.param('subjectId')}`, { ...init, method: 'PATCH' })
      if (!fallback.response.ok && fallback.response.status !== 204) return c.json(upstreamError(fallback.response, fallback.data), 502)
    }
    return c.json({ ok: true, type: body.type })
  } catch (error) {
    return c.json({ error: 'upstream', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.get('/api/bangumi/collections/:subjectId', async (c) => {
  if (!authorization(c)) return c.json({ error: 'unauthorized', message: '缺少 Access Token' }, 401)
  try {
    const username = await currentUsername(c)
    if (!username) return c.json({ error: 'unauthorized', message: '无法获取用户信息或 Access Token 无效' }, 401)
    const { response, data } = await authenticatedJson(c, `${bangumiApi(c)}/v0/users/${encodeURIComponent(username)}/collections/${c.req.param('subjectId')}`)
    if (response.status === 404) return c.json({ data: null })
    if (!response.ok) return c.json(upstreamError(response, data), 502)
    const row = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    return c.json({ data: {
      subjectId: Number(row.subject_id || c.req.param('subjectId')),
      type: fromBangumiCollectionType(Number(row.type || 0)),
      updatedAt: String(row.updated_at || ''),
      epStatus: row.ep_status == null ? undefined : Number(row.ep_status),
      rate: row.rate == null ? undefined : Number(row.rate),
      comment: row.comment == null ? undefined : String(row.comment),
    } })
  } catch (error) {
    return c.json({ error: 'upstream', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

type RecommendationItem = {
  id: number
  name: string
  nameCn: string
  cover: string
  score: number
  year: string
  epsLabel: string
  relationBadge?: '续作' | '前作' | '剧场版'
}

function recommendationItem(raw: Record<string, unknown>, relationBadge?: RecommendationItem['relationBadge']): RecommendationItem {
  const parsed = parseBangumiItem(raw)
  const cover = parsed.images?.medium || parsed.images?.common || parsed.images?.large || ''
  const totalEpisodes = parsed.totalEpisodes || parsed.eps || 0
  return {
    id: parsed.id,
    name: parsed.name,
    nameCn: parsed.nameCn || parsed.name,
    cover,
    score: parsed.ratingScore,
    year: parsed.airDate ? parsed.airDate.slice(0, 4) : '',
    epsLabel: totalEpisodes > 0 ? `全${totalEpisodes}话` : '',
    ...(relationBadge ? { relationBadge } : {}),
  }
}

async function recommendationsFor(c: { env: WorkerBindings }, subjectId: number, options: {
  tags?: string[]
  country?: string
  isMovie?: boolean
}) {
  let detail: BangumiItem | null = null
  try {
    const detailResult = await upstreamJson(`${bangumiApi(c)}/v0/subjects/${subjectId}`, {}, bangumiUserAgent(c))
    if (detailResult.response.ok && detailResult.data && typeof detailResult.data === 'object') {
      detail = parseBangumiItem(detailResult.data as Record<string, unknown>)
    }
  } catch {
    /* recommendations can still use the supplied query values */
  }

  const country = options.country || (detail ? resolveCountryTag(detail.tags) : '日本')
  const tags = (options.tags && options.tags.length > 0
    ? options.tags
    : detail?.tags.map((tag) => tag.name).filter(Boolean).slice(0, 2) || [])
  const searchTags = [country, ...tags.filter((tag) => tag !== country).slice(0, 2)]
  if (options.isMovie && !searchTags.includes('剧场版')) searchTags.push('剧场版')

  const items: RecommendationItem[] = []
  const seen = new Set<number>([subjectId])
  try {
    const relationResult = await upstreamJson(`${bangumiApi(c)}/v0/subjects/${subjectId}/subjects`, {}, bangumiUserAgent(c))
    const relations = Array.isArray(relationResult.data)
      ? relationResult.data
      : []
    const next = relations.find((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const value = entry as Record<string, unknown>
      return Number(value.type) === 2 && ['续集', '主线故事', '不同演绎'].includes(String(value.relation || ''))
    }) as Record<string, unknown> | undefined
    const previous = !next ? relations.find((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const value = entry as Record<string, unknown>
      return Number(value.type) === 2 && String(value.relation || '') === '前传'
    }) as Record<string, unknown> | undefined : undefined
    const relation = next || previous
    if (relation && Number(relation.id) > 0) {
      const relationId = Number(relation.id)
      const relationResult = await upstreamJson(`${bangumiApi(c)}/v0/subjects/${relationId}`, {}, bangumiUserAgent(c))
      if (relationResult.response.ok && relationResult.data && typeof relationResult.data === 'object') {
        const relationTitle = String((relationResult.data as Record<string, unknown>).name_cn || (relationResult.data as Record<string, unknown>).name || '')
        const isMovie = relationTitle.includes('剧场版') || relationTitle.includes('电影')
        items.push(recommendationItem(relationResult.data as Record<string, unknown>, next ? (isMovie ? '剧场版' : '续作') : '前作'))
        seen.add(relationId)
      }
    }
  } catch {
    /* relation data is optional */
  }

  try {
    const result = await upstreamJson(`${bangumiApi(c)}/v0/search/subjects?limit=20&offset=0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sort: 'match',
        filter: { type: [2], tag: searchTags, nsfw: false, air_date: [`<=${new Date().toISOString().slice(0, 10)}`] },
      }),
    }, bangumiUserAgent(c))
    const rows = result.data && typeof result.data === 'object' && Array.isArray((result.data as { data?: unknown[] }).data)
      ? (result.data as { data: unknown[] }).data
      : []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const id = Number((row as Record<string, unknown>).id || 0)
      if (!id || seen.has(id)) continue
      try {
        items.push(recommendationItem(row as Record<string, unknown>))
        seen.add(id)
      } catch {
        /* skip malformed recommendation */
      }
      if (items.length >= 15) break
    }
  } catch {
    /* return relation-only recommendations when search is unavailable */
  }

  return { items: items.slice(0, 15), matchedTags: searchTags }
}

async function recommendationResponse(c: any, idRaw: string) {
  const subjectId = Number(idRaw)
  if (!Number.isInteger(subjectId) || subjectId <= 0) return c.json({ error: 'bad_request', message: '无效的 subjectId' }, 400)
  const tags = (c.req.query('tags') || '').split(',').map((value: string) => value.trim()).filter(Boolean)
  const country = c.req.query('country') || undefined
  const isMovieRaw = c.req.query('isMovie')
  const isMovie = isMovieRaw === undefined ? undefined : isMovieRaw === '1' || isMovieRaw === 'true'
  try {
    return c.json({ data: await recommendationsFor(c, subjectId, { tags, country, isMovie }) })
  } catch (error) {
    return c.json({ error: 'upstream', message: error instanceof Error ? error.message : String(error) }, 502)
  }
}

app.get('/api/bangumi/subjects/:id/recommendations', async (c) => recommendationResponse(c, c.req.param('id')))
app.get('/api/bangumi/recommendations', async (c) => recommendationResponse(c, c.req.query('subjectId') || ''))
app.post('/api/bangumi/recommendations', async (c) => {
  type RecommendationRequest = {
    subjectId?: number | string
    tags?: string[]
    country?: string
    isMovie?: boolean
  }
  const body = await c.req.json<RecommendationRequest>().catch(() => ({} as RecommendationRequest))
  const subjectId = Number(body.subjectId)
  if (!Number.isInteger(subjectId) || subjectId <= 0) {
    return c.json({ error: 'bad_request', message: '无效的 subjectId' }, 400)
  }
  try {
    return c.json({
      data: await recommendationsFor(c, subjectId, {
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        country: typeof body.country === 'string' ? body.country : undefined,
        isMovie: typeof body.isMovie === 'boolean' ? body.isMovie : undefined,
      }),
    })
  } catch (error) {
    return c.json({ error: 'upstream', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

function commentItem(raw: Record<string, unknown>, index: number) {
  const user = raw.user && typeof raw.user === 'object' ? raw.user as Record<string, unknown> : {}
  const avatar = user.avatar && typeof user.avatar === 'object' ? user.avatar as Record<string, unknown> : {}
  const updatedAt = raw.updatedAt
  let createdAt = ''
  if (typeof updatedAt === 'number') createdAt = new Date(updatedAt * 1000).toISOString()
  else if (updatedAt) createdAt = String(updatedAt)
  const rate = Number(raw.rate || 0)
  return {
    id: raw.id || `${user.id || user.username || 'anon'}-${index}`,
    source: 'bangumi',
    author: {
      id: user.id || 0,
      username: String(user.username || ''),
      nickname: String(user.nickname || user.username || '匿名用户'),
      avatar: String(avatar.large || avatar.medium || avatar.small || ''),
      userGroup: user.group,
      sign: user.sign,
    },
    content: String(raw.comment || '').trim(),
    ...(rate >= 1 && rate <= 10 ? { rate } : {}),
    createdAt,
    stats: { likeCount: 0, replyCount: 0 },
  }
}

app.get('/api/bangumi/subjects/:id/comments', async (c) => {
  const subjectId = Number(c.req.param('id'))
  if (!Number.isInteger(subjectId) || subjectId <= 0) return c.json({ error: 'bad_request', message: '无效的 subjectId' }, 400)
  const page = Math.max(1, Math.floor(Number(c.req.query('page') || 1)))
  const offset = (page - 1) * 10
  const url = new URL(`${bangumiNextApi(c)}/p1/subjects/${subjectId}/comments`)
  url.searchParams.set('limit', '10')
  url.searchParams.set('offset', String(offset))
  const type = c.req.query('type')
  if (type) url.searchParams.set('type', type)
  try {
    const { response, data } = await upstreamJson(url.toString(), {}, bangumiUserAgent(c))
    if (!response.ok) return c.json({ data: [], total: 0, page, pageSize: 10 })
    const rows = data && typeof data === 'object' && Array.isArray((data as { data?: unknown[] }).data)
      ? (data as { data: unknown[] }).data
      : []
    const comments = rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object')).map(commentItem)
    return c.json({ data: comments, total: Number((data as { total?: number })?.total || comments.length), page, pageSize: 10 })
  } catch (error) {
    return c.json({ error: 'upstream', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

function dandanCredentials(c: { env: WorkerBindings }) {
  return {
    appId: c.env.DANDAN_APP_ID || FALLBACK_DANDAN_APP_ID,
    appSecret: c.env.DANDAN_APP_SECRET || FALLBACK_DANDAN_APP_SECRET,
    fallback: !c.env.DANDAN_APP_ID || !c.env.DANDAN_APP_SECRET,
  }
}

async function dandanGet(c: { env: WorkerBindings }, path: string, query?: Record<string, string>) {
  const credentials = dandanCredentials(c)
  const url = new URL(path, DEFAULT_DANDAN_API)
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value)
  const headers = new Headers({ Accept: 'application/json', 'User-Agent': 'Animaku/1.18.7' })
  headers.set('X-AppId', credentials.appId)
  headers.set('X-AppSecret', credentials.appSecret)
  return upstreamJson(url.toString(), { headers })
}

app.get('/api/danmaku/status', (c) => {
  const credentials = dandanCredentials(c)
  return c.json({ configured: true, usingFallback: credentials.fallback })
})

app.get('/api/danmaku/search', async (c) => {
  const keyword = (c.req.query('keyword') || '').trim()
  if (!keyword) return c.json({ error: 'bad_request', message: '缺少 keyword' }, 400)
  try {
    const { response, data } = await dandanGet(c, '/api/v2/search/anime', { keyword })
    if (!response.ok) return c.json(upstreamError(response, data), 502)
    const animes = data && typeof data === 'object' && Array.isArray((data as { animes?: unknown[] }).animes)
      ? (data as { animes: unknown[] }).animes
      : []
    return c.json({ data: animes.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object')).map((value) => ({
      animeId: Number(value.animeId || 0),
      animeTitle: String(value.animeTitle ?? ''),
      ...(value.bangumiId != null ? { bangumiId: String(value.bangumiId) } : {}),
      ...(value.episodeCount != null ? { episodeCount: Number(value.episodeCount) } : {}),
      ...(value.typeDescription != null ? { typeDescription: String(value.typeDescription) } : {}),
      ...(value.imageUrl != null ? { imageUrl: String(value.imageUrl) } : {}),
    })) })
  } catch (error) {
    return c.json({ error: 'upstream', message: String(error) }, 502)
  }
})

app.get('/api/danmaku/bangumi/:id', async (c) => {
  try {
    const { response, data } = await dandanGet(c, `/api/v2/bangumi/${c.req.param('id')}`)
    if (!response.ok) return c.json(upstreamError(response, data), 502)
    const value = data && typeof data === 'object' ? (data as { bangumi?: unknown }).bangumi : null
    const episodes = ((value as { episodes?: unknown[] } | null)?.episodes || [])
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
      .map((entry) => ({ episodeId: Number(entry.episodeId || 0), episodeTitle: String(entry.episodeTitle ?? '') }))
    return c.json({ data: { bangumiId: Number((value as { animeId?: number } | null)?.animeId || c.req.param('id')), episodes } })
  } catch (error) {
    return c.json({ error: 'upstream', message: String(error) }, 502)
  }
})

app.get('/api/danmaku/bangumi/bgmtv/:bgmId', async (c) => {
  try {
    const { response, data } = await dandanGet(c, `/api/v2/bangumi/bgmtv/${c.req.param('bgmId')}`)
    if (!response.ok) return c.json(upstreamError(response, data), 502)
    const value = data && typeof data === 'object' ? (data as { bangumi?: unknown }).bangumi : null
    const episodes = ((value as { episodes?: unknown[] } | null)?.episodes || [])
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
      .map((entry) => ({ episodeId: Number(entry.episodeId || 0), episodeTitle: String(entry.episodeTitle ?? '') }))
    return c.json({ data: { bangumiId: Number((value as { animeId?: number } | null)?.animeId || 0), episodes } })
  } catch (error) {
    return c.json({ error: 'upstream', message: String(error) }, 502)
  }
})

app.get('/api/danmaku/comment/:episodeId', async (c) => {
  try {
    const { response, data } = await dandanGet(c, `/api/v2/comment/${c.req.param('episodeId')}`, {
      withRelated: c.req.query('withRelated') || 'true',
      chConvert: c.req.query('chConvert') || '1',
    })
    if (!response.ok) return c.json(upstreamError(response, data), 502)
    const comments = data && typeof data === 'object' && Array.isArray((data as { comments?: unknown[] }).comments)
      ? (data as { comments: unknown[] }).comments
      : []
    const normalized = comments.filter((value): value is { m: string; p: string } => Boolean(value && typeof value === 'object' && 'm' in value && 'p' in value)).map((value) => ({ m: String(value.m), p: String(value.p) }))
    const parsed = parseDanmakuComments(normalized)
    return c.json({ data: parsed, count: Number((data as { count?: number })?.count || parsed.length) })
  } catch (error) {
    return c.json({ error: 'upstream', message: String(error) }, 502)
  }
})

const BILIBILI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36'

async function fetchBilibiliFallback(url: string, requestHeaders: Headers): Promise<Response | null> {
  const env = runtime.__ANIMAKU_WORKER_ENV || {}
  const token = env.UPSTREAM_PROXY_TOKEN?.trim()
  let base = env.UPSTREAM_PROXY_URL?.trim().replace(/\/+$/, '') || ''
  if (!token || !base) return null
  base = base.replace(/\/api\/(?:health|egress)$/i, '')

  let endpoint: URL
  try {
    endpoint = new URL(`${base}/api/egress`)
  } catch {
    return null
  }
  if (endpoint.protocol !== 'https:') return null

  const forwarded: Record<string, string> = {}
  for (const name of ['accept', 'accept-language', 'origin', 'referer']) {
    const value = requestHeaders.get(name)
    if (value && value.length <= 1024) forwarded[name] = value
  }

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Egress-Token': token },
      body: JSON.stringify({ url, headers: forwarded }),
      signal: AbortSignal.timeout(25_000),
    })
  } catch {
    return null
  }
  if (response.status === 400 || response.status === 401 || response.status === 404 || response.status === 405 || response.status === 503 || response.status >= 500) {
    await response.body?.cancel()
    return null
  }
  return response
}

async function bilibiliFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('User-Agent', headers.get('User-Agent') || BILIBILI_USER_AGENT)
  headers.set('Referer', headers.get('Referer') || 'https://www.bilibili.com/')
  headers.set('Origin', headers.get('Origin') || 'https://www.bilibili.com')
  headers.set('Accept', headers.get('Accept') || '*/*')
  headers.set('Accept-Language', headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8')
  headers.set('Sec-Fetch-Site', headers.get('Sec-Fetch-Site') || 'same-site')
  headers.set('Sec-Fetch-Mode', headers.get('Sec-Fetch-Mode') || 'cors')
  headers.set('Sec-Fetch-Dest', headers.get('Sec-Fetch-Dest') || 'empty')
  const response = await fetch(url, { ...init, headers })
  if ((response.status === 403 || response.status === 412) && EGRESS_PROXY_HOSTS.has(new URL(url).hostname.toLowerCase())) {
    const fallback = await fetchBilibiliFallback(url, headers)
    if (fallback) {
      await response.body?.cancel()
      return fallback
    }
  }
  return response
}

async function bilibiliJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`B站接口返回非 JSON (${response.status}): ${text.slice(0, 120)}`)
  }
}

async function bilibiliApiJson<T>(url: string): Promise<T> {
  const response = await bilibiliFetch(url)
  return bilibiliJson<T>(response)
}

async function decodeBilibiliDanmaku(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const plain = new TextDecoder().decode(bytes)
  if (plain.includes('<d ') || plain.includes('<i')) return plain
  if (bytes.length < 2) return plain
  const mode = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? 'gzip'
    : bytes[0] === 0x78
      ? 'deflate'
      : null
  if (!mode) return plain
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(mode))
    return await new Response(stream).text()
  } catch {
    return plain
  }
}

async function resolveBilibiliShortLink(url: string) {
  const response = await bilibiliFetch(url, { redirect: 'manual' })
  const location = response.headers.get('Location') || response.url
  await response.body?.cancel()
  return location && location !== url ? parseBilibiliInput(location) : null
}

app.get('/api/danmaku/bilibili', async (c) => {
  configureRuntime(c.env)
  const rawInput = c.req.query('input') || c.req.query('bvid') || c.req.query('bv') || c.req.query('epid') || c.req.query('ep') || c.req.query('ssid') || c.req.query('ss') || c.req.query('aid') || c.req.query('av') || c.req.query('url') || ''
  let target = parseBilibiliInput(rawInput)
  const queryPage = Number(c.req.query('p') ?? c.req.query('page') ?? '-1')
  const queryEpId = Number(c.req.query('epid') || c.req.query('ep') || '0')
  const querySsId = Number(c.req.query('ssid') || c.req.query('ss') || '0')
  const queryMdId = Number(c.req.query('mdid') || c.req.query('md') || c.req.query('mediaId') || '0')
  const queryBgmId = Number(c.req.query('bgm') || c.req.query('bangumiId') || c.req.query('bangumi_id') || c.req.query('bgm_id') || '0')
  const queryAid = Number(c.req.query('aid') || c.req.query('av') || '0')
  if (!target) {
    if (queryEpId > 0) target = { type: 'ep', epId: queryEpId, raw: `ep${queryEpId}` }
    else if (querySsId > 0) target = { type: 'ss', seasonId: querySsId, raw: `ss${querySsId}` }
    else if (queryMdId > 0) target = { type: 'md', mediaId: queryMdId, raw: `md${queryMdId}` }
    else if (queryBgmId > 0) target = { type: 'bgm', bangumiId: queryBgmId, raw: `bgm${queryBgmId}` }
    else if (queryAid > 0) target = { type: 'av', aid: queryAid, raw: `av${queryAid}` }
  }
  if (!target) return c.json({ error: 'bad_request', message: '请提供有效的 B 站链接或标识（支持 BV号 / ep番剧 / ss季度 / av号 / b23短链）' }, 400)

  try {
    if (target.type === 'bgm') {
      const mapped = await getBilibiliTargetByBangumiId(c.env, target.bangumiId)
      if (!mapped?.targetId) {
        return c.json({ data: [], count: 0, meta: { unmapped: true, message: `未在跨站映射库中找到 Bangumi ID ${target.bangumiId} 对应的 B 站番剧` } }, 200)
      }
      const mappedTarget = parseBilibiliInput(mapped.targetId)
      if (mappedTarget && mappedTarget.type !== 'bgm') {
        target = {
          ...mappedTarget,
          page: queryPage >= 0 ? queryPage : mappedTarget.page ?? target.page,
        }
      } else {
        const mediaId = Number.parseInt(mapped.targetId, 10)
        if (!Number.isFinite(mediaId) || mediaId <= 0) {
          return c.json({ data: [], count: 0, meta: { unmapped: true, message: `Bangumi ID ${target.bangumiId} 对应的 B 站映射标识格式无法识别` } }, 200)
        }
        target = { type: 'md', mediaId, page: queryPage >= 0 ? queryPage : target.page, raw: `md${mediaId}` }
      }
    }
    if (target.type === 'b23') {
      const resolved = await resolveBilibiliShortLink(target.url)
      if (!resolved) return c.json({ error: 'bad_request', message: '未能解析该 b23.tv 短链接对应的内容' }, 400)
      target = resolved
    }
    if (target.type === 'md') {
      const apiUrl = `https://api.bilibili.com/pgc/review/user?media_id=${target.mediaId}`
      const data = await bilibiliApiJson<{ result?: { media?: { season_id?: number } } }>(apiUrl)
      const seasonId = Number(data.result?.media?.season_id || 0)
      if (seasonId) target = { type: 'ss', seasonId, page: target.page, raw: `ss${seasonId}` }
      else target = { type: 'ss', seasonId: target.mediaId, page: target.page, raw: `ss${target.mediaId}` }
    }

    let cid = 0
    let title = ''
    let part = ''
    let bvid = ''
    let epId = 0
    let seasonId = 0
    let page = Math.max(1, Number(Number.isFinite(queryPage) && queryPage >= 0 ? queryPage : target.page || 1))
    const pages: Array<{ page: number; cid: number; part: string; epId?: number; bvid?: string }> = []

    if (target.type === 'ep' || target.type === 'ss') {
      const url = target.type === 'ep'
        ? `https://api.bilibili.com/pgc/view/web/season?ep_id=${target.epId}`
        : `https://api.bilibili.com/pgc/view/web/season?season_id=${target.seasonId}`
      const json = await bilibiliApiJson<{ code?: number; message?: string; result?: { title?: string; season_title?: string; season_id?: number; episodes?: Array<Record<string, unknown>>; section?: Array<{ episodes?: Array<Record<string, unknown>> }> } }>(url)
      if (json.code !== 0 || !json.result) throw new Error(json.message || `B站番剧返回 code=${json.code}`)
      title = String(json.result.title || json.result.season_title || '')
      seasonId = Number(json.result.season_id || (target.type === 'ss' ? target.seasonId : 0))
      const main = json.result.episodes || []
      const all = [...main, ...(json.result.section || []).flatMap((section) => section.episodes || [])]
      const requestedEpisodeId = target.type === 'ep' ? target.epId : 0
      const picked = target.type === 'ep'
        ? all.find((episode) => Number(episode.id || episode.ep_id) === requestedEpisodeId)
        : all.find((episode) => String(episode.title || episode.show_title || '') === String(page) || String(episode.title || episode.show_title || '') === String(page).padStart(2, '0')) || main[page - 1] || all[0]
      if (!picked || !Number(picked.cid)) throw new Error('未找到对应剧集或 cid')
      cid = Number(picked.cid)
      bvid = String(picked.bvid || '')
      epId = Number(picked.ep_id || picked.id || 0)
      part = String(picked.show_title || picked.long_title || (picked.title ? `第${picked.title}话` : `P${page}`))
      main.forEach((episode, index) => pages.push({
        page: index + 1,
        cid: Number(episode.cid || 0),
        part: String(episode.show_title || episode.long_title || (episode.title ? `第${episode.title}话` : `P${index + 1}`)),
        epId: Number(episode.ep_id || episode.id || 0),
        bvid: String(episode.bvid || ''),
      }))
    } else if (target.type === 'bv' || target.type === 'av') {
      const url = target.type === 'bv'
        ? `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(target.bvid)}`
        : `https://api.bilibili.com/x/player/pagelist?aid=${target.aid}`
      let data: Array<{ cid: number; page: number; part?: string }> = []
      try {
        const json = await bilibiliApiJson<{ code?: number; data?: Array<{ cid: number; page: number; part?: string }> }>(url)
        if (json.code === 0 && Array.isArray(json.data)) data = json.data
      } catch {
        /* fallback to the heavier view endpoint below */
      }
      if (data.length === 0) {
        const viewUrl = target.type === 'bv'
          ? `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(target.bvid)}`
          : `https://api.bilibili.com/x/web-interface/view?aid=${target.aid}`
        const json = await bilibiliApiJson<{ code?: number; message?: string; data?: { title?: string; bvid?: string; pages?: Array<{ cid: number; page: number; part?: string }> } }>(viewUrl)
        if (json.code !== 0 || !json.data?.pages?.length) throw new Error(json.message || `B站返回 code=${json.code}`)
        title = String(json.data.title || '')
        bvid = String(json.data.bvid || '')
        data = json.data.pages
      }
      const picked = data.find((item) => item.page === page) || data[page - 1] || data[0]
      cid = Number(picked.cid || 0)
      part = String(picked.part || `P${picked.page}`)
      bvid = bvid || (target.type === 'bv' ? target.bvid : '')
      pages.push(...data.map((item) => ({ page: item.page, cid: Number(item.cid), part: String(item.part || `P${item.page}`) })))
    } else {
      return c.json({ data: [], count: 0, meta: { unmapped: true, message: '当前 Worker 暂未内置 Bangumi 到 B 站映射库' } }, 200)
    }

    const xmlUrls = [`https://comment.bilibili.com/${cid}.xml`, `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`]
    let xml = ''
    for (const url of xmlUrls) {
      const response = await bilibiliFetch(url)
      if (!response.ok) continue
      const candidate = await decodeBilibiliDanmaku(response)
      if (candidate.includes('<d ') || candidate.includes('<i')) {
        xml = candidate
        break
      }
    }
    if (!xml) throw new Error('拉取 B 站弹幕失败')
    const comments = parseDanmakuXml(xml)
    return c.json({ data: comments, count: comments.length, meta: { bvid: bvid || undefined, epid: epId || undefined, seasonId: seasonId || undefined, cid, page, title, part, pages } })
  } catch (error) {
    return c.json({ error: 'upstream', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

async function hash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function recordStat(c: { env: WorkerBindings; req: { header: (name: string) => string | undefined } }, id: number, episode: number) {
  const db = c.env.DB
  if (!db) return null
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'anonymous'
  const dedupKey = `${await hash(ip)}:${id}:${episode}`
  const expiresAt = Date.now() + 10 * 60 * 1000
  const dedup = await db.prepare(
    `INSERT INTO stats_view_dedup (dedup_key, expires_at) VALUES (?, ?)
     ON CONFLICT(dedup_key) DO UPDATE SET expires_at = excluded.expires_at
     WHERE stats_view_dedup.expires_at <= ?`,
  ).bind(dedupKey, expiresAt, Date.now()).run()
  const counted = Number(dedup.meta?.changes || 0) > 0
  if (counted) {
    await db.prepare(
      `INSERT INTO anime_play_counts (bangumi_id, play_count, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(bangumi_id) DO UPDATE SET play_count = play_count + 1, updated_at = excluded.updated_at`,
    ).bind(id, Date.now()).run()
  }
  const row = await db.prepare('SELECT play_count FROM anime_play_counts WHERE bangumi_id = ?').bind(id).first<{ play_count: number }>()
  const total = Number(row?.play_count || 0)
  return { counted, total }
}

app.post('/api/stats/view', async (c) => {
  const body = (await c.req.json<{ bangumiId?: number; episode?: number }>().catch(() => ({}))) as { bangumiId?: number; episode?: number }
  const id = Number(body.bangumiId)
  const episode = Math.max(0, Math.trunc(Number(body.episode) || 0))
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'bad_request', message: '无效的 bangumiId' }, 400)
  try {
    const result = await recordStat(c, id, episode)
    if (!result) return c.json({ error: 'database_unavailable', message: 'Worker 未绑定 D1 数据库' }, 503)
    return c.json({ success: true, playCount: result.total, totalPlayCount: result.total, deduped: !result.counted })
  } catch (error) {
    return c.json({ error: 'database_error', message: String(error) }, 500)
  }
})

app.get('/api/stats/subject/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'bad_request', message: '无效的番剧 ID' }, 400)
  if (!c.env.DB) return c.json({ error: 'database_unavailable', message: 'Worker 未绑定 D1 数据库' }, 503)
  const row = await c.env.DB.prepare('SELECT play_count FROM anime_play_counts WHERE bangumi_id = ?').bind(id).first<{ play_count: number }>()
  return c.json({ data: { bangumiId: id, totalPlayCount: Number(row?.play_count || 0), episodePlayCounts: {} } })
})

app.get('/api/stats/rank/top', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100)
  if (!c.env.DB) return c.json({ data: [] })
  const result = await c.env.DB.prepare(
    'SELECT bangumi_id, play_count FROM anime_play_counts ORDER BY play_count DESC LIMIT ?',
  ).bind(limit).all<{ bangumi_id: number; play_count: number }>()
  return c.json({
    data: (result.results || []).map((row) => ({
      bangumiId: Number(row.bangumi_id),
      totalPlayCount: Number(row.play_count),
    })),
  })
})

app.get('/api/plugin/validate', (c) => c.json({ error: 'method_not_allowed', message: '请使用 POST' }, 405))
app.post('/api/plugin/validate', async (c) => {
  try {
    return c.json({ ok: true, rule: parsePluginRule(await c.req.json()) })
  } catch (error) {
    return c.json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.post('/api/plugin/search', async (c) => {
  const body = (await c.req.json<{ rule?: unknown; keyword?: string }>().catch(() => ({}))) as { rule?: unknown; keyword?: string }
  if (!body.rule || !body.keyword?.trim()) return c.json({ error: 'bad_request', message: '缺少 rule 或 keyword' }, 400)
  try {
    const { searchWithRule } = await getRuleEngine(c.env)
    return c.json({ data: await searchWithRule(body.rule, body.keyword.trim()) })
  } catch (error) {
    return c.json({ error: 'search_failed', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.post('/api/plugin/chapters', async (c) => {
  const body = (await c.req.json<{ rule?: unknown; source?: string }>().catch(() => ({}))) as { rule?: unknown; source?: string }
  if (!body.rule || !body.source?.trim()) return c.json({ error: 'bad_request', message: '缺少 rule 或 source' }, 400)
  try {
    const { chaptersWithRule } = await getRuleEngine(c.env)
    return c.json({ data: await chaptersWithRule(body.rule, body.source.trim()) })
  } catch (error) {
    return c.json({ error: 'chapter_failed', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.post('/api/plugin/resolve', async (c) => {
  const body = (await c.req.json<{ rule?: unknown; pageUrl?: string }>().catch(() => ({}))) as { rule?: unknown; pageUrl?: string }
  if (!body.rule || !body.pageUrl?.trim()) return c.json({ error: 'bad_request', message: '缺少 rule 或 pageUrl' }, 400)
  try {
    const { resolvePlay } = await getRuleEngine(c.env)
    return c.json({ data: await resolvePlay(body.rule, body.pageUrl.trim()) })
  } catch (error) {
    return c.json({ error: 'resolve_failed', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.get('/api/source/list', (c) => c.json({
  data: [
    { id: 'xifan-next', name: '稀饭Next', tier: 'tier_a' },
    { id: 'xifan', name: '稀饭动漫', tier: 'tier_a' },
    { id: 'cycani', name: '次元城动画', tier: 'tier_a' },
    { id: 'moonci', name: '月之祠', tier: 'tier_a' },
    { id: 'tvtfun', name: 'TvTFun', tier: 'tier_a' },
    { id: 'anime1', name: 'Anime1', tier: 'tier_b' },
    { id: 'animoe', name: 'Animoe', tier: 'tier_a' },
  ],
}))

app.post('/api/source/search', async (c) => {
  const body = (await c.req.json<{ source?: string; keyword?: string }>().catch(() => ({}))) as { source?: string; keyword?: string }
  if (!body.source?.trim() || !body.keyword?.trim()) return c.json({ error: 'bad_request', message: '缺少 source 或 keyword' }, 400)
  try {
    const { sourceRegistry } = await getSourceRegistry(c.env)
    return c.json({ data: await sourceRegistry.search(body.source.trim(), body.keyword.trim()) })
  } catch (error) {
    return c.json({ error: 'search_failed', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.post('/api/source/chapters', async (c) => {
  const body = (await c.req.json<{ source?: string; url?: string }>().catch(() => ({}))) as { source?: string; url?: string }
  if (!body.source?.trim() || !body.url?.trim()) return c.json({ error: 'bad_request', message: '缺少 source 或 url' }, 400)
  try {
    const { sourceRegistry } = await getSourceRegistry(c.env)
    return c.json({ data: await sourceRegistry.chapters(body.source.trim(), body.url.trim()) })
  } catch (error) {
    return c.json({ error: 'chapter_failed', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.post('/api/source/resolve', async (c) => {
  const body = (await c.req.json<{ source?: string; pageUrl?: string }>().catch(() => ({}))) as { source?: string; pageUrl?: string }
  if (!body.source?.trim() || !body.pageUrl?.trim()) return c.json({ error: 'bad_request', message: '缺少 source 或 pageUrl' }, 400)
  try {
    const { sourceRegistry } = await getSourceRegistry(c.env)
    return c.json({ data: await sourceRegistry.resolveAndRegister(body.source.trim(), body.pageUrl.trim()) })
  } catch (error) {
    return c.json({ error: 'resolve_failed', message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

function copyMediaHeaders(source: Response): Headers {
  const headers = new Headers()
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
    const value = source.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('Access-Control-Allow-Origin', '*')
  return headers
}

async function issueMediaChild(
  registry: Awaited<ReturnType<typeof getPlayback>>,
  parent: PlaybackAsset,
  url: string,
) {
  const credentials = registry.playbackRegistry.getDecryptedCredentials<string | Record<string, string>>(parent)
  const asset = registry.playbackRegistry.registerAsset({
    source: parent.source,
    baseUrl: url,
    trustLevel: parent.trustLevel,
    publicHeaders: parent.publicHeaders,
    credentials: credentials || undefined,
  })
  const ticket = registry.playbackRegistry.issueTicket({ aid: asset.assetId, src: asset.source, typ: 'segment', sub: '' })
  return `/api/media/segment?t=${encodeURIComponent(ticket)}`
}

async function rewritePlaylist(
  text: string,
  currentUrl: string,
  parent: PlaybackAsset,
  registry: Awaited<ReturnType<typeof getPlayback>>,
) {
  const lines = text.split(/\r?\n/)
  const output: string[] = []
  for (const line of lines) {
    if (line.includes('URI="')) {
      let next = line
      const matches = [...line.matchAll(/URI="([^"]+)"/g)]
      for (const match of matches) {
        const absolute = new URL(match[1], currentUrl).href
        const proxy = await issueMediaChild(registry, parent, absolute)
        next = next.replace(`URI="${match[1]}"`, `URI="${proxy}"`)
      }
      output.push(next)
    } else if (line.trim() && !line.trim().startsWith('#')) {
      const absolute = new URL(line.trim(), currentUrl).href
      output.push(await issueMediaChild(registry, parent, absolute))
    } else {
      output.push(line)
    }
  }
  return output.join('\n')
}

async function handleMedia(c: any, expectedType?: 'playlist' | 'segment') {
  const token = c.req.query('t')
  if (!token) return c.json({ error: 'bad_request', message: '缺少播放票据' }, 400)
  try {
    const registry = await getPlayback(c.env)
    const verified = registry.playbackRegistry.verifyTicket(token, expectedType)
    if (!verified.valid) return c.json({ error: 'forbidden', message: verified.reason || '播放票据无效' }, 403)
    const asset = verified.asset
    const url = registry.playbackRegistry.resolveAssetUrl(asset, verified.normalizedSub)
    const headers = new Headers(asset.publicHeaders)
    const credentials = registry.playbackRegistry.getDecryptedCredentials<string | Record<string, string>>(asset)
    if (typeof credentials === 'string') headers.set('Cookie', credentials)
    else if (credentials) for (const [key, value] of Object.entries(credentials)) headers.set(key, value)
    for (const name of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
      const value = c.req.header(name)
      if (value) headers.set(name, value)
    }
    const upstream = await fetch(url, { headers, redirect: 'follow' })
    if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: copyMediaHeaders(upstream) })
    const contentType = upstream.headers.get('content-type') || ''
    if (contentType.includes('mpegurl') || /\.m3u8(?:\?|$)/i.test(url)) {
      const text = await upstream.text()
      const rewritten = await rewritePlaylist(text, url, asset, registry)
      const responseHeaders = copyMediaHeaders(upstream)
      responseHeaders.set('content-type', 'application/vnd.apple.mpegurl; charset=utf-8')
      responseHeaders.delete('content-length')
      return new Response(rewritten, { status: 200, headers: responseHeaders })
    }
    return new Response(upstream.body, { status: upstream.status, headers: copyMediaHeaders(upstream) })
  } catch (error) {
    return c.json({ error: 'media_failed', message: error instanceof Error ? error.message : String(error) }, 502)
  }
}

app.get('/api/media/stream', (c) => handleMedia(c, 'playlist'))
app.get('/api/media/segment', (c) => handleMedia(c, 'segment'))
app.get('/api/media/status', (c) => c.body(null, 204))
app.get('/api/media/proxy', (c) => c.json({
  error: 'bad_request',
  message: c.req.query('url') !== undefined
    ? '开放式 url 代理已被彻底禁用，请切换至受控网关 /api/media/stream?t=...'
    : '请使用 /api/media/stream?t=... 播放媒体流',
}, 400))

app.get('/api/site/config', async (c) => {
  if (!c.env.DB) return c.json({ ok: true, ...defaultSiteConfig })
  const row = await c.env.DB.prepare('SELECT value FROM site_config WHERE key = ?').bind('public').first<{ value: string }>()
  let value: Record<string, unknown> = {}
  try { value = row?.value ? JSON.parse(row.value) : {} } catch { /* use defaults */ }
  return c.json({ ok: true, ...defaultSiteConfig, ...value })
})

app.get('/api/site/favicon', async (c) => {
  if (c.env.DB) {
    const row = await c.env.DB.prepare('SELECT value FROM site_config WHERE key = ?').bind('public').first<{ value: string }>()
    try {
      const value = row?.value ? JSON.parse(row.value) as Record<string, unknown> : {}
      if (value.iconMode === 'url' && typeof value.iconUrl === 'string' && value.iconUrl) {
        return c.redirect(value.iconUrl, 302)
      }
    } catch { /* use the official 404 fallback */ }
  }
  return c.text('No custom icon', 404)
})

function accountDb(c: { env: WorkerBindings }): AccountDatabase | null {
  return c.env.DB ? (c.env.DB as unknown as AccountDatabase) : null
}

app.get('/api/account/me', async (c) => {
  const db = accountDb(c)
  if (!db) return c.json({ ok: true, user: null, available: false })
  try {
    const user = await findSessionUser(db, readSessionToken(c.req.header('Cookie')))
    return c.json({ ok: true, user, available: true })
  } catch (error) {
    return c.json({ ok: false, error: 'account_unavailable', message: error instanceof Error ? error.message : String(error) }, 503)
  }
})

app.post('/api/account/register', async (c) => {
  if (!isRegistrationEnabled(c.env.ACCOUNT_REGISTRATION_ENABLED)) {
    return c.json({ ok: false, error: 'registration_disabled', message: '当前未开放注册' }, 403)
  }
  const db = accountDb(c)
  if (!db) return c.json({ ok: false, error: 'database_unavailable', message: '账号数据库暂不可用' }, 503)
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const username = normalizeUsername(body.username)
  const password = typeof body.password === 'string' ? body.password : ''
  const usernameError = validateUsername(username)
  if (usernameError) return c.json({ ok: false, error: 'invalid_username', message: usernameError }, 400)
  const passwordError = validatePassword(password)
  if (passwordError) return c.json({ ok: false, error: 'invalid_password', message: passwordError }, 400)
  if (await findStoredUser(db, username)) {
    return c.json({ ok: false, error: 'username_taken', message: '用户名已被使用' }, 409)
  }
  try {
    const user = await insertUser(db, username, await hashPassword(password))
    const token = await createSession(db, user.id, c.req.header('User-Agent'))
    c.header('Set-Cookie', sessionCookie(token))
    return c.json({ ok: true, user: toPublicUser(user) }, 201)
  } catch (error) {
    // A concurrent registration can win the unique constraint after the
    // preflight lookup; expose the same friendly error in that case.
    if (String(error).toLowerCase().includes('unique')) {
      return c.json({ ok: false, error: 'username_taken', message: '用户名已被使用' }, 409)
    }
    return c.json({ ok: false, error: 'account_unavailable', message: '注册失败，请稍后重试' }, 503)
  }
})

app.post('/api/account/login', async (c) => {
  const db = accountDb(c)
  if (!db) return c.json({ ok: false, error: 'database_unavailable', message: '账号数据库暂不可用' }, 503)
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const username = normalizeUsername(body.username)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!username || !password) return c.json({ ok: false, error: 'invalid_credentials', message: '请输入用户名和密码' }, 400)
  const user = await findStoredUser(db, username)
  if (!user || user.disabled || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ ok: false, error: 'invalid_credentials', message: '用户名或密码错误' }, 401)
  }
  const now = Date.now()
  await db.prepare('UPDATE account_users SET last_login_at = ?, updated_at = ? WHERE id = ?').bind(now, now, user.id).run()
  const token = await createSession(db, user.id, c.req.header('User-Agent'))
  c.header('Set-Cookie', sessionCookie(token))
  return c.json({ ok: true, user: toPublicUser(user) })
})

app.post('/api/account/logout', async (c) => {
  const db = accountDb(c)
  if (db) await deleteSession(db, readSessionToken(c.req.header('Cookie')))
  c.header('Set-Cookie', clearedSessionCookie())
  return c.json({ ok: true })
})

app.post('/api/account/change-password', async (c) => {
  const db = accountDb(c)
  if (!db) return c.json({ ok: false, error: 'database_unavailable', message: '账号数据库暂不可用' }, 503)
  const token = readSessionToken(c.req.header('Cookie'))
  const user = await findSessionUser(db, token)
  if (!user) return c.json({ ok: false, error: 'unauthorized', message: '请先登录' }, 401)
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
  const passwordError = validatePassword(newPassword)
  if (passwordError) return c.json({ ok: false, error: 'invalid_password', message: passwordError }, 400)
  const stored = await db.prepare('SELECT id, username, username_key, password_hash, role, disabled, created_at FROM account_users WHERE id = ? LIMIT 1').bind(user.id).first<{
    id: string
    username: string
    username_key: string
    password_hash: string
    role: 'user' | 'admin'
    disabled: number
    created_at: number
  }>()
  if (!stored || !(await verifyPassword(currentPassword, stored.password_hash))) {
    return c.json({ ok: false, error: 'invalid_credentials', message: '当前密码错误' }, 401)
  }
  const now = Date.now()
  await db.prepare('UPDATE account_users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(await hashPassword(newPassword), now, user.id).run()
  await db.prepare('DELETE FROM account_sessions WHERE user_id = ?').bind(user.id).run()
  const newToken = await createSession(db, user.id, c.req.header('User-Agent'))
  c.header('Set-Cookie', sessionCookie(newToken))
  return c.json({ ok: true, user })
})

async function requireAccountUser(c: { env: WorkerBindings; req: { header: (name: string) => string | undefined } }): Promise<{ db: AccountDatabase; user: NonNullable<Awaited<ReturnType<typeof findSessionUser>>> } | null> {
  const db = c.env.DB ? (c.env.DB as unknown as AccountDatabase) : null
  if (!db) return null
  const user = await findSessionUser(db, readSessionToken(c.req.header('Cookie')))
  return user ? { db, user } : null
}

const ACCOUNT_DATA_KEYS = new Set([
  'animaku-settings',
  'animaku-history',
  'animaku-plugins',
  'animaku-search-history',
  'animaku-watched-episodes',
  'animaku-source-bindings',
  'animaku:custom-oped-marks',
  'kz-settings-open-sections',
])

function sanitizeAccountData(value: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!ACCOUNT_DATA_KEYS.has(key)) continue
    if (key === 'animaku-settings' && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const settings = { ...(raw as Record<string, unknown>) }
      if (settings.state && typeof settings.state === 'object' && !Array.isArray(settings.state)) {
        settings.state = { ...(settings.state as Record<string, unknown>) }
        delete (settings.state as Record<string, unknown>).bangumiToken
      }
      delete settings.bangumiToken
      clean[key] = settings
    } else {
      clean[key] = raw
    }
  }
  return clean
}

app.get('/api/account/data', async (c) => {
  const context = await requireAccountUser(c)
  if (!context) {
    return c.env.DB
      ? c.json({ ok: false, error: 'unauthorized', message: '请先登录' }, 401)
      : c.json({ ok: false, error: 'database_unavailable', message: '账号数据库暂不可用' }, 503)
  }
  const row = await context.db.prepare('SELECT payload, version, updated_at FROM account_data WHERE user_id = ? LIMIT 1').bind(context.user.id).first<{ payload: string; version: number; updated_at: number }>()
  let data: Record<string, unknown> = {}
  try {
    const parsed = row?.payload ? JSON.parse(row.payload) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = sanitizeAccountData(parsed as Record<string, unknown>)
  } catch { /* use empty payload */ }
  return c.json({ ok: true, data, version: row?.version || 1, updatedAt: row?.updated_at || 0 })
})

app.put('/api/account/data', async (c) => {
  const context = await requireAccountUser(c)
  if (!context) {
    return c.env.DB
      ? c.json({ ok: false, error: 'unauthorized', message: '请先登录' }, 401)
      : c.json({ ok: false, error: 'database_unavailable', message: '账号数据库暂不可用' }, 503)
  }
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const data = body.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return c.json({ ok: false, error: 'invalid_data', message: '云端数据格式无效' }, 400)
  }
  const cleanData = sanitizeAccountData(data as Record<string, unknown>)
  let payload: string
  try {
    payload = JSON.stringify(cleanData)
  } catch {
    return c.json({ ok: false, error: 'invalid_data', message: '云端数据无法序列化' }, 400)
  }
  if (new TextEncoder().encode(payload).byteLength > 800_000) {
    return c.json({ ok: false, error: 'data_too_large', message: '云端数据超过 800KB 限制' }, 413)
  }
  const now = Date.now()
  await context.db.prepare(
    `INSERT INTO account_data (user_id, payload, version, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, version = account_data.version + 1, updated_at = excluded.updated_at`,
  ).bind(context.user.id, payload, now).run()
  const saved = await context.db.prepare('SELECT version FROM account_data WHERE user_id = ? LIMIT 1').bind(context.user.id).first<{ version: number }>()
  return c.json({ ok: true, version: saved?.version || 1, updatedAt: now })
})

function isAdmin(c: { env: WorkerBindings; req: { header: (name: string) => string | undefined } }) {
  return Boolean(c.env.ADMIN_SECRET && c.req.header('X-Admin-Secret') === c.env.ADMIN_SECRET)
}

app.post('/api/admin/verify', (c) => isAdmin(c) ? c.json({ ok: true }) : c.json({ ok: false, error: 'unauthorized' }, 401))
app.get('/api/admin/accounts', async (c) => {
  if (!isAdmin(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  if (!c.env.DB) return c.json({ ok: false, error: 'database_unavailable' }, 503)
  const result = await c.env.DB.prepare(
    `SELECT id, username, role, disabled, created_at, last_login_at
       FROM account_users
      ORDER BY created_at DESC
      LIMIT 500`,
  ).all<{
    id: string
    username: string
    role: 'user' | 'admin'
    disabled: number
    created_at: number
    last_login_at: number | null
  }>()
  return c.json({ ok: true, users: (result.results || []).map((user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at || null,
  })) })
})
app.post('/api/admin/accounts/:id/status', async (c) => {
  if (!isAdmin(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  if (!c.env.DB) return c.json({ ok: false, error: 'database_unavailable' }, 503)
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const disabled = Boolean(body.disabled)
  const result = await c.env.DB.prepare('UPDATE account_users SET disabled = ?, updated_at = ? WHERE id = ?').bind(disabled ? 1 : 0, Date.now(), c.req.param('id')).run()
  if (!Number(result.meta?.changes || 0)) return c.json({ ok: false, error: 'not_found', message: '账号不存在' }, 404)
  return c.json({ ok: true, disabled })
})
app.delete('/api/admin/accounts/:id', async (c) => {
  if (!isAdmin(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  if (!c.env.DB) return c.json({ ok: false, error: 'database_unavailable' }, 503)
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM account_sessions WHERE user_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM account_data WHERE user_id = ?').bind(id).run()
  const result = await c.env.DB.prepare('DELETE FROM account_users WHERE id = ?').bind(id).run()
  if (!Number(result.meta?.changes || 0)) return c.json({ ok: false, error: 'not_found', message: '账号不存在' }, 404)
  return c.json({ ok: true })
})
app.post('/api/admin/site/config', async (c) => {
  if (!isAdmin(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  if (!c.env.DB) return c.json({ ok: false, error: 'database_unavailable' }, 503)
  const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>
  const value = {
    siteName: typeof body.siteName === 'string' ? body.siteName.trim().slice(0, 50) : '',
    siteTagline: typeof body.siteTagline === 'string' ? body.siteTagline.trim().slice(0, 100) : '',
    iconMode: ['default', 'upload', 'url'].includes(String(body.iconMode)) ? String(body.iconMode) : 'default',
    iconUrl: typeof body.iconUrl === 'string' ? body.iconUrl.trim().slice(0, 500) : '',
    iconUpdatedAt: Date.now(),
  }
  await c.env.DB.prepare('INSERT INTO site_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind('public', JSON.stringify(value), Date.now()).run()
  return c.json({ ok: true, data: value, message: '站点配置已更新' })
})

app.all('/api/admin/site/upload-icon', (c) => c.json({ ok: false, error: 'not_ready', message: '图标上传需要 R2，当前版本使用 Assets 默认图标' }, 501))
app.post('/api/admin/site/reset-icon', async (c) => {
  if (!isAdmin(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  if (c.env.DB) await c.env.DB.prepare('DELETE FROM site_config WHERE key = ?').bind('public').run()
  return c.json({ ok: true, ...defaultSiteConfig })
})
app.post('/api/admin/site/reset-all', async (c) => {
  if (!isAdmin(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  if (c.env.DB) await c.env.DB.prepare('DELETE FROM site_config WHERE key = ?').bind('public').run()
  return c.json({ ok: true, data: defaultSiteConfig })
})

app.get('/play/:id', (c) => {
  const id = c.req.param('id')
  const url = new URL(c.req.url)
  return c.redirect(`/subject/${id}${url.search}`, 301)
})

type AssetContext = { req: { raw: Request; url: string } }

async function serveAssets(c: AssetContext, env: WorkerBindings): Promise<Response> {
  if (!env.ASSETS) return new Response('Cloudflare Assets binding is missing', { status: 503 })
  const direct = await env.ASSETS.fetch(c.req.raw)
  if (direct.status !== 404) return direct
  const url = new URL(c.req.url)
  if (url.pathname.includes('.')) return direct
  url.pathname = '/index.html'
  return env.ASSETS.fetch(new Request(url, c.req.raw))
}

app.all('*', (c) => serveAssets(c, c.env))

export default app
