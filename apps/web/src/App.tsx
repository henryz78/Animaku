import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { LoadingState } from './components/ui'
import { routeImports } from './lib/route-preload'
import { syncCloudData } from './lib/cloud-data'
import { useAccountStore } from './stores/account'

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
    const sync = async () => {
      if (busy) return
      busy = true
      try { await syncCloudData() } catch { /* offline use remains fully functional */ }
      finally { busy = false }
    }
    const timer = window.setInterval(() => void sync(), 60_000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void sync()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [user])

  return null
}

export default function App() {
  return (
    <>
      <AccountSyncBridge />
      <Routes>
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
          path="account"
          element={
            <Suspense fallback={<PageFallback />}>
              <AccountPage />
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
      </Routes>
    </>
  )
}
