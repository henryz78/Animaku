import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { PointerMode } from './usePointerMode'

export interface ShellPointerHandlerApi {
  togglePlay: () => void
  toggleFs?: () => void
  bumpBar: () => void
  hideBar: () => void
  showBarRef: MutableRefObject<boolean>
  /** Close speed / SR menus if open; return true if something was closed. */
  closeMenus: () => boolean
  /** Close danmaku panel if open; return true if closed. */
  closePanel: () => boolean
  /** When false, desktop mouseleave keeps the bar (paused). */
  isPlaying: () => boolean
  /** Seek relative to the current position (used by mobile double-tap). */
  seekBy?: (deltaSeconds: number) => void
  /** Temporarily change playback speed while a mobile long-press is held. */
  onTemporarySpeedStart?: (speed: number) => void
  onTemporarySpeedEnd?: () => void
}

function isPlayerChromeTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el?.closest) return false
  return Boolean(
    el.closest(
      '.kz-bar, .kz-big-play, .kz-speed-menu, .kz-sr-menu, .kz-vol-popup, .kz-settings-popover, .kz-context-menu, .kz-stats-overlay, button, a, input, select, textarea, label, [role="dialog"], [data-player-chrome]',
    ),
  )
}

/** Max gap between taps to count as double-tap (mobile). */
const MOBILE_DOUBLE_TAP_MS = 320
/** Delay before treating a lone tap as chrome toggle (mobile). */
const MOBILE_SINGLE_TAP_DELAY_MS = 320
/**
 * Mobile browsers often fire: click → click (our double-tap) → dblclick.
 * Without dedup, togglePlay runs twice (pause then immediate play).
 */
const PLAY_TOGGLE_DEDUP_MS = 420
/** Long press threshold for mobile temporary 2x playback. */
const MOBILE_LONG_PRESS_MS = 450

type MobileTapZone = 'left' | 'center' | 'right'

function mobileTapZone(e: { clientX: number; currentTarget: EventTarget | null }): MobileTapZone {
  const shell = e.currentTarget as HTMLElement | null
  const rect = shell?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return 'center'
  const ratio = (e.clientX - rect.left) / rect.width
  if (ratio < 0.35) return 'left'
  if (ratio > 0.65) return 'right'
  return 'center'
}

/**
 * Stage pointer handlers. Desktop and mobile policies live in separate branches
 * so edits to one path do not risk the other.
 *
 * Desktop (fine pointer):
 * - single-click: instant 0ms play/pause toggle (no delay, no double-click fullscreen)
 * - mouse enter/move: show control bar; leave: hide while playing
 *
 * Mobile / touch:
 * - single-tap: toggle chrome
 * - center double-tap: play/pause; left/right double-tap: seek ±5 seconds
 *   (timestamp-based — Safari often never fires dblclick)
 * - long-press on the stage: temporary 2x playback
 * - no hover path (synthetic mouse would fight tap toggle)
 */
