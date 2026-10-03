import test from 'node:test'
import assert from 'node:assert/strict'
import { validateTarget } from '../lib/allowlist.js'

test('allowlist accepts the supported upstream hosts', () => {
  assert.equal(validateTarget('https://api.bilibili.com/x/web-interface/view?bvid=BV1').ok, true)
  assert.equal(validateTarget('https://animoe.org/info/379.html').ok, true)
  assert.equal(validateTarget('https://www.tvtfun.net/video/400602').ok, true)
})

test('allowlist rejects open-proxy targets', () => {
  assert.equal(validateTarget('http://animoe.org/info/379.html').ok, false)
  assert.equal(validateTarget('https://example.com/').ok, false)
  assert.equal(validateTarget('https://www.tvtfun.net.evil.example/').ok, false)
  assert.equal(validateTarget('https://user:pass@animoe.org/').ok, false)
  assert.equal(validateTarget('https://animoe.org:8443/').ok, false)
})
