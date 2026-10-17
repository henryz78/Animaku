import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createDeploymentConfig, prepareCloudflareDeployment } from './prepare-cloudflare-deploy.mjs'

const accountId = 'a'.repeat(32)
const databaseId = '11111111-2222-3333-4444-555555555555'
const options = { accountId, apiToken: 'test-token' }
const response = (bindings) => Response.json({ success: true, result: { bindings } })
const database = { name: 'DB', type: 'd1', id: databaseId }
const d1 = { name: 'animaku', uuid: databaseId }
const baseConfig = {
  name: 'animaku', main: './apps/server/src/worker.ts', keep_vars: true,
  assets: { directory: './apps/web/dist', binding: 'ASSETS' },
  unsafe: { metadata: { keep_bindings: ['plain_text', 'json', 'secret_text', 'd1', 'r2_bucket', 'kv_namespace'] } },
}

test('targets the existing Worker and copies only its actual DB binding', async () => {
  let requests = 0
  const prepared = await prepareCloudflareDeployment({
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
  assert.equal(prepared.workerExists, true)
  assert.equal(prepared.needsBinding, false)
  assert.equal(prepared.databaseCreated, false)
  assert.deepEqual(prepared.migrationConfig, {
    d1_databases: [{
      binding: 'DB',
      database_id: databaseId,
      migrations_dir: fileURLToPath(new URL('../apps/server/migrations', import.meta.url)),
    }],
  })
  assert.ok(path.isAbsolute(prepared.migrationConfig.d1_databases[0].migrations_dir))
  assert.deepEqual(createDeploymentConfig(baseConfig, prepared), { ...baseConfig, name: 'my-existing-worker' })
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
    { workerName: '' }, { databaseName: '../another-db' },
  ]) {
    await assert.rejects(prepareCloudflareDeployment({ ...options, ...override, fetchImpl }))
  }
  assert.equal(requests, 0)
  await prepareCloudflareDeployment({ ...options, fetchImpl })
  assert.equal(requests, 1)
})

test('stops on authentication or API failure without creating resources or exposing response bodies', async () => {
  for (const status of [401, 403, 500]) {
    let requests = 0
    await assert.rejects(prepareCloudflareDeployment({
      ...options,
      fetchImpl: async () => {
        requests++
        return new Response('private-upstream-response', { status })
      },
    }), (error) => {
      assert.ok(!error.message.includes('private-upstream-response'))
      assert.match(error.message, new RegExp(`HTTP ${status}`))
      return true
    })
    assert.equal(requests, 1)
  }
})

test('refuses to overwrite an ambiguous, wrong-type, or invalid existing DB binding', async () => {
  for (const bindings of [
    [database, database],
    [{ ...database, type: 'kv_namespace' }], [{ ...database, id: '' }],
    [{ ...database, id: undefined }],
  ]) {
    await assert.rejects(prepareCloudflareDeployment({
      ...options, fetchImpl: async () => response(bindings),
    }), /Existing DB binding is invalid/)
  }
})

test('stops on unsuccessful or malformed API payloads and network failures', async () => {
  for (const payload of [
    { success: false, result: { bindings: [database] } },
    { success: true }, { success: true, result: { bindings: null } }, null,
  ]) {
    await assert.rejects(prepareCloudflareDeployment({
      ...options, fetchImpl: async () => Response.json(payload),
    }), /valid (?:Worker bindings|result)/)
  }
  await assert.rejects(prepareCloudflareDeployment({
    ...options, fetchImpl: async () => new Response('invalid-json'),
  }))
  await assert.rejects(prepareCloudflareDeployment({
    ...options, fetchImpl: async () => { throw new Error('Network unavailable') },
  }), /Network unavailable/)
})

