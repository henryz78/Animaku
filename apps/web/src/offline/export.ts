import { protectCache } from './manager'
import { MEDIA_PREFIX, type OfflineTask } from './types'

export function safeFilename(name: string): string { return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'video' }
function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
type WritableFile = { write: (value: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }
type SavePicker = (opts: { suggestedName: string }) => Promise<{ createWritable: () => Promise<WritableFile> }>
export async function exportCache(task: OfflineTask, kind: 'video' | 'package'): Promise<void> {
  const release = protectCache(task.id)
  const suffix = kind === 'package' && task.format === 'hls' ? 'zip' : task.format === 'mp4' ? 'mp4' : 'ts'
  const name = safeFilename(`${task.title}-第${task.episode}集`) + '.' + suffix
  const url = `${MEDIA_PREFIX}${encodeURIComponent(task.id)}/export.${suffix}`
  // Invoke Chrome's optional save picker within the click gesture. Other
  // browsers navigate a hidden frame to our local service worker's attachment;
  // neither path assembles a whole multi-GB video in JavaScript memory.
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  let writable: WritableFile | undefined
  try {
    const handlePromise = picker?.({ suggestedName: name })
    const handle = await handlePromise
    const probe = await fetch(url, { method: 'HEAD' })
    if (!probe.ok) throw new Error(decodeURIComponent(probe.headers.get('X-Export-Error') || '') || '缓存文件不可用，请重新缓存')
    if (handle) {
      const response = await fetch(url)
      if (!response.ok || !response.body) throw new Error('无法读取本机视频')
      writable = await handle.createWritable()
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await writable.write(value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      await writable.close(); writable = undefined
    } else {
      // Chrome bypasses service workers for <a download> requests. A normal
      // frame navigation respects the worker and Content-Disposition instead.
      await new Promise<void>((resolve, reject) => {
        const exportId = crypto.randomUUID()
        const frame = document.createElement('iframe')
        const clean = () => { navigator.serviceWorker.removeEventListener('message', completed); frame.remove() }
        const completed = (event: MessageEvent) => {
          if (event.data?.type !== 'OFFLINE_EXPORT_DONE' || event.data?.exportId !== exportId) return
          clean()
          if (event.data.error) reject(new Error(event.data.error))
          else resolve()
        }
        navigator.serviceWorker.addEventListener('message', completed)
        frame.hidden = true; frame.src = `${url}?exportId=${encodeURIComponent(exportId)}`
        document.body.append(frame)
      })
    }
  } finally { await writable?.abort().catch(() => {}); release() }
}
const escapeXml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!)
export function exportDanmaku(task: OfflineTask): void {
  const rows = (task.comments || []).map((comment) => {
    const color = /^#[0-9a-f]{6}$/i.test(comment.style?.color || '') ? parseInt(comment.style!.color!.slice(1), 16) : 16777215
    return `<d p="${comment.time},${comment.mode === 'top' ? 5 : comment.mode === 'bottom' ? 4 : 1},25,${color},0,0,0,0">${escapeXml(comment.text)}</d>`
  })
  downloadBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?><i>${rows.join('')}</i>`], { type: 'application/xml' }), safeFilename(`${task.title}-第${task.episode}集-弹幕`) + '.xml')
}
