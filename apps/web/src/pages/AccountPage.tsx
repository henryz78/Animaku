import { FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError } from '../lib/api'
import { syncCloudData } from '../lib/cloud-data'
import { getSiteBranding } from '../lib/site-branding'
import { LoadingState } from '../components/ui'
import { useAccountStore } from '../stores/account'

type Mode = 'login' | 'register'

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/account')) return '/'
  return value
}

function Feature({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.06] p-3.5 backdrop-blur-sm">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/10 text-base" aria-hidden>{icon}</span>
      <div className="min-w-0"><p className="text-sm font-semibold text-white">{title}</p><p className="mt-0.5 text-xs leading-5 text-white/60">{detail}</p></div>
    </div>
  )
}

export function AccountPage() {
  const branding = getSiteBranding()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const returnTo = safeReturnTo(params.get('redirect'))
  const user = useAccountStore((state) => state.user)
  const available = useAccountStore((state) => state.available)
  const initialized = useAccountStore((state) => state.initialized)
  const init = useAccountStore((state) => state.init)
  const login = useAccountStore((state) => state.login)
  const register = useAccountStore((state) => state.register)
  const logout = useAccountStore((state) => state.logout)
  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [message, setMessage] = useState('')
  const syncAttempted = useRef(false)

  useEffect(() => { void init() }, [init])

  const runSync = async () => {
    if (!user || syncBusy) return
    setSyncBusy(true)
    setSyncMessage('正在合并本机与云端数据…')
    try {
      const result = await syncCloudData()
      setSyncMessage(`已同步 ${result.keys} 类数据`)
    } catch (error) {
      setSyncMessage(error instanceof ApiError ? error.message : '同步失败，请稍后重试')
    } finally { setSyncBusy(false) }
  }

  useEffect(() => {
    if (!initialized || !user || syncAttempted.current) return
    syncAttempted.current = true
    void runSync()
  }, [initialized, user])

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage('')
    if (mode === 'register' && password !== confirmPassword) { setMessage('两次输入的密码不一致'); return }
    setBusy(true)
    try {
      if (mode === 'register') await register(username.trim(), password)
      else await login(username.trim(), password)
      try { await syncCloudData() } catch { /* 登录成功后仍可从账号页手动同步 */ }
      navigate(returnTo, { replace: true })
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : '请求失败，请稍后重试')
    } finally { setBusy(false) }
  }

  const onLogout = async () => { await logout(); navigate('/account', { replace: true }) }

  if (!initialized) {
    return <main className="flex min-h-screen items-center justify-center bg-[var(--kz-bg)] px-6 text-[var(--kz-fg)]"><LoadingState text="正在连接账号服务…" /></main>
  }

  if (user) {
    return (
      <main className="relative min-h-screen overflow-hidden bg-[var(--kz-bg)] px-4 py-8 text-[var(--kz-fg)] sm:px-6 sm:py-14">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[var(--kz-accent)]/15 blur-3xl" aria-hidden />
        <section className="relative mx-auto max-w-2xl rounded-[2rem] border border-[var(--kz-border)] bg-[var(--kz-bg-elevated)] p-6 shadow-2xl sm:p-10">
          <div className="flex items-center gap-3"><img src="/logo.png" alt="" width={48} height={48} className="h-12 w-12 rounded-2xl object-cover ring-1 ring-[var(--kz-border)]" /><div><p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--kz-accent)]">{branding.productName} Cloud</p><h1 className="mt-1 text-2xl font-bold">账号中心</h1></div></div>
          <div className="mt-8 rounded-2xl border border-[var(--kz-border)] bg-[var(--kz-bg-soft)] p-4 sm:p-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--kz-fg-dim)]">当前已登录</p><p className="mt-2 text-xl font-bold text-[var(--kz-fg)]">{user.username}</p><p className="mt-2 text-sm leading-6 text-[var(--kz-fg-muted)]">观看历史、收藏、播放设置和源绑定会随账号同步到云端。</p>{user.role === 'admin' && <span className="mt-3 inline-flex rounded-full bg-[var(--kz-accent)]/15 px-2.5 py-1 text-xs font-semibold text-[var(--kz-accent)]">管理员账号</span>}</div>
          {syncMessage && <p className="mt-4 text-sm text-[var(--kz-accent)]" role="status">{syncMessage}</p>}
          <div className="mt-7 flex flex-wrap gap-3"><Link to={returnTo} className="kz-btn-primary">进入网站</Link><button type="button" className="kz-btn-secondary" disabled={syncBusy} onClick={() => void runSync()}>{syncBusy ? '同步中…' : '立即同步数据'}</button><button type="button" className="kz-btn-secondary" onClick={() => void onLogout()}>退出登录</button></div>
        </section>
      </main>
    )
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#101827] px-4 py-6 text-white sm:px-6 sm:py-10">
      <div className="pointer-events-none absolute -left-28 -top-28 h-96 w-96 rounded-full bg-sky-500/20 blur-3xl" aria-hidden /><div className="pointer-events-none absolute -bottom-40 -right-20 h-[28rem] w-[28rem] rounded-full bg-indigo-500/20 blur-3xl" aria-hidden />
      <div className="relative mx-auto grid min-h-[calc(100vh-3rem)] max-w-6xl items-center gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
        <section className="hidden px-2 lg:block">
          <div className="mb-7 flex items-center gap-3"><img src="/logo.png" alt="" width={58} height={58} className="h-14 w-14 rounded-2xl object-cover shadow-xl ring-1 ring-white/15" /><div><p className="text-lg font-bold tracking-tight">{branding.productName}</p><p className="text-xs text-white/55">{branding.tagline}</p></div></div>
          <p className="mb-3 inline-flex rounded-full border border-sky-300/20 bg-sky-300/10 px-3 py-1 text-xs font-semibold tracking-wide text-sky-200">账号登录 · 云端同步</p>
          <h1 className="max-w-xl text-4xl font-black leading-[1.16] tracking-tight xl:text-5xl">登录后，继续你的<br /><span className="bg-gradient-to-r from-sky-300 to-violet-300 bg-clip-text text-transparent">每一段观看旅程</span></h1>
          <p className="mt-5 max-w-lg text-sm leading-7 text-white/60">登录是进入网站的必要步骤。你的进度、收藏和偏好会跟随账号，在电脑与手机之间保持一致。</p>
          <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-2"><Feature icon="☁️" title="跨设备同步" detail="换设备也能接着上次的位置观看" /><Feature icon="🎬" title="统一播放体验" detail="登录后保留源选择与播放设置" /><Feature icon="🔒" title="账号隔离" detail="每个人的数据只属于自己的账号" /><Feature icon="⚡" title="一次登录" detail="会话有效期内无需反复验证" /></div>
        </section>

        <section className="mx-auto w-full max-w-md">
          <div className="mb-5 flex items-center gap-3 lg:hidden"><img src="/logo.png" alt="" width={44} height={44} className="h-11 w-11 rounded-2xl object-cover ring-1 ring-white/15" /><div><p className="font-bold">{branding.productName}</p><p className="text-xs text-white/55">{branding.tagline}</p></div></div>
          <div className="rounded-[2rem] border border-white/12 bg-white/[0.08] p-5 shadow-2xl backdrop-blur-2xl sm:p-8">
            <div className="mb-7"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200/80">欢迎回来</p><h2 className="mt-2 text-3xl font-black tracking-tight">{mode === 'login' ? '登录账号' : '创建账号'}</h2><p className="mt-2 text-sm leading-6 text-white/55">{mode === 'login' ? '登录后才能进入主页和播放内容。' : '创建账号后即可开始使用网站。'}</p></div>
            {!available && <div className="mb-5 rounded-2xl border border-amber-300/25 bg-amber-300/10 p-3.5 text-sm leading-6 text-amber-100" role="alert">账号服务暂时不可用，请检查 Cloudflare D1 绑定和账号迁移是否已完成。</div>}
            <form className="space-y-4" onSubmit={onSubmit}>
              <label className="block"><span className="mb-1.5 block text-sm font-medium text-white/85">用户名</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required minLength={3} maxLength={32} className="w-full rounded-xl border border-white/12 bg-black/20 px-3.5 py-3 text-sm text-white outline-none transition focus:border-sky-300/70 focus:ring-2 focus:ring-sky-300/15" placeholder="3 到 32 个字符" /></label>
              <label className="block"><span className="mb-1.5 block text-sm font-medium text-white/85">密码</span><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} maxLength={128} className="w-full rounded-xl border border-white/12 bg-black/20 px-3.5 py-3 text-sm text-white outline-none transition focus:border-sky-300/70 focus:ring-2 focus:ring-sky-300/15" placeholder="至少 8 个字符" /></label>
              {mode === 'register' && <label className="block"><span className="mb-1.5 block text-sm font-medium text-white/85">确认密码</span><input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" required minLength={8} maxLength={128} className="w-full rounded-xl border border-white/12 bg-black/20 px-3.5 py-3 text-sm text-white outline-none transition focus:border-sky-300/70 focus:ring-2 focus:ring-sky-300/15" placeholder="再次输入密码" /></label>}
              {message && <p className="text-sm text-rose-300" role="alert">{message}</p>}
              <button type="submit" disabled={busy || !available} className="mt-2 flex w-full items-center justify-center rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-950/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">{busy ? '处理中…' : mode === 'login' ? '登录并进入主页' : '注册并登录'}</button>
            </form>
            <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setMessage('') }} className="mt-5 w-full text-center text-sm font-medium text-sky-200 hover:text-white hover:underline">{mode === 'login' ? '还没有账号？立即注册' : '已有账号？返回登录'}</button>
            <div className="mt-6 grid grid-cols-3 gap-2 border-t border-white/10 pt-5 text-center text-[11px] text-white/45"><span>安全会话</span><span>云端保存</span><span>跨设备使用</span></div>
          </div>
          <p className="mt-5 text-center text-xs text-white/35">{branding.productName} · 登录后开始使用</p>
        </section>
      </div>
    </main>
  )
}
