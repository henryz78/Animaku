import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { prepareCloudflareDeployment } from './prepare-cloudflare-deploy.mjs'

const accountId = 'a'.repeat(32)
const databaseId = '11111111-2222-3333-4444-555555555555'
const options = { accountId, apiToken: 'test-token' }
const response = (bindings) => Response.json({ success: true, result: { bindings } })
const database = { name: 'DB', type: 'd1', id: databaseId }

test('targets the existing Worker and copies only its actual DB binding', async () => {
  let requests = 0
  const config = await prepareCloudflareDeployment({
    ...options,
    workerName: 'my-existing-worker',
    fetchImpl: async (url, init) => {
      requests++
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/my-existing-worker/settings`)
      assert.equal(init.headers.Authorization, 'Bearer test-token')
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      return response([
        { name: 'OTHER_DB', type: 'd1', id: '99999999-2222-3333-4444-555555555555' },
        { name: 'ADMIN_PASSWORD', type: 'secret_text' },
        { name: 'PRIVATE_VALUE', type: 'plain_text', text: 'must-not-be-copied' },
        database,
      ])
    },
  })
  assert.equal(requests, 1)
  assert.deepEqual(config, {
    d1_databases: [{
      binding: 'DB',
      database_id: databaseId,
      migrations_dir: fileURLToPath(new URL('../apps/server/migrations', import.meta.url)),
    }],
  })
  assert.ok(path.isAbsolute(config.d1_databases[0].migrations_dir))
})

test('defaults to animaku and rejects missing/invalid inputs before contacting Cloudflare', async () => {
  let requests = 0
  const fetchImpl = async (url) => {
    requests++
    assert.ok(url.endsWith('/workers/scripts/animaku/settings'))
    return response([database])
  }
  for (const override of [
    { apiToken: undefined }, { apiToken: ' ' }, { accountId: undefined },
    { accountId: '../another-account' }, { workerName: '../another-worker' },
    { workerName: '' },
  ]) {
    await assert.rejects(prepareCloudflareDeployment({ ...options, ...override, fetchImpl }))
  }
  assert.equal(requests, 0)
  await prepareCloudflareDeployment({ ...options, fetchImpl })
  assert.equal(requests, 1)
})

test('stops on missing Worker or API failure without exposing the response body', async () => {
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(prepareCloudflareDeployment({
      ...options,
      fetchImpl: async () => new Response('private-upstream-response', { status }),
    }), (error) => {
      assert.ok(!error.message.includes('private-upstream-response'))
      assert.match(error.message, status === 404 ? /Worker not found/ : new RegExp(`HTTP ${status}`))
      return true
    })
  }
})

test('stops if DB is absent, ambiguous, the wrong type, or has an invalid ID', async () => {
  for (const bindings of [
    [], [{ ...database, name: 'WRONG_NAME' }], [database, database],
    [{ ...database, type: 'kv_namespace' }], [{ ...database, id: '' }],
    [{ ...database, id: undefined }],
  ]) {
    await assert.rejects(prepareCloudflareDeployment({
      ...options, fetchImpl: async () => response(bindings),
    }), /exactly one D1 binding named DB/)
  }
})

test('stops on unsuccessful or malformed API payloads and network failures', async () => {
  for (const payload of [
    { success: false, result: { bindings: [database] } },
    { success: true }, { success: true, result: { bindings: null } },
  ]) {
    await assert.rejects(prepareCloudflareDeployment({
      ...options, fetchImpl: async () => Response.json(payload),
    }), /valid Worker bindings/)
  }
  await assert.rejects(prepareCloudflareDeployment({
    ...options, fetchImpl: async () => new Response('invalid-json'),
  }))
  await assert.rejects(prepareCloudflareDeployment({
    ...options, fetchImpl: async () => { throw new Error('Network unavailable') },
  }), /Network unavailable/)
})
