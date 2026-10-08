import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from './components/Layout'
import { LoadingState } from './components/ui'
import { routeImports } from './lib/route-preload'
import { syncCloudData } from './lib/cloud-data'
import { WATCH_PROGRESS_FLUSH_EVENT } from './lib/watch-history'
import { useAccountStore } from './stores/account'
import { offlineProfile } from './offline/profile'
import { OfflineSyncBridge } from './offline/OfflineSyncBridge'

// Keep HomePage and NotFoundPage in the initial chunk for instantaneous render
import { HomePage } from './pages/HomePage'
import { NotFoundPage } from './pages/NotFoundPage'

// Route-level code splitting: lazy-load non-index pages using unified preload loaders
const TimelinePage = lazy(routeImports.timeline)
const AnimePage = lazy(routeImports.anime)
const SearchPage = lazy(routeImports.search)
const CollectPage = lazy(routeImports.collect)
const HistoryPage = lazy(routeImports.history)
const SettingsPage = lazy(routeImports.settings)
const SubjectPage = lazy(routeImports.subject)
const PlayPage = lazy(routeImports.play)
const AccountPage = lazy(routeImports.account)
const OfflinePage = lazy(() => import('./pages/OfflinePage').then((module) => ({ default: module.OfflinePage })))

function PageFallback() {
  return (
    <div className="py-12">
      <LoadingState text="加载页面…" />
    </div>
  )
}

/** Keep the user's allow-listed local stores backed up while the app is open. */
function AccountSyncBridge() {
  const user = useAccountStore((state) => state.user)

  useEffect(() => {
    if (!user) return
    let busy = false
    let pending = false
    let active = true
    const sync = async () => {
      if (!active) return
      if (busy) { pending = true; return }
      busy = true
      try { await syncCloudData() } catch { /* offline use remains fully functional */ }
      finally {
        busy = false
        if (pending && active) {
          pending = false
          void sync()
        }
      }
    }
    const timer = window.setInterval(() => void sync(), 60_000)
    const onVisibility = () => {
      void sync()
    }
    const onProgressFlush = () => void sync()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener(WATCH_PROGRESS_FLUSH_EVENT, onProgressFlush)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener(WATCH_PROGRESS_FLUSH_EVENT, onProgressFlush)
    }
  }, [user])

  return null
}

/** The cloud account is the entry ticket for every content route. */
function RequireAccount() {
  const location = useLocation()
  const user = useAccountStore((state) => state.user)
  const initialized = useAccountStore((state) => state.initialized)
  const loading = useAccountStore((state) => state.loading)
  const init = useAccountStore((state) => state.init)
  const available = useAccountStore((state) => state.available)

  useEffect(() => {
    if (!initialized) void init()
  }, [init, initialized])

  if (!initialized || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--kz-bg)] px-6 text-[var(--kz-fg)]">
        <LoadingState text="正在检查登录状态…" />
      </div>
    )
  }

  if (!user) {
    if (!available && offlineProfile()) return <Navigate to="/offline" replace />
    const returnTo = `${location.pathname}${location.search}${location.hash}`
    return <Navigate to={`/account?redirect=${encodeURIComponent(returnTo)}`} replace />
  }

  return <Outlet />
}

export default function App() {
  return (
    <>
      <AccountSyncBridge />
      <OfflineSyncBridge />
      <Routes>
      <Route path="offline" element={<Suspense fallback={<PageFallback />}><OfflinePage /></Suspense>} />
      <Route path="account" element={<Suspense fallback={<PageFallback />}><AccountPage /></Suspense>} />
      <Route element={<RequireAccount />}>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route
          path="timeline"
          element={
            <Suspense fallback={<PageFallback />}>
              <TimelinePage />
            </Suspense>
          }
        />
        <Route
          path="anime"
          element={
            <Suspense fallback={<PageFallback />}>
              <AnimePage />
            </Suspense>
          }
        />
        <Route
          path="search"
          element={
            <Suspense fallback={<PageFallback />}>
              <SearchPage />
            </Suspense>
          }
        />
        <Route
          path="collect"
          element={
            <Suspense fallback={<PageFallback />}>
              <CollectPage />
            </Suspense>
          }
        />
        <Route
          path="history"
          element={
            <Suspense fallback={<PageFallback />}>
              <HistoryPage />
            </Suspense>
          }
        />
        <Route
          path="settings"
          element={
            <Suspense fallback={<PageFallback />}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route
          path="subject/:id"
          element={
            <Suspense fallback={<PageFallback />}>
              <SubjectPage />
            </Suspense>
          }
        />
        <Route
          path="play/:id"
          element={
            <Suspense fallback={<PageFallback />}>
              <PlayPage />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      </Route>
      </Routes>
    </>
  )
}
