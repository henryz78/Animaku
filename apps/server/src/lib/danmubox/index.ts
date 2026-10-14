import crypto from 'node:crypto'
import {
  DANMUBOX_SOURCES,
  matchArchiveRange,
  type DanmuBoxEntry,
} from '@animaku/shared'
import { fetchPublic } from '../private-host'

const AES_KEY = Buffer.from('jQoRm5OREM7S3qy3ZBgFV8EqPAP6jsZJ', 'utf8')

export interface UpstreamNode {
  name: string
  baseUrl: string
  timeoutMs: number
}

const DEFAULT_UPSTREAMS: UpstreamNode[] = [
  // 1. Direct nodes (no 50MB file size limit)
  {
    name: 'github-pages',
    baseUrl: 'https://dmrepository.github.io/',
    timeoutMs: 2_500,
  },
  {
    name: 'github-raw',
    baseUrl: 'https://raw.githubusercontent.com/dmrepository/',
    timeoutMs: 2_500,
  },
  // 2. High-speed global CDN nodes
  {
    name: 'jsdelivr',
    baseUrl: 'https://cdn.jsdelivr.net/gh/dmrepository/',
    timeoutMs: 8_000,
  },
  {
    name: 'testingcf',
    baseUrl: 'https://testingcf.jsdelivr.net/gh/dmrepository/',
    timeoutMs: 8_000,
  },
  {
    name: 'fastly',
    baseUrl: 'https://fastly.jsdelivr.net/gh/dmrepository/',
    timeoutMs: 8_000,
  },
]

let activeUpstreams: UpstreamNode[] = [...DEFAULT_UPSTREAMS]
let entriesCache: DanmuBoxEntry[] = []
let isInitialized = false
let isInitializing = false
let initPromise: Promise<void> | null = null

/**
 * AES-256-ECB PKCS7 Base64 decryption
 */
export function decryptDanmuBoxCipher(base64Cipher: string): string {
  const decipher = crypto.createDecipheriv('aes-256-ecb', AES_KEY, null)
  decipher.setAutoPadding(true)
  let dec = decipher.update(base64Cipher, 'base64', 'utf8')
  dec += decipher.final('utf8')
  return dec
}

/**
 * Probe network connectivity to determine best upstream priority.
 * If GitHub Pages is directly reachable within 1.5s, prioritize direct nodes;
 * otherwise prioritize jsDelivr CDN nodes to eliminate multi-second timeouts.
 */
export async function probeUpstreamNetwork(): Promise<string> {
  try {
    const probeRes = await fetchPublic(
      'https://dmrepository.github.io/list/index',
      { method: 'HEAD' },
      { timeoutMs: 1_500 },
    )
    if (probeRes.ok) {
      activeUpstreams = [...DEFAULT_UPSTREAMS]
      console.log('[danmubox] 网络探测完成：直连源 (GitHub Pages) 可用，优先使用直连源')
      return 'direct'
    }
  } catch {
    /* fallback to cdn */
  }

  // Elevate CDN nodes to front
  const cdnNodes = DEFAULT_UPSTREAMS.filter((n) => n.name.includes('jsdelivr') || n.name.includes('fastly'))
  const directNodes = DEFAULT_UPSTREAMS.filter((n) => !cdnNodes.includes(n))
  activeUpstreams = [...cdnNodes, ...directNodes]
  console.log('[danmubox] 网络探测完成：直连源握手超时，优先降级使用 CDN 加速源')
  return 'cdn'
}

/**
 * Fetch a relative path across candidate upstreams with automatic failover.
 */
export async function fetchDanmuBoxFile(relativePath: string): Promise<Response> {
  const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath
  let lastError: Error | null = null

  for (const node of activeUpstreams) {
    const url = `${node.baseUrl}${cleanPath}`
    try {
      const res = await fetchPublic(url, {}, { timeoutMs: node.timeoutMs })
      if (res.ok) {
        return res
      }
      try {
        await res.body?.cancel()
      } catch {
        /* ignore */
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw new Error(
    `[danmubox] 所有候选上游节点均拉取失败 (${cleanPath}): ${lastError?.message || '未知错误'}`,
  )
}

/**
 * Initialize DanmuBox:
 * 1. Probes network for best upstream.
 * 2. Fetches index of repos (repo001 ~ repo012).
 * 3. Fetches and decrypts all shard indices into memory.
 */
export async function initDanmuBox(): Promise<void> {
  if (isInitialized) return
  if (isInitializing && initPromise) return initPromise

  isInitializing = true
  initPromise = (async () => {
    try {
      console.log('[danmubox] 开始初始化弹幕盒子索引...')
      await probeUpstreamNetwork()

      const indexRes = await fetchDanmuBoxFile('list/index')
      const indexText = (await indexRes.text()).trim()
      const repos = indexText.split(',').map((r) => r.trim()).filter(Boolean)

      if (repos.length === 0) {
        console.warn('[danmubox] list/index 未返回任何有效分片仓库')
        return
      }

      const allEntries: DanmuBoxEntry[] = []

      await Promise.all(
        repos.map(async (repo) => {
          try {
            const shardRes = await fetchDanmuBoxFile(`list/${repo}`)
            const cipher = (await shardRes.text()).trim()
            if (!cipher) return

            const plain = decryptDanmuBoxCipher(cipher)
            const lines = plain.split(';').filter(Boolean)

            for (const line of lines) {
              const parts = line.split(',')
              if (parts.length >= 4) {
                const title = parts[0].trim()
                const size = parseInt(parts[1], 10) || 0
                const fromIdx = parseInt(parts[2], 10) || 0
                const hash = parts[3].trim()

                if (!title || !hash) continue

                allEntries.push({
                  title,
                  size,
                  source: DANMUBOX_SOURCES[fromIdx] || '未知',
                  repo,
                  fileHash: hash,
                })
              }
            }
          } catch (err) {
            console.error(`[danmubox] 分片 ${repo} 载入失败:`, err)
          }
        }),
      )

      entriesCache = allEntries
      isInitialized = true
      console.log(`[danmubox] 弹幕盒子初始化完成，常驻内存条目总数: ${entriesCache.length}`)
    } catch (err) {
      console.error('[danmubox] 弹幕盒子初始化异常:', err)
    } finally {
      isInitializing = false
    }
  })()

  return initPromise
}

export function isDanmuBoxLoaded(): boolean {
  return isInitialized && entriesCache.length > 0
}

/**
 * Fast in-memory search over 4,299 entries (<1ms).
 * Supports keyword search, target episode range ranking, and max results limit.
 */
export function searchDanmuBox(
  keyword: string,
  opts?: {
    targetEpisode?: number
    limit?: number
  },
): DanmuBoxEntry[] {
  const k = (keyword || '').trim().toLowerCase()
  if (!k || !entriesCache.length) return []

  const targetEp = opts?.targetEpisode
  const limit = opts?.limit ?? 40

  const tokens = k.split(/\s+/).filter(Boolean)

  const matched = entriesCache.filter((item) => {
    const titleLower = item.title.toLowerCase()
    return tokens.every((token) => titleLower.includes(token))
  })

  if (targetEp !== undefined && targetEp > 0) {
    matched.sort((a, b) => {
      const aInRange = matchArchiveRange(a.title, targetEp) ? 1 : 0
      const bInRange = matchArchiveRange(b.title, targetEp) ? 1 : 0
      return bInRange - aInRange
    })
  }

  return matched.slice(0, limit)
}

export function getDanmuBoxEntry(repo: string, fileHash: string): DanmuBoxEntry | undefined {
  return entriesCache.find((e) => e.repo === repo && e.fileHash === fileHash)
}
