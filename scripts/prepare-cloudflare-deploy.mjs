import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = fileURLToPath(new URL('../', import.meta.url))
const databaseIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i

export async function prepareCloudflareDeployment({
  accountId,
  apiToken,
  workerName = 'animaku',
  databaseName = workerName,
  fetchImpl = fetch,
}) {
  if (!apiToken?.trim()) throw new Error('Missing CLOUDFLARE_API_TOKEN repository secret.')
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '')) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID.')
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(workerName)) {
    throw new Error('Invalid CLOUDFLARE_WORKER_NAME.')
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(databaseName)) {
    throw new Error('Invalid CLOUDFLARE_D1_NAME.')
  }

  const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${accountId}`
  async function request(resource, label, { body, allowMissing = false } = {}) {
    const response = await fetchImpl(`${apiRoot}${resource}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 404 && allowMissing) return null
    if (!response.ok) {
      throw new Error(`Cannot ${label} (HTTP ${response.status}). Check the account and API token permissions.`)
    }
    // Worker settings can contain runtime values: never print API bodies, even
    // on parse failures, or copy unrelated bindings into temporary config files.
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error(`Cloudflare returned invalid JSON while trying to ${label}.`)
    }
    if (payload?.success !== true || payload.result == null) {
      throw new Error(`Cloudflare did not return a valid result while trying to ${label}.`)
    }
    return payload.result
  }

  const settings = await request(`/workers/scripts/${encodeURIComponent(workerName)}/settings`, 'read Worker settings', { allowMissing: true })
  if (settings && !Array.isArray(settings.bindings)) {
    throw new Error('Cloudflare did not return valid Worker bindings.')
  }
  const bindings = (settings?.bindings ?? []).filter((binding) => binding?.name === 'DB')
  if (bindings.length > 1 || (bindings.length === 1 && (bindings[0].type !== 'd1' || !databaseIdPattern.test(bindings[0].id ?? '')))) {
    throw new Error('Existing DB binding is invalid or is not D1. Fix it in the dashboard; it will not be overwritten.')
  }

  let databaseId = bindings[0]?.id
  let databaseCreated = false
  if (!databaseId) {
    // Reuse an exact name after interrupted first deployments; a loose name
    // search must never attach a different site's database by mistake.
    let matches = []
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ name: databaseName, per_page: '100', page: String(page) })
      const databases = await request(`/d1/database?${query}`, 'list D1 databases')
      if (!Array.isArray(databases)) throw new Error('Cloudflare did not return a valid D1 database list.')
      matches.push(...databases.filter((db) => db?.name === databaseName))
      if (databases.length < 100) break
    }
    if (matches.length > 1) throw new Error('Multiple D1 databases have the requested name; deployment stopped.')
    const database = matches[0] ?? await request('/d1/database', 'create D1 database', { body: { name: databaseName } })
    if (database.name !== databaseName || !databaseIdPattern.test(database.uuid ?? '')) {
      throw new Error('Cloudflare did not return the expected D1 database name and ID.')
    }
    databaseId = database.uuid
    databaseCreated = matches.length === 0
  }

  return {
    workerName,
    workerExists: settings !== null,
    needsBinding: bindings.length === 0,
    databaseCreated,
    migrationConfig: {
      d1_databases: [{
        binding: 'DB',
        database_id: databaseId,
        migrations_dir: path.join(rootDir, 'apps/server/migrations'),
      }],
    },
  }
}

export function createDeploymentConfig(baseConfig, prepared) {
  if (baseConfig.vars || baseConfig.d1_databases || baseConfig.account_id || baseConfig.env) {
    throw new Error('Keep runtime variables, account IDs and database bindings out of the tracked deployment config.')
  }
  return {
    ...baseConfig,
    name: prepared.workerName,
    // Supply DB only to create a missing binding. Subsequent releases omit it
    // and use keep_bindings, so the dashboard stays in control of the database.
    ...(prepared.needsBinding ? { d1_databases: prepared.migrationConfig.d1_databases } : {}),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    // Use the pinned Wrangler parser for JSONC instead of a custom comment parser.
    const { experimental_readRawConfig } = await import('wrangler')
    const { rawConfig } = experimental_readRawConfig({ config: path.join(rootDir, 'wrangler.jsonc') })
    // Validate before creating anything remotely.
    createDeploymentConfig(rawConfig, { workerName: 'animaku', needsBinding: false })
    const prepared = await prepareCloudflareDeployment({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      workerName: process.env.CLOUDFLARE_WORKER_NAME || 'animaku',
      databaseName: process.env.CLOUDFLARE_D1_NAME || process.env.CLOUDFLARE_WORKER_NAME || 'animaku',
    })
    await writeFile(path.join(rootDir, '.tmp-cloudflare-d1.json'), `${JSON.stringify(prepared.migrationConfig, null, 2)}\n`, { mode: 0o600 })
    await writeFile(path.join(rootDir, '.tmp-cloudflare-deploy.json'), `${JSON.stringify(createDeploymentConfig(rawConfig, prepared), null, 2)}\n`, { mode: 0o600 })
    console.log(`${prepared.workerExists ? 'Update existing' : 'Create new'} Worker: ${prepared.workerName}. D1: ${prepared.databaseCreated ? 'created' : 'reused'}; DB binding: ${prepared.needsBinding ? 'will be added during deployment' : 'preserved'}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cannot prepare Cloudflare deployment.')
    process.exitCode = 1
  }
}