export function useShellPointerHandlers(
  pointerMode: PointerMode,
  api: ShellPointerHandlerApi,
) {
  const apiRef = useRef(api)
  apiRef.current = api
  const mobileClickTimerRef = useRef(0)
  /** Last stage tap time for mobile double-tap (dblclick is unreliable on iOS). */
  const lastTapAtRef = useRef(0)
  /** Zone of the last mobile stage tap, used to distinguish seek gestures. */
  const lastTapZoneRef = useRef<MobileTapZone>('center')
  /** Last play/pause toggle from stage gestures (dedup click+dblclick). */
  const lastPlayToggleAtRef = useRef(0)
  /** Last mobile seek gesture, used to deduplicate native dblclick. */
  const lastSeekAtRef = useRef(0)
  const mobileLongPressTimerRef = useRef(0)
  const mobileLongPressActiveRef = useRef(false)
  const suppressNextMobileClickRef = useRef(false)
  const mobileSuppressTimerRef = useRef(0)
  const mobilePointerStartRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    return () => {
      window.clearTimeout(mobileClickTimerRef.current)
      window.clearTimeout(mobileLongPressTimerRef.current)
      window.clearTimeout(mobileSuppressTimerRef.current)
      if (mobileLongPressActiveRef.current) {
        mobileLongPressActiveRef.current = false
        apiRef.current.onTemporarySpeedEnd?.()
      }
    }
  }, [])

  const requestTogglePlay = useCallback(() => {
    const now = Date.now()
    if (now - lastPlayToggleAtRef.current < PLAY_TOGGLE_DEDUP_MS) return
    lastPlayToggleAtRef.current = now
    apiRef.current.togglePlay()
  }, [])

  const onShellClick = useCallback(
    (e: ReactMouseEvent) => {
      if (isPlayerChromeTarget(e.target)) return
      const a = apiRef.current

      if (pointerMode === 'desktop') {
        if (a.closeMenus() || a.closePanel()) {
          a.bumpBar()
          return
        }

        // Instant 0ms play/pause toggle on click
        a.togglePlay()
        return
      }

      if (suppressNextMobileClickRef.current) {
        suppressNextMobileClickRef.current = false
        return
      }

      // Mobile: detect double-tap via timing (do not rely on onDoubleClick alone)
      const now = Date.now()
      const sinceLast = now - lastTapAtRef.current
      const zone = mobileTapZone(e)
      if (
        sinceLast > 0 &&
        sinceLast < MOBILE_DOUBLE_TAP_MS &&
        zone === lastTapZoneRef.current
      ) {
        window.clearTimeout(mobileClickTimerRef.current)
        mobileClickTimerRef.current = 0
        lastTapAtRef.current = 0
        if (zone === 'left' || zone === 'right') {
          lastSeekAtRef.current = now
          apiRef.current.seekBy?.(zone === 'left' ? -5 : 5)
        } else {
          requestTogglePlay()
        }
        return
      }
      lastTapAtRef.current = now
      lastTapZoneRef.current = zone

      // Single tap: wait in case a second tap arrives
      window.clearTimeout(mobileClickTimerRef.current)
      mobileClickTimerRef.current = window.setTimeout(() => {
        mobileClickTimerRef.current = 0
        // Only clear lastTap if no second tap started a new window
        if (Date.now() - lastTapAtRef.current >= MOBILE_SINGLE_TAP_DELAY_MS - 20) {
          lastTapAtRef.current = 0
        }
        if (a.closeMenus() || a.closePanel()) {
          a.bumpBar()
          return
        }
        if (a.showBarRef.current) a.hideBar()
        else a.bumpBar()
      }, MOBILE_SINGLE_TAP_DELAY_MS)
    },
    [pointerMode, requestTogglePlay],
  )

  const onShellPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (
        pointerMode !== 'mobile' ||
        isPlayerChromeTarget(e.target) ||
        (e.pointerType !== 'touch' && e.pointerType !== 'pen')
      ) return
      mobilePointerStartRef.current = { x: e.clientX, y: e.clientY }
      window.clearTimeout(mobileLongPressTimerRef.current)
      mobileLongPressTimerRef.current = window.setTimeout(() => {
        mobileLongPressTimerRef.current = 0
        mobileLongPressActiveRef.current = true
        suppressNextMobileClickRef.current = true
        window.clearTimeout(mobileSuppressTimerRef.current)
        mobileSuppressTimerRef.current = window.setTimeout(() => {
          suppressNextMobileClickRef.current = false
        }, 700)
        lastTapAtRef.current = 0
        apiRef.current.onTemporarySpeedStart?.(1.5)
        apiRef.current.bumpBar()
      }, MOBILE_LONG_PRESS_MS)
    },
    [pointerMode],
  )

  const endMobileLongPress = useCallback(() => {
    window.clearTimeout(mobileLongPressTimerRef.current)
    mobileLongPressTimerRef.current = 0
    mobilePointerStartRef.current = null
    if (!mobileLongPressActiveRef.current) return
    mobileLongPressActiveRef.current = false
    apiRef.current.onTemporarySpeedEnd?.()
  }, [])

  const onShellPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (pointerMode !== 'mobile' || !mobilePointerStartRef.current) return
      const dx = e.clientX - mobilePointerStartRef.current.x
      const dy = e.clientY - mobilePointerStartRef.current.y
      if (Math.hypot(dx, dy) < 10) return
      endMobileLongPress()
    },
    [endMobileLongPress, pointerMode],
  )

  const onShellPointerCancel = useCallback(() => {
    endMobileLongPress()
    suppressNextMobileClickRef.current = false
    lastTapAtRef.current = 0
  }, [endMobileLongPress])

  const onShellDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      if (isPlayerChromeTarget(e.target)) return
      e.preventDefault()
      window.clearTimeout(mobileClickTimerRef.current)
      mobileClickTimerRef.current = 0
      lastTapAtRef.current = 0
      if (pointerMode === 'desktop') {
        return
      }
      // Fallback if browser still emits dblclick (some Androids).
      // Deduped: click-path double-tap usually already toggled.
      const now = Date.now()
      const zone = mobileTapZone(e)
      if (zone === 'left' || zone === 'right') {
        if (now - lastSeekAtRef.current >= PLAY_TOGGLE_DEDUP_MS) {
          lastSeekAtRef.current = now
          apiRef.current.seekBy?.(zone === 'left' ? -5 : 5)
        }
      } else {
        requestTogglePlay()
      }
    },
    [pointerMode, requestTogglePlay],
  )

  const onShellMouseMove = useCallback(() => {
    if (pointerMode !== 'desktop') return
    apiRef.current.bumpBar()
  }, [pointerMode])

  const onShellMouseLeave = useCallback(() => {
    if (pointerMode !== 'desktop') return
    if (!apiRef.current.isPlaying()) return
    apiRef.current.hideBar()
  }, [pointerMode])

  const onShellMouseEnter = useCallback(() => {
    if (pointerMode !== 'desktop') return
    apiRef.current.bumpBar()
  }, [pointerMode])

  return {
    onShellClick,
    onShellDoubleClick,
    onShellPointerDown,
    onShellPointerMove,
    onShellPointerUp: endMobileLongPress,
    onShellPointerCancel,
    onShellMouseMove,
    onShellMouseLeave,
    onShellMouseEnter,
  }
}
