import { useEffect, useRef, type RefObject } from 'react'
import type { DanmakuSettings, DanmakuPanelState } from '../types'
import { formatTime } from '../media/format'

export interface UsePlayerShortcutsOptions {
  videoRef: RefObject<HTMLVideoElement | null>
  onTogglePlay: () => void
  onSeekTo: (time: number) => void
  onPrev?: () => void
  onNext?: () => void
  onToggleFs: () => void
  onToggleWebFs: () => void
  onToggleAspectRatio: () => void
  onToggleDanmaku?: () => void
  onDanmakuChange?: (settings: Partial<DanmakuSettings>) => void
  danmaku: DanmakuSettings
  danmakuPanel?: DanmakuPanelState
  onTogglePanel: () => void
  onCloseAllMenus: () => void
  onFlashHint: (msg: string, ms?: number) => void
  /** Temporarily change playback speed while desktop ArrowLeft is held. */
  onTemporarySpeedStart?: (speed: number) => void
  onTemporarySpeedEnd?: () => void
  enabled?: boolean
}

export function usePlayerShortcuts({
  videoRef,
  onTogglePlay,
  onSeekTo,
  onPrev,
  onNext,
  onToggleFs,
  onToggleWebFs,
  onToggleAspectRatio,
  onToggleDanmaku,
  onDanmakuChange,
  danmaku,
  danmakuPanel,
  onTogglePanel,
  onCloseAllMenus,
  onFlashHint,
  onTemporarySpeedStart,
  onTemporarySpeedEnd,
  enabled = true,
}: UsePlayerShortcutsOptions) {
  const optionsRef = useRef<UsePlayerShortcutsOptions>({
    videoRef,
    onTogglePlay,
    onSeekTo,
    onPrev,
    onNext,
    onToggleFs,
    onToggleWebFs,
    onToggleAspectRatio,
    onToggleDanmaku,
    onDanmakuChange,
    danmaku,
    danmakuPanel,
    onTogglePanel,
    onCloseAllMenus,
    onFlashHint,
    onTemporarySpeedStart,
    onTemporarySpeedEnd,
    enabled,
  })
  optionsRef.current = {
    videoRef,
    onTogglePlay,
    onSeekTo,
    onPrev,
    onNext,
    onToggleFs,
    onToggleWebFs,
    onToggleAspectRatio,
    onToggleDanmaku,
    onDanmakuChange,
    danmaku,
    danmakuPanel,
    onTogglePanel,
    onCloseAllMenus,
    onFlashHint,
    onTemporarySpeedStart,
    onTemporarySpeedEnd,
    enabled,
  }

  useEffect(() => {
    if (!enabled) return

    let holdTimer = 0
    let holdKey: 'left' | 'right' | null = null
    let holdActive = false

    const stopDirectionalHold = () => {
      window.clearTimeout(holdTimer)
      holdTimer = 0
      holdKey = null
      if (!holdActive) return
      holdActive = false
      optionsRef.current.onTemporarySpeedEnd?.()
    }

    function onKey(e: KeyboardEvent) {
      const {
        videoRef: currentVideoRef,
        onTogglePlay,
        onSeekTo,
        onPrev,
        onNext,
        onToggleFs,
        onToggleWebFs,
        onToggleAspectRatio,
        onToggleDanmaku,
        onDanmakuChange,
        danmaku,
        danmakuPanel,
        onTogglePanel,
        onCloseAllMenus,
        onFlashHint,
        onTemporarySpeedStart,
      } = optionsRef.current
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const v = currentVideoRef.current
      if (!v) return
      const k = e.key.toLowerCase()

      if (k === ' ' || k === 'k') {
        e.preventDefault()
        onTogglePlay()
      } else if (k === 'arrowleft') {
        e.preventDefault()
        if (e.repeat) return
        stopDirectionalHold()
        const nextTime = Math.max(0, v.currentTime - 5)
        onSeekTo(nextTime)
        onFlashHint(`⏪ -5s (${formatTime(nextTime)})`, 1000)
        holdKey = 'left'
        holdTimer = window.setTimeout(() => {
          holdTimer = 0
          holdActive = true
          onTemporarySpeedStart?.(2)
          onFlashHint('⏩ 左键长按：2 倍速播放', 900)
        }, 450)
      } else if (k === 'arrowright') {
        e.preventDefault()
        if (e.repeat) return
        stopDirectionalHold()
        const nextTime = Math.min(v.duration || 0, v.currentTime + 5)
        onSeekTo(nextTime)
        onFlashHint(`⏩ +5s (${formatTime(nextTime)})`, 1000)
        holdKey = 'right'
        holdTimer = window.setTimeout(() => {
          holdTimer = 0
          holdActive = true
          onTemporarySpeedStart?.(2)
          onFlashHint('⏩ 右键长按：2 倍速播放', 900)
        }, 450)
      } else if (k === 'arrowup') {
        e.preventDefault()
        const nextVol = Math.min(1, Math.round((v.volume + 0.05) * 100) / 100)
        v.volume = nextVol
        onFlashHint(`🔊 音量 ${Math.round(nextVol * 100)}%`, 1000)
      } else if (k === 'arrowdown') {
        e.preventDefault()
        const nextVol = Math.max(0, Math.round((v.volume - 0.05) * 100) / 100)
        v.volume = nextVol
        onFlashHint(nextVol === 0 ? '🔇 静音' : `🔉 音量 ${Math.round(nextVol * 100)}%`, 1000)
      } else if (k === 'f') {
        e.preventDefault()
        onToggleFs()
      } else if (k === 'w') {
        e.preventDefault()
        if (e.shiftKey) {
          onToggleWebFs()
        } else {
          onToggleAspectRatio()
        }
      } else if (k === 'p') {
        onPrev?.()
      } else if (k === 'n') {
        onNext?.()
      } else if (k === 'd') {
        e.preventDefault()
        if (onToggleDanmaku) {
          onToggleDanmaku()
        } else {
          const isEnabled = danmaku.enabled !== false
          const isSimplify = Boolean(danmaku.simplify)
          if (isEnabled && !isSimplify) {
            onDanmakuChange?.({ enabled: true, simplify: true })
          } else if (isEnabled && isSimplify) {
            onDanmakuChange?.({ enabled: false, simplify: false })
          } else {
            onDanmakuChange?.({ enabled: true, simplify: false })
          }
        }
      } else if (k === ',' || e.key === '，') {
        // agefans: lag danmaku +0.5s (直接联动弹幕面板单集全局时间偏移)
        e.preventDefault()
        const cur = danmakuPanel?.globalTimeOffset || 0
        const next = Math.round((cur + 0.5) * 10) / 10
        danmakuPanel?.onSetGlobalTimeOffset?.(next)
        onFlashHint(`弹幕滞后 0.5s（偏移 ${next > 0 ? '+' : ''}${next}s）`, 1500)
      } else if (k === '.' || e.key === '。') {
        // agefans: advance danmaku -0.5s (直接联动弹幕面板单集全局时间偏移)
        e.preventDefault()
        const cur = danmakuPanel?.globalTimeOffset || 0
        const next = Math.round((cur - 0.5) * 10) / 10
        danmakuPanel?.onSetGlobalTimeOffset?.(next)
        onFlashHint(`弹幕超前 0.5s（偏移 ${next > 0 ? '+' : ''}${next}s）`, 1500)
      } else if (k === '/' || e.key === '、') {
        // agefans: restore offset (直接联动弹幕面板单集全局时间偏移复位)
        e.preventDefault()
        danmakuPanel?.onSetGlobalTimeOffset?.(0)
        onFlashHint('弹幕偏移已复位', 1500)
      } else if (k === 'm' && e.altKey) {
        e.preventDefault()
        onTogglePanel()
      } else if (k === 'escape') {
        onCloseAllMenus()
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      const key = e.key.toLowerCase()
      if (key !== 'arrowleft' && key !== 'arrowright') return
      if (holdKey === key.slice(5) || holdKey !== null) stopDirectionalHold()
    }

    function onWindowBlur() {
      stopDirectionalHold()
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') stopDirectionalHold()
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stopDirectionalHold()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, videoRef])
}
