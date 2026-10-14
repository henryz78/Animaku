import { Hono } from 'hono'
import {
  initDanmuBox,
  isDanmuBoxLoaded,
  searchDanmuBox,
  getDanmuBoxEntry,
} from '../lib/danmubox/index'
import {
  ensureArchiveUnpacked,
  getDanmuBoxEpisodeComments,
} from '../lib/danmubox/archive'
import {
  setDanmuBoxCdnHeaders,
  setDanmakuCdnHeaders,
} from '../lib/cdn-cache-headers'
import { wantsCacheBypass } from '../lib/ttl-cache'

export const danmuboxRoutes = new Hono()

danmuboxRoutes.get('/danmubox/status', (c) => {
  return c.json({
    loaded: isDanmuBoxLoaded(),
  })
})

danmuboxRoutes.get('/danmubox/search', async (c) => {
  const keyword = (c.req.query('keyword') || '').trim()
  if (!keyword) {
    return c.json({ error: 'bad_request', message: '缺少 keyword 搜索词' }, 400)
  }

  const rawEp = c.req.query('targetEp') || c.req.query('ep')
  const targetEpisode = rawEp ? parseInt(rawEp, 10) : undefined
  const rawLimit = c.req.query('limit')
  const limit = rawLimit ? parseInt(rawLimit, 10) : 40

  try {
    if (!isDanmuBoxLoaded()) {
      await initDanmuBox()
    }

    const results = searchDanmuBox(keyword, {
      targetEpisode: Number.isFinite(targetEpisode) ? targetEpisode : undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 40,
    })

    const bypass = wantsCacheBypass(c)
    setDanmakuCdnHeaders(c, bypass)

    return c.json({ data: results })
  } catch (err) {
    return c.json(
      {
        error: 'danmubox_search_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    )
  }
})

danmuboxRoutes.get('/danmubox/episodes', async (c) => {
  const repo = (c.req.query('repo') || '').trim()
  const hash = (c.req.query('hash') || '').trim()

  if (!repo || !hash) {
    return c.json({ error: 'bad_request', message: '缺少 repo 或 hash 参数' }, 400)
  }

  try {
    const files = await ensureArchiveUnpacked(repo, hash)
    const entry = getDanmuBoxEntry(repo, hash)

    const bypass = wantsCacheBypass(c)
    setDanmuBoxCdnHeaders(c, bypass)

    return c.json({
      data: files,
      entry: entry || null,
    })
  } catch (err) {
    return c.json(
      {
        error: 'danmubox_episodes_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    )
  }
})

async function handleCommentsFetch(c: import('hono').Context, repo: string, hash: string) {
  if (!repo || !hash) {
    return c.json({ error: 'bad_request', message: '缺少 repo 或 hash 参数' }, 400)
  }

  const file = c.req.query('file')?.trim()
  const rawEp = c.req.query('ep') || c.req.query('episode')
  const episode = rawEp ? parseInt(rawEp, 10) : undefined
  const seasonTag = c.req.query('season')?.trim()

  const bypass = wantsCacheBypass(c)

  try {
    const result = await getDanmuBoxEpisodeComments(repo, hash, {
      file: file || undefined,
      episode: Number.isFinite(episode) ? episode : undefined,
      seasonTag: seasonTag || undefined,
    })

    setDanmuBoxCdnHeaders(c, bypass)

    return c.json({
      data: result.comments,
      count: result.count,
      file: result.file,
      allFiles: result.allFiles,
    })
  } catch (err) {
    return c.json(
      {
        error: 'danmubox_comments_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    )
  }
}

danmuboxRoutes.get('/danmubox/comments', (c) => {
  const repo = (c.req.query('repo') || '').trim()
  const hash = (c.req.query('hash') || '').trim()
  return handleCommentsFetch(c, repo, hash)
})

danmuboxRoutes.get('/danmubox/comments/:repo/:hash', (c) => {
  const repo = c.req.param('repo')
  const hash = decodeURIComponent(c.req.param('hash'))
  return handleCommentsFetch(c, repo, hash)
})
