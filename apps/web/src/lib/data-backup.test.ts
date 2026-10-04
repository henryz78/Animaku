import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createLocalDataBackup,
  restoreLocalDataBackup,
  serializeLocalDataBackup,
} from './data-backup'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  } as Storage
}

test('exports only Animaku local data and restores it as a replacement', () => {
  const source = memoryStorage({
    'animaku-settings': '{"state":{"theme":"dark"}}',
    'animaku:custom-oped-marks': '{"state":{"subjects":{}}}',
    'kz-settings-open-sections': '{"data-backup":true}',
    'unrelated-site-data': 'keep out',
  })
  const backup = createLocalDataBackup(source)

  assert.deepEqual(Object.keys(backup.entries), [
    'animaku-settings',
    'animaku:custom-oped-marks',
    'kz-settings-open-sections',
  ])

  const target = memoryStorage({
    'animaku-settings': 'old',
    'animaku-search-history': 'stale',
    'unrelated-site-data': 'keep out',
  })
  const count = restoreLocalDataBackup(serializeLocalDataBackup(backup), target)

  assert.equal(count, 3)
  assert.equal(target.getItem('animaku-settings'), source.getItem('animaku-settings'))
  assert.equal(target.getItem('animaku-search-history'), null)
  assert.equal(target.getItem('unrelated-site-data'), 'keep out')
})

test('rejects files from another format', () => {
  const target = memoryStorage({ 'animaku-settings': 'keep' })
  assert.throws(
    () => restoreLocalDataBackup('{"format":"other","version":1,"entries":{}}', target),
    /版本不受支持/u,
  )
  assert.equal(target.getItem('animaku-settings'), 'keep')
})
