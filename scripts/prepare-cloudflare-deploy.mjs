import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = fileURLToPath(new URL('../', import.meta.url))

export async function prepareCloudflareDeployment({
  accountId,
  apiToken,
  workerName = 'animaku',
  fetchImpl = fetch,
}) {
  if (!apiToken?.trim()) throw new Error('Missing CLOUDFLARE_API_TOKEN repository secret.')
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '')) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID.')
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(workerName)) {
    throw new Error('Invalid CLOUDFLARE_WORKER_NAME; use the name of an existing Worker.')
  }

  // Read the actual deployed binding instead of keeping a second database ID in
  // GitHub. A missing Worker/DB stops the release before any remote mutation.
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/settings`
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) {
    throw new Error('Worker not found. Create it in the Cloudflare dashboard and bind D1 as DB before deploying.')
  }
  if (!response.ok) {
    throw new Error(`Cannot read Worker settings (HTTP ${response.status}). Check the account, Worker name and API token permissions.`)
  }

  // Settings can contain runtime variable values: never print this response,
  // or copy unrelated bindings/credentials into the migration configuration.
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('Cloudflare returned invalid JSON for Worker settings.')
  }
  if (payload?.success !== true || !Array.isArray(payload.result?.bindings)) {
    throw new Error('Cloudflare did not return valid Worker bindings.')
  }
  const bindings = payload.result.bindings.filter((binding) => binding?.name === 'DB')
  const db = bindings[0]
  if (bindings.length !== 1 || db.type !== 'd1' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(db.id ?? '')) {
    throw new Error('Worker must have exactly one D1 binding named DB. Configure it in the Cloudflare dashboard.')
  }

  return {
    d1_databases: [{
      binding: 'DB',
      database_id: db.id,
      migrations_dir: path.join(rootDir, 'apps/server/migrations'),
    }],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = await prepareCloudflareDeployment({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      workerName: process.env.CLOUDFLARE_WORKER_NAME || 'animaku',
    })
    await writeFile(path.join(rootDir, '.tmp-cloudflare-d1.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    console.log('Existing Worker and DB binding verified; temporary D1 migration configuration prepared.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cannot prepare Cloudflare deployment.')
    process.exitCode = 1
  }
}
