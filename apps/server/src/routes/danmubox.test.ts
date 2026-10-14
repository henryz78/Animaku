import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  decryptDanmuBoxCipher,
  searchDanmuBox,
} from '../lib/danmubox/index'
import { sanitizeFileHash } from '../lib/danmubox/archive'
import {
  DANMUBOX_CDN_S_MAXAGE_SEC,
  DANMUBOX_BROWSER_MAXAGE_SEC,
  setDanmuBoxCdnHeaders,
} from '../lib/cdn-cache-headers'

const KEY = Buffer.from('jQoRm5OREM7S3qy3ZBgFV8EqPAP6jsZJ', 'utf8')

test('decryptDanmuBoxCipher correctly decrypts AES-256-ECB ciphertext', () => {
  const plainText = '寒蝉（两季+猫杀篇+礼+煌+扩）,2973877,0,02/58689a5b89a3195d6d1ef16458d376c6;'
  const cipher = crypto.createCipheriv('aes-256-ecb', KEY, null)
  cipher.setAutoPadding(true)
  let encrypted = cipher.update(plainText, 'utf8', 'base64')
  encrypted += cipher.final('base64')

  const decrypted = decryptDanmuBoxCipher(encrypted)
  assert.equal(decrypted, plainText)
})

test('sanitizeFileHash replaces path separators safely for disk storage', () => {
  assert.equal(
    sanitizeFileHash('02/58689a5b89a3195d6d1ef16458d376c6'),
    '02_58689a5b89a3195d6d1ef16458d376c6',
  )
  assert.equal(
    sanitizeFileHash('subdir\\nested\\hash'),
    'subdir_nested_hash',
  )
})

test('setDanmuBoxCdnHeaders emits 30-day edge TTL and immutable headers', () => {
  const headers = new Map<string, string>()
  const mockContext = {
    header: (name: string, value: string) => {
      headers.set(name, value)
    },
  }

  setDanmuBoxCdnHeaders(mockContext, false)
  const cc = headers.get('Cache-Control')
  assert.ok(cc?.includes(`s-maxage=${DANMUBOX_CDN_S_MAXAGE_SEC}`))
  assert.ok(cc?.includes(`max-age=${DANMUBOX_BROWSER_MAXAGE_SEC}`))
  assert.ok(cc?.includes('immutable'))
  assert.equal(headers.get('CDN-Cache-Control'), `max-age=${DANMUBOX_CDN_S_MAXAGE_SEC}`)
  assert.equal(headers.get('Cloudflare-CDN-Cache-Control'), `max-age=${DANMUBOX_CDN_S_MAXAGE_SEC}`)

  // Bypass
  headers.clear()
  setDanmuBoxCdnHeaders(mockContext, true)
  assert.equal(headers.get('Cache-Control'), 'private, no-store')
  assert.equal(headers.get('CDN-Cache-Control'), 'no-store')
  assert.equal(headers.get('Cloudflare-CDN-Cache-Control'), 'no-store')
})
