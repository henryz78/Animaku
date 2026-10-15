import type { PlayerSettings } from './player'

/**
 * 视频源时长与 Bangumi 单集官方时长允许的最大绝对误差 (秒)。
 * 若误差超过此阈值，说明当前视频源可能存在前置广告、删减、混剪或错位，静默停用 OP/ED 自动跳过。
 */
export const DURATION_MISMATCH_THRESHOLD_S = 4

export interface OpedSkipContext {
  /** 当前播放时间 (秒) */
  currentTime: number
  /** 上一个播放时间 (秒) */
  prevTime: number
  /** 视频总时长 (秒) */
  duration: number
  /** Bangumi 元数据提供的该集预期时长 (秒) */
  expectedDurationSeconds?: number
  /** 是否正在手动拖动进度条 */
  isSeeking?: boolean
  /** 是否处于跳过繁忙期 (防抖期) */
  isSkipBusy?: boolean
  /** 当前分集在列表中的索引 (0-based) */
  episodeIndex?: number
  /** 当前分集编号 (1-based) */
  episodeNumber?: number
  /** 播放器偏好设置 */
  playerSettings: PlayerSettings
  /** 会话状态锁：本集是否已触发过提示 (无论 OP 还是 ED，首集至多提示 1 次) */
  promptTriggeredThisEp: boolean
  /** 会话状态锁：本集是否被标记为完整播放 (用户在提示时超时或点击关闭) */
  keepWholeEpisode: boolean
}

export type OpedSkipDecision =
  | { action: 'none' }
  | { action: 'prompt'; type: 'op' | 'ed'; targetTime: number }
  | { action: 'skip'; type: 'op' | 'ed'; targetTime: number; hint: string }

/**
 * OP/ED 跳过与首集保护统一决策引擎 (纯函数)
 */
export function determineOpedAction(ctx: OpedSkipContext): OpedSkipDecision {
  if (ctx.isSeeking || ctx.isSkipBusy) return { action: 'none' }

  const t = ctx.currentTime
  const prevT = ctx.prevTime
  const d = ctx.duration

  if (!Number.isFinite(d) || d <= 0 || t >= d - 3) return { action: 'none' }

  // 自然前进判定：单向向前播放，且单帧时间增量在合理范围 (0 < delta <= 3.0s)
  const delta = t - prevT
  const isNaturalPlayback = delta > 0 && delta <= 3.0
  const isEarlyStart = prevT <= 0.5 && t < 2.0

  if (!isNaturalPlayback && !isEarlyStart) return { action: 'none' }

  const p = ctx.playerSettings
  // 若用户关闭了 OP/ED 跳过功能，直接返回 none
  if (p.preferBangumiOped === false) return { action: 'none' }
  // 若本集用户已选择完整播放，直接返回 none
  if (ctx.keepWholeEpisode) return { action: 'none' }

  // 视频源时长审核：若提供了 Bangumi 官方单集时长，且当前视频时长与其绝对差距超过容差 (4s)，
  // 说明当前视频源可能存在片头拼接广告、删减、混剪或集数错位，强制停用跳过以防跳错正片。
  if (
    typeof ctx.expectedDurationSeconds === 'number' &&
    Number.isFinite(ctx.expectedDurationSeconds) &&
    ctx.expectedDurationSeconds > 0
  ) {
    if (
      Math.abs(d - ctx.expectedDurationSeconds) >
      DURATION_MISMATCH_THRESHOLD_S
    ) {
      return { action: 'none' }
    }
  }

  const safeMax = d - 0.1
  const isFirstEp =
    ctx.episodeIndex === 0 ||
    (typeof ctx.episodeIndex !== 'number' && ctx.episodeNumber === 1)
  const shouldProtectFirstEp = (p.firstEpisodeProtect ?? true) && isFirstEp

  // 1. OP 检测
  if (p.skipOp.enabled && p.skipOp.duration > 0) {
    const opStart = p.skipOp.start || 0
    const opDuration = Math.abs(p.skipOp.duration)
    const opEnd = Math.min(opStart + opDuration, safeMax)

    if (t < opEnd) {
      const crossedOpStart =
        (isNaturalPlayback && prevT < opStart && t >= opStart) ||
        (opStart <= 0.5 && prevT <= 0.5 && t >= opStart && t < 2.0 && isNaturalPlayback)

      if (crossedOpStart) {
        if (shouldProtectFirstEp && !ctx.promptTriggeredThisEp) {
          return { action: 'prompt', type: 'op', targetTime: opEnd }
        }
        return { action: 'skip', type: 'op', targetTime: opEnd, hint: '已跳过片头' }
      }
    }
  }

  // 2. ED 检测
  if (p.skipEd.enabled && p.skipEd.duration > 0) {
    const edDuration = Math.abs(p.skipEd.duration)
    const isRelativeEd = (p.skipEd.start || 0) <= 0
    const edStart = isRelativeEd ? d - edDuration : p.skipEd.start
    const edEnd = isRelativeEd ? safeMax : Math.min(edStart + edDuration, safeMax)

    if (t < edEnd && edStart > 0 && edStart < d) {
      const crossedEdStart = isNaturalPlayback && prevT < edStart && t >= edStart
      if (crossedEdStart) {
        if (shouldProtectFirstEp && !ctx.promptTriggeredThisEp) {
          return { action: 'prompt', type: 'ed', targetTime: edEnd }
        }
        return {
          action: 'skip',
          type: 'ed',
          targetTime: edEnd,
          hint: isRelativeEd ? '' : '已跳过片尾',
        }
      }
    }
  }

  return { action: 'none' }
}
