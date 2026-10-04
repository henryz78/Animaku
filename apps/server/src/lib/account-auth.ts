/**
 * Small, provider-independent account layer for the Cloudflare deployment.
 *
 * Bangumi authentication remains separate from this module. The account
 * session is an opaque, short-lived database-backed cookie; only a SHA-256
 * digest of the cookie is stored in D1. Passwords use PBKDF2-SHA-256 and a
 * per-user random salt so this table never contains a reversible password.
 */

export type AccountStatement = {
  bind: (...values: unknown[]) => AccountStatement
  first: <T = unknown>() => Promise<T | null>
  all: <T = unknown>() => Promise<{ results?: T[]; meta?: { changes?: number } }>
  run: () => Promise<{ meta?: { changes?: number } }>
}

export type AccountDatabase = {
  prepare: (sql: string) => AccountStatement
}

export type AccountUser = {
  id: string
  username: string
  role: 'user' | 'admin'
  createdAt: number
}

type StoredUser = {
  id: string
  username: string
  username_key: string
  password_hash: string
  role: 'user' | 'admin'
  disabled: number
  created_at: number
}

// Cloudflare Workers currently caps PBKDF2 at 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000
export const ACCOUNT_SESSION_COOKIE = 'animaku_session'
export const ACCOUNT_SESSION_MAX_AGE = 60 * 60 * 24 * 30

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(digest))
}

export function isConfiguredAdminUsername(username: string, configuredUsername?: string): boolean {
  const configured = normalizeUsername(configuredUsername)
  return Boolean(configured && usernameKey(username) === usernameKey(configured))
}

function toPublicUser(
  row: Pick<StoredUser, 'id' | 'username' | 'role' | 'created_at'>,
  configuredAdminUsername?: string,
): AccountUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role === 'admin' || isConfiguredAdminUsername(row.username, configuredAdminUsername) ? 'admin' : 'user',
    createdAt: row.created_at,
  }
}

export function normalizeUsername(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function usernameKey(value: string): string {
  return value.toLocaleLowerCase('en-US')
}

export function validateUsername(value: string): string | null {
  if (value.length < 3 || value.length > 32) return '用户名需要 3 到 32 个字符'
  if (!/^[\p{L}\p{N}_.-]+$/u.test(value)) return '用户名只能包含字母、数字、下划线、点和短横线'
  return null
}

export function validatePassword(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 8) return '密码至少需要 8 个字符'
  if (value.length > 128) return '密码不能超过 128 个字符'
  return null
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return `pbkdf2$${PASSWORD_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(new Uint8Array(bits))}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsRaw, saltRaw, expectedRaw] = encoded.split('$')
  const iterations = Number(iterationsRaw)
  if (algorithm !== 'pbkdf2' || !Number.isInteger(iterations) || iterations < 50_000 || !saltRaw || !expectedRaw) {
    return false
  }
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    )
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: base64UrlToBytes(saltRaw) as unknown as BufferSource, iterations, hash: 'SHA-256' },
      key,
      256,
    )
    const actual = bytesToBase64Url(new Uint8Array(bits))
    return actual === expectedRaw
  } catch {
    return false
  }
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === ACCOUNT_SESSION_COOKIE) {
      const value = rest.join('=').trim()
      return value || null
    }
  }
  return null
}

export function sessionCookie(token: string): string {
  return `${ACCOUNT_SESSION_COOKIE}=${token}; Path=/; Max-Age=${ACCOUNT_SESSION_MAX_AGE}; HttpOnly; SameSite=Lax; Secure`
}

export function clearedSessionCookie(): string {
  return `${ACCOUNT_SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Secure`
}

export async function createSession(
  db: AccountDatabase,
  userId: string,
  userAgent?: string,
): Promise<string> {
  const token = bytesToBase64Url(randomBytes(32))
  const tokenHash = await sha256(token)
  const now = Date.now()
  await db.prepare(
    `INSERT INTO account_sessions
      (session_hash, user_id, expires_at, created_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(tokenHash, userId, now + ACCOUNT_SESSION_MAX_AGE * 1000, now, now, (userAgent || '').slice(0, 300)).run()
  return token
}

export async function findSessionUser(
  db: AccountDatabase,
  token: string | null,
  configuredAdminUsername?: string,
): Promise<AccountUser | null> {
  if (!token) return null
  const tokenHash = await sha256(token)
  const row = await db.prepare(
    `SELECT u.id, u.username, u.role, u.created_at
       FROM account_sessions s
       JOIN account_users u ON u.id = s.user_id
      WHERE s.session_hash = ?
        AND s.expires_at > ?
        AND u.disabled = 0
      LIMIT 1`,
  ).bind(tokenHash, Date.now()).first<Pick<StoredUser, 'id' | 'username' | 'role' | 'created_at'>>()
  if (!row) return null
  // This update is intentionally best-effort; a read should not fail because
  // a busy D1 replica could not update the activity timestamp.
  void db.prepare('UPDATE account_sessions SET last_seen_at = ? WHERE session_hash = ?').bind(Date.now(), tokenHash).run().catch(() => undefined)
  return toPublicUser(row, configuredAdminUsername)
}

export async function deleteSession(db: AccountDatabase, token: string | null): Promise<void> {
  if (!token) return
  const tokenHash = await sha256(token)
  await db.prepare('DELETE FROM account_sessions WHERE session_hash = ?').bind(tokenHash).run()
}

export async function findStoredUser(db: AccountDatabase, username: string): Promise<StoredUser | null> {
  return db.prepare('SELECT id, username, username_key, password_hash, role, disabled, created_at FROM account_users WHERE username_key = ? LIMIT 1').bind(usernameKey(username)).first<StoredUser>()
}

export async function insertUser(
  db: AccountDatabase,
  username: string,
  passwordHash: string,
): Promise<StoredUser> {
  const user: StoredUser = {
    id: crypto.randomUUID(),
    username,
    username_key: usernameKey(username),
    password_hash: passwordHash,
    role: 'user',
    disabled: 0,
    created_at: Date.now(),
  }
  await db.prepare(
    `INSERT INTO account_users
      (id, username, username_key, password_hash, role, disabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(user.id, user.username, user.username_key, user.password_hash, user.role, user.disabled, user.created_at, user.created_at).run()
  return user
}

export function isRegistrationEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase())
}

export { toPublicUser }