test('first deployment creates one D1 and prepares its binding without touching runtime settings', async () => {
  const requests = []
  const prepared = await prepareCloudflareDeployment({
    ...options,
    fetchImpl: async (url, init) => {
      requests.push({ url, method: init.method })
      if (url.endsWith('/settings')) return new Response('', { status: 404 })
      if (init.method === 'GET') {
        assert.equal(new URL(url).searchParams.get('name'), 'animaku')
        return Response.json({ success: true, result: [{ name: 'animaku-backup', uuid: databaseId }] })
      }
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`)
      assert.deepEqual(JSON.parse(init.body), { name: 'animaku' })
      assert.equal(init.headers['Content-Type'], 'application/json')
      return Response.json({ success: true, result: d1 })
    },
  })
  assert.equal(prepared.workerExists, false)
  assert.equal(prepared.needsBinding, true)
  assert.equal(prepared.databaseCreated, true)
  assert.deepEqual(requests.map((r) => r.method), ['GET', 'GET', 'POST'])
  const config = createDeploymentConfig(baseConfig, prepared)
  assert.deepEqual(config.d1_databases, prepared.migrationConfig.d1_databases)
  assert.deepEqual(config.unsafe, baseConfig.unsafe)
  assert.deepEqual(config.assets, baseConfig.assets)
  assert.equal(config.keep_vars, true)
  assert.equal(config.vars, undefined)
  assert.equal(config.account_id, undefined)
  assert.equal(baseConfig.d1_databases, undefined)
})

test('retries reuse an unbound database by exact name instead of creating another one', async () => {
  for (const workerExists of [false, true]) {
    let requests = 0
    const prepared = await prepareCloudflareDeployment({
      ...options, databaseName: 'my-saved-database',
      fetchImpl: async (url, init) => {
        requests++
        assert.equal(init.method, 'GET')
        if (url.endsWith('/settings')) {
          return workerExists ? response([{ name: 'KEEP', type: 'plain_text', text: 'private-value' }]) : new Response('', { status: 404 })
        }
        assert.equal(new URL(url).searchParams.get('name'), 'my-saved-database')
        return Response.json({ success: true, result: [{ ...d1, name: 'my-saved-database' }] })
      },
    })
    assert.equal(requests, 2)
    assert.equal(prepared.workerExists, workerExists)
    assert.equal(prepared.needsBinding, true)
    assert.equal(prepared.databaseCreated, false)
    assert.equal(JSON.stringify(prepared).includes('private-value'), false)
  }
})

test('after first deployment, uses the actual dashboard binding even if its database was changed', async () => {
  const switchedId = '99999999-2222-3333-4444-555555555555'
  const prepared = await prepareCloudflareDeployment({
    ...options,
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/settings'))
      assert.equal(init.method, 'GET')
      return response([{ ...database, id: switchedId }])
    },
  })
  assert.equal(prepared.migrationConfig.d1_databases[0].database_id, switchedId)
  assert.equal(createDeploymentConfig(baseConfig, prepared).d1_databases, undefined)
})

test('searches later pages and reuses only an exact D1 name', async () => {
  const prepared = await prepareCloudflareDeployment({
    ...options,
    fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET')
      if (url.endsWith('/settings')) return new Response('', { status: 404 })
      const page = new URL(url).searchParams.get('page')
      return Response.json({ success: true, result: page === '1'
        ? Array.from({ length: 100 }, (_, i) => ({ ...d1, name: `animaku-backup-${i}` }))
        : [d1] })
    },
  })
  assert.equal(prepared.databaseCreated, false)
  assert.equal(prepared.migrationConfig.d1_databases[0].database_id, databaseId)
})

test('D1 list and create errors stop deployment instead of guessing or replacing a database', async () => {
  for (const results of [
    [new Response('', { status: 403 })],
    [Response.json({ success: true, result: {} })],
    [Response.json({ success: true, result: [d1, d1] })],
    [Response.json({ success: true, result: [{ ...d1, uuid: '' }] })],
    [Response.json({ success: true, result: [] }), new Response('', { status: 400 })],
    [Response.json({ success: true, result: [] }), Response.json({ success: true, result: { ...d1, name: 'wrong-db' } })],
  ]) {
    await assert.rejects(prepareCloudflareDeployment({
      ...options,
      fetchImpl: async (url) => {
        if (url.endsWith('/settings')) return new Response('', { status: 404 })
        const result = results.shift()
        assert.ok(result, 'must not issue additional requests after a failure')
        return result
      },
    }))
    assert.equal(results.length, 0)
  }
})

test('refuses tracked runtime values or permanent database overrides before deployment', () => {
  for (const override of [
    { vars: { ADMIN_PASSWORD: 'must-not-use' } }, { d1_databases: [] },
    { account_id: accountId }, { env: {} },
  ]) {
    assert.throws(() => createDeploymentConfig({ ...baseConfig, ...override }, {
      workerName: 'animaku', needsBinding: false,
    }), /out of the tracked deployment config/)
  }
})
