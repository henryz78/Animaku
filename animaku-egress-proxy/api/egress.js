import { timingSafeEqual } from 'node:crypto'
import { validateTarget } from '../lib/allowlist.js'

export const config = { maxDuration: 60 }

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 25_000
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'origin', 'referer']

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  return res.end(JSON.stringify(value))
}

function suppliedToken(req) {
  const direct = req.headers['x-egress-token']
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, '').trim()
  }
  return ''
}

function tokenMatches(actual, expected) {
  if (!actual || !expected) return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return null }
}

async function readLimitedBody(response) {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      const chunk = part.value || new Uint8Array()
      total += chunk.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('upstream response is larger than 8 MB')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return json(res, 405, { error: 'method_not_allowed', message: '请使用 POST' })
  }

  const expectedToken = process.env.PROXY_TOKEN || ''
  if (!expectedToken) return json(res, 503, { error: 'proxy_not_configured', message: 'PROXY_TOKEN 未配置' })
  if (!tokenMatches(suppliedToken(req), expectedToken)) return json(res, 401, { error: 'unauthorized', message: '代理鉴权失败' })

  const body = await readJsonBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, 400, { error: 'bad_request', message: '请求体必须是 JSON 对象' })
  }

  const target = validateTarget(body.url)
  if (!target.ok) return json(res, 400, { error: 'target_not_allowed', message: target.reason })

  const headers = new Headers({ 'User-Agent': 'Animaku-Egress-Proxy/1.0', Accept: '*/*' })
  if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = body.headers[name]
      if (typeof value === 'string' && value.length <= 1024) headers.set(name, value)
    }
  }

  let upstream
  try {
    upstream = await fetch(target.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return json(res, 502, { error: 'upstream_fetch_failed', message: error instanceof Error ? error.message : String(error) })
  }

  const finalTarget = validateTarget(upstream.url || target.url)
  if (!finalTarget.ok) {
    await upstream.body?.cancel()
    return json(res, 502, { error: 'upstream_redirect_not_allowed', message: finalTarget.reason })
  }

  const declaredLength = Number(upstream.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await upstream.body?.cancel()
    return json(res, 413, { error: 'upstream_too_large', message: '上游响应超过 8 MB 限制' })
  }

  let bytes
  try {
    bytes = await readLimitedBody(upstream)
  } catch (error) {
    return json(res, 413, { error: 'upstream_too_large', message: error instanceof Error ? error.message : String(error) })
  }

  res.status(upstream.status)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Egress-Upstream-Status', String(upstream.status))
  res.setHeader('Content-Length', String(bytes.byteLength))
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream')
  return res.end(Buffer.from(bytes))
}
