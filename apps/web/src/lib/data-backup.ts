/**
 * Portable backup for the application's persistent browser data.
 *
 * Session-only values (such as the admin secret and temporary API caches) are
 * deliberately excluded. The backup contains only localStorage keys owned by
 * Animaku, so it can be restored after clearing the browser or moving devices.
 */

export const DATA_BACKUP_FORMAT = 'animaku-local-data'
export const DATA_BACKUP_VERSION = 1

const BACKUP_KEY_PREFIXES = ['animaku-', 'animaku:', 'aniku-', 'aniku:', 'kz-']

export interface LocalDataBackup {
  format: typeof DATA_BACKUP_FORMAT
  version: typeof DATA_BACKUP_VERSION
  exportedAt: string
  entries: Record<string, string>
}

function isBackupKey(key: string): boolean {
  return BACKUP_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

export function createLocalDataBackup(
  storage: Storage = window.localStorage,
): LocalDataBackup {
  const entries: Record<string, string> = {}
  const keys: string[] = []

  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key && isBackupKey(key)) keys.push(key)
  }

  keys.sort()
  for (const key of keys) {
    const value = storage.getItem(key)
    if (value !== null) entries[key] = value
  }

  return {
    format: DATA_BACKUP_FORMAT,
    version: DATA_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    entries,
  }
}

export function serializeLocalDataBackup(backup: LocalDataBackup): string {
  return JSON.stringify(backup, null, 2)
}

export function restoreLocalDataBackup(
  raw: string,
  storage: Storage = window.localStorage,
): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('备份文件不是有效的 JSON 文件')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('备份文件格式不正确')
  }

  const candidate = parsed as Partial<LocalDataBackup>
  if (candidate.format !== DATA_BACKUP_FORMAT || candidate.version !== DATA_BACKUP_VERSION) {
    throw new Error('备份文件版本不受支持，请使用 Animaku 导出的文件')
  }
  if (!candidate.entries || typeof candidate.entries !== 'object' || Array.isArray(candidate.entries)) {
    throw new Error('备份文件中没有有效的数据内容')
  }

  const entries: [string, string][] = []
  for (const [key, value] of Object.entries(candidate.entries)) {
    if (!isBackupKey(key) || typeof value !== 'string') {
      throw new Error('备份文件包含无法识别的数据')
    }
    entries.push([key, value])
  }

  // A restore replaces the application's persistent data, so stale entries
  // from the current browser cannot leak into the restored profile.
  const currentKeys: string[] = []
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key && isBackupKey(key)) currentKeys.push(key)
  }
  for (const key of currentKeys) storage.removeItem(key)
  for (const [key, value] of entries) storage.setItem(key, value)

  return entries.length
}
