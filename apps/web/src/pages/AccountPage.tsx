import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../lib/api'
import { useAccountStore } from '../stores/account'

type Mode = 'login' | 'register'

export function AccountPage() {
  const navigate = useNavigate()
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
  const [message, setMessage] = useState('')

  useEffect(() => {
    void init()
  }, [init])

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage('')
    if (mode === 'register' && password !== confirmPassword) {
      setMessage('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      if (mode === 'register') await register(username.trim(), password)
      else await login(username.trim(), password)
      navigate('/settings')
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : '请求失败，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  if (initialized && user) {
    return (
      <section className="mx-auto max-w-xl py-8 sm:py-14">
        <div className="kz-panel p-6 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--kz-accent)]">云端账号</p>
          <h1 className="mt-2 text-2xl font-bold text-[var(--kz-fg)]">已登录</h1>
          <p className="mt-2 text-sm text-[var(--kz-fg-muted)]">当前账号：{user.username}。登录后即可在后续版本同步观看记录、收藏和设置。</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/settings" className="kz-btn-primary">返回设置</Link>
            <button type="button" className="kz-btn-secondary" onClick={() => void logout()}>退出登录</button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="mx-auto max-w-xl py-8 sm:py-14">
      <div className="kz-panel p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--kz-accent)]">Animaku Cloud</p>
        <h1 className="mt-2 text-2xl font-bold text-[var(--kz-fg)]">{mode === 'login' ? '登录账号' : '创建账号'}</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--kz-fg-muted)]">
          账号系统与 Bangumi 登录分开。未登录也可以正常浏览和播放；登录后将用于跨设备保存个人数据。
        </p>

        {!available && (
          <div className="mt-5 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">
            当前部署还没有启用账号数据库，请先完成 D1 迁移。
          </div>
        )}

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-[var(--kz-fg)]">用户名</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required minLength={3} maxLength={32} className="kz-input w-full" placeholder="3 到 32 个字符" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-[var(--kz-fg)]">密码</span>
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} maxLength={128} className="kz-input w-full" placeholder="至少 8 个字符" />
          </label>
          {mode === 'register' && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--kz-fg)]">确认密码</span>
              <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" required minLength={8} maxLength={128} className="kz-input w-full" />
            </label>
          )}
          {message && <p className="text-sm text-rose-400" role="alert">{message}</p>}
          <button type="submit" disabled={busy || !available} className="kz-btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
          </button>
        </form>

        <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setMessage('') }} className="mt-5 w-full text-center text-sm text-[var(--kz-accent)] hover:underline">
          {mode === 'login' ? '还没有账号？立即注册' : '已有账号？返回登录'}
        </button>
      </div>
    </section>
  )
}
