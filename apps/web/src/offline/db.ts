import { DB_NAME, type MediaFile, type MediaMeta, type OfflineTask, type PendingProgress } from './types'

let opening: Promise<IDBDatabase> | undefined
export function openOfflineDB(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('tasks', { keyPath: 'id' })
      db.createObjectStore('files', { keyPath: 'key' }).createIndex('taskId', 'taskId')
      db.createObjectStore('fileMeta', { keyPath: 'key' }).createIndex('taskId', 'taskId')
      db.createObjectStore('meta')
      db.createObjectStore('progress', { keyPath: 'id' })
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); opening = undefined }
      resolve(request.result)
    }
    request.onerror = () => { opening = undefined; reject(request.error) }
    request.onblocked = () => { opening = undefined; reject(new Error('请关闭其他旧版本页面后重试')) }
  })
  return opening
}
export async function readStore<T>(store: string, key?: IDBValidKey): Promise<T> {
  const db = await openOfflineDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const request = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key)
    request.onsuccess = () => resolve((store === 'files' && request.result ? (Array.isArray(request.result) ? request.result.map(hydrateFile) : hydrateFile(request.result)) : request.result) as T)
    request.onerror = () => reject(request.error)
  })
}
export async function writeStore(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openOfflineDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error || new Error('本机存储写入失败'))
  })
}
export const readTasks = () => readStore<OfflineTask[]>('tasks')
export const saveTask = (task: OfflineTask) => writeStore('tasks', task)
export async function taskFiles(taskId: string): Promise<MediaFile[]> {
  const db = await openOfflineDB()
  return new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').index('taskId').getAll(taskId)
    request.onsuccess = () => resolve(request.result.map(hydrateFile))
    request.onerror = () => reject(request.error)
  })
}
function hydrateFile(file: MediaFile): MediaFile {
  return file.blob instanceof Blob ? file : { ...file, blob: new Blob([file.blob as unknown as ArrayBuffer], { type: file.mime }) }
}
export async function taskFileMeta(taskId: string): Promise<MediaMeta[]> {
  const db = await openOfflineDB()
  return new Promise((resolve, reject) => {
    const request = db.transaction('fileMeta').objectStore('fileMeta').index('taskId').getAll(taskId)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
/** Delete bytes and their task atomically; never touches watch history. */
export async function deleteTask(taskId: string): Promise<void> {
  const db = await openOfflineDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tasks', 'files', 'fileMeta'], 'readwrite')
    tx.objectStore('tasks').delete(taskId)
    const cursor = tx.objectStore('files').index('taskId').openKeyCursor(taskId)
    cursor.onsuccess = () => {
      const row = cursor.result
      if (row) { tx.objectStore('files').delete(row.primaryKey); tx.objectStore('fileMeta').delete(row.primaryKey); row.continue() }
    }
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}
export async function saveFile(task: OfflineTask, file: MediaFile): Promise<void> {
  // ArrayBuffer works in WebKit environments where persisting Blob fails. Each
  // write stays bounded (4 MB for MP4); metadata is separate to avoid reading
  // an entire multi-GB video into memory for playback or file export.
  const bytes = await file.blob.arrayBuffer()
  const db = await openOfflineDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tasks', 'files', 'fileMeta'], 'readwrite')
    tx.objectStore('files').put({ ...file, blob: bytes })
    const { blob, ...metadata } = file
    tx.objectStore('fileMeta').put({ ...metadata, size: blob.size })
    tx.objectStore('tasks').put(task)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error || new Error('本机存储写入失败，下载已停止'))
  })
}
export async function savePending(entry: PendingProgress): Promise<void> {
  await writeStore('progress', { ...entry, id: `${entry.owner}:${entry.id}` })
}
export async function acknowledgeProgress(entries: PendingProgress[]): Promise<void> {
  const db = await openOfflineDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('progress', 'readwrite')
    for (const entry of entries) {
      const request = tx.objectStore('progress').get(entry.id)
      request.onsuccess = () => {
        if (request.result?.owner === entry.owner && request.result?.updatedAt === entry.updatedAt) {
          tx.objectStore('progress').delete(entry.id)
        }
      }
    }
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}
