let registering: Promise<ServiceWorkerRegistration> | undefined
export function registerOfflineWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) return Promise.reject(new Error('此浏览器不支持离线缓存，请使用 HTTPS 和较新的浏览器'))
  registering ||= navigator.serviceWorker.register('/offline-sw.js', { scope: '/' }).catch((error) => { registering = undefined; throw error })
  return registering
}
export async function prepareOfflineShell(): Promise<void> {
  await registerOfflineWorker()
  const registration = await navigator.serviceWorker.ready
  const worker = registration.active
  if (!worker) throw new Error('离线服务尚未就绪，请重试')
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel()
    const timeout = window.setTimeout(() => { channel.port1.close(); reject(new Error('离线页面准备超时，请检查网络后重试')) }, 60_000)
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout); channel.port1.close()
      if (event.data?.ok) resolve()
      else reject(new Error(event.data?.error || '离线页面准备失败'))
    }
    worker.postMessage({ type: 'PREPARE_OFFLINE' }, [channel.port2])
  })
  if (!navigator.serviceWorker.controller) await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', listener); reject(new Error('请刷新页面后开始缓存')) }, 5000)
    const listener = () => { window.clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', listener); resolve() }
    navigator.serviceWorker.addEventListener('controllerchange', listener)
    if (navigator.serviceWorker.controller) listener()
  })
}
