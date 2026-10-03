export const ALLOWED_HOSTS = Object.freeze([
  'api.bilibili.com',
  'www.bilibili.com',
  'animoe.org',
  'www.animoe.org',
  'tvtfun.net',
  'www.tvtfun.net',
])

const ALLOWED_HOST_SET = new Set(ALLOWED_HOSTS)

export function validateTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 4096) {
    return { ok: false, reason: 'url must be a non-empty string up to 4096 characters' }
  }

  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'url is invalid' }
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (url.protocol !== 'https:') return { ok: false, reason: 'only https targets are allowed' }
  if (url.username || url.password) return { ok: false, reason: 'credentials in target URLs are not allowed' }
  if (url.port && url.port !== '443') return { ok: false, reason: 'only the default HTTPS port is allowed' }
  if (!ALLOWED_HOST_SET.has(hostname)) return { ok: false, reason: `target host is not allowlisted: ${hostname}` }

  url.hostname = hostname
  return { ok: true, url }
}
