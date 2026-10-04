import type { BangumiEpisode, BangumiItem } from '@animaku/shared'
import { normalizeBangumiTitle } from '@animaku/shared'

const TMDB_API = 'https://api.themoviedb.org/3'
const TMDB_IMAGE = 'https://image.tmdb.org/t/p'
const CACHE_TTL = 12 * 60 * 60_000

type RawRecord = Record<string, unknown>

export type TmdbEpisode = {
  id: number
  episodeNumber: number
  seasonNumber: number
  name: string
  originalName: string
  airDate: string
  stillPath: string
}

type CachedImageMap = {
  expiresAt: number
  images: Map<number, { imageMedium: string; imageLarge: string }>
}

const imageCache = new Map<number, CachedImageMap>()

function record(value: unknown): RawRecord {
  return value && typeof value === 'object' ? value as RawRecord : {}
}

function text(...values: unknown[]): string {
  for (const value of values) {
    const result = String(value ?? '').trim()
    if (result) return result
  }
  return ''
}

function number(...values: unknown[]): number {
  for (const value of values) {
    const result = Number(value)
    if (Number.isFinite(result)) return Math.trunc(result)
  }
  return 0
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/** Remove a season/arc suffix so TMDB can find the parent TV series. */
function baseTitle(value: string): string {
  return value
    .replace(/\s+\d+(?:st|nd|rd|th)\s+season\b.*$/iu, '')
    .replace(/\s+season\s*\d+\b.*$/iu, '')
    .replace(/\s+第[一二三四五六七八九十百\d]+季.*$/u, '')
    .trim()
}

function seasonHint(subject: BangumiItem): number {
  const titles = [subject.nameCn, subject.name, ...subject.alias]
  const chineseDigits: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  }
  for (const title of titles) {
    const arabic = title.match(/\b(\d+)(?:st|nd|rd|th)?\s+season\b/iu)
    if (arabic) return Number(arabic[1]) || 0
    const chinese = title.match(/第([一二三四五六七八九十百\d]+)季/u)
    if (!chinese) continue
    if (/^\d+$/.test(chinese[1])) return Number(chinese[1]) || 0
    if (chinese[1] === '十') return 10
    return chinese[1].split('').reduce((sum, digit) => sum + (chineseDigits[digit] || 0), 0)
  }
  return 0
}

function titleValues(episode: BangumiEpisode): string[] {
  return unique([episode.nameCn, episode.name, ...(episode.aliases || [])])
}

function dateOnly(value: string): string {
  return value.trim().slice(0, 10)
}

function imageUrl(size: 'w300' | 'original', path: string): string {
  return `${TMDB_IMAGE}/${size}${path.startsWith('/') ? path : `/${path}`}`
}

function mapRawEpisode(raw: unknown): TmdbEpisode | null {
  const value = record(raw)
  const stillPath = text(value.still_path, value.stillPath)
  const episodeNumber = number(value.episode_number, value.episodeNumber)
  if (!stillPath || episodeNumber <= 0) return null
  return {
    id: number(value.id),
    episodeNumber,
    seasonNumber: number(value.season_number, value.seasonNumber),
    name: text(value.name),
    originalName: text(value.original_name, value.originalName),
    airDate: text(value.air_date, value.airDate),
    stillPath,
  }
}

function scoreEpisodeMatch(
  episode: BangumiEpisode,
  tmdb: TmdbEpisode,
): number {
  const names = titleValues(episode)
    .map(normalizeBangumiTitle)
    .filter(Boolean)
  const tmdbNames = [tmdb.name, tmdb.originalName]
    .map(normalizeBangumiTitle)
    .filter(Boolean)
  let score = 0
  if (episode.sort === tmdb.episodeNumber) score += 60
  if (episode.ep != null && episode.ep > 0 && episode.ep === tmdb.episodeNumber) score += 45
  if (dateOnly(episode.airdate) && dateOnly(episode.airdate) === dateOnly(tmdb.airDate)) score += 35
  for (const left of names) {
    for (const right of tmdbNames) {
      if (left === right) score += 100
      else if (left.includes(right) || right.includes(left)) score += 45
    }
  }
  return score
}

/**
 * Attach TMDB still URLs to Bangumi main-story episodes.  Numeric matching is
 * preferred, while title/date matching protects shows whose TMDB season uses
 * local numbering or whose translated titles differ slightly.
 */
export function mapTmdbEpisodeImages(
  episodes: BangumiEpisode[],
  tmdbEpisodes: TmdbEpisode[],
): BangumiEpisode[] {
  const used = new Set<number>()
  return episodes.map((episode) => {
    if (episode.type !== 0 || episode.id <= 0) return episode
    const candidates = tmdbEpisodes
      .filter((candidate) => candidate.id <= 0 || !used.has(candidate.id))
      .map((candidate) => ({ candidate, score: scoreEpisodeMatch(episode, candidate) }))
      .filter((entry) => entry.score >= 35)
      .sort((a, b) => b.score - a.score)
    const match = candidates[0]?.candidate
    if (!match) return episode
    if (match.id > 0) used.add(match.id)
    return {
      ...episode,
      imageMedium: imageUrl('w300', match.stillPath),
      imageLarge: imageUrl('original', match.stillPath),
    }
  })
}

function scoreTvCandidate(subject: BangumiItem, result: RawRecord): number {
  const names = unique([subject.nameCn, subject.name, ...subject.alias, ...[subject.nameCn, subject.name, ...subject.alias].map(baseTitle)])
    .map(normalizeBangumiTitle)
    .filter(Boolean)
  const resultNames = [text(result.name), text(result.original_name, result.originalName)]
    .map(normalizeBangumiTitle)
    .filter(Boolean)
  let score = Number(result.popularity || 0) / 100
  for (const left of names) {
    for (const right of resultNames) {
      if (left === right) score += 100
      else if (left.includes(right) || right.includes(left)) score += 35
    }
  }
  const subjectYear = Number(subject.airDate.slice(0, 4))
  const resultYear = Number(text(result.first_air_date, result.firstAirDate).slice(0, 4))
  if (subjectYear > 1900 && resultYear > 1900) {
    score += Math.max(0, 20 - Math.abs(subjectYear - resultYear) * 4)
  }
  return score
}

async function tmdbJson(
  path: string,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<unknown> {
  const url = new URL(`${TMDB_API}${path}`)
  url.searchParams.set('api_key', apiKey)
  const response = await fetcher(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': 'Animaku TMDB integration' },
  })
  if (!response.ok) throw new Error(`TMDB ${response.status}`)
  return response.json()
}

async function findTmdbEpisodes(
  subject: BangumiItem,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<TmdbEpisode[]> {
  const rawTitles = [subject.nameCn, subject.name, ...subject.alias]
  const queries = unique([...rawTitles, ...rawTitles.map(baseTitle)]).slice(0, 6)
  const results: RawRecord[] = []
  const seenIds = new Set<number>()
  for (const query of queries) {
    const data = record(await tmdbJson(
      `/search/tv?query=${encodeURIComponent(query)}&language=zh-CN&include_adult=false`,
      apiKey,
      fetcher,
    ))
    if (Array.isArray(data.results)) {
      for (const result of data.results.map(record)) {
        const id = number(result.id)
        if (id > 0 && seenIds.has(id)) continue
        if (id > 0) seenIds.add(id)
        results.push(result)
      }
    }
  }
  const candidate = results
    .sort((a, b) => scoreTvCandidate(subject, b) - scoreTvCandidate(subject, a))[0]
  const tmdbId = number(candidate?.id)
  if (tmdbId <= 0) return []

  const details = record(await tmdbJson(`/tv/${tmdbId}?language=zh-CN`, apiKey, fetcher))
  const seasons = Array.isArray(details.seasons) ? details.seasons.map(record) : []
  const nonSpecial = seasons.filter((season) => number(season.season_number, season.seasonNumber) > 0)
  const subjectYear = Number(subject.airDate.slice(0, 4))
  const seasonCandidates = nonSpecial.length > 0 ? nonSpecial : seasons
  const hintedSeason = seasonHint(subject)
  const season = (hintedSeason > 0
    ? seasonCandidates.filter((value) => number(value.season_number, value.seasonNumber) === hintedSeason)
    : []).concat(seasonCandidates)
    .filter((value, index, all) => all.findIndex((candidate) => number(candidate.season_number, candidate.seasonNumber) === number(value.season_number, value.seasonNumber)) === index)
    .sort((a, b) => {
      const yearScore = (value: RawRecord) => {
        const year = Number(text(value.air_date, value.airDate).slice(0, 4))
        return subjectYear > 1900 && year > 1900 ? Math.abs(subjectYear - year) : 999
      }
      return yearScore(a) - yearScore(b)
    })[0]
  const seasonNumber = number(season?.season_number, season?.seasonNumber)
  if (seasonNumber < 0) return []
  const seasonData = record(await tmdbJson(`/tv/${tmdbId}/season/${seasonNumber}?language=zh-CN`, apiKey, fetcher))
  return (Array.isArray(seasonData.episodes) ? seasonData.episodes : [])
    .map(mapRawEpisode)
    .filter((episode): episode is TmdbEpisode => episode != null)
}

/** Fetch and cache one subject's TMDB still mapping. Errors are intentionally propagated to the caller. */
export async function enrichBangumiEpisodesWithTmdb(
  subject: BangumiItem,
  episodes: BangumiEpisode[],
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<BangumiEpisode[]> {
  const cached = imageCache.get(subject.id)
  if (cached && cached.expiresAt > Date.now()) {
    return episodes.map((episode) => {
      const image = cached.images.get(episode.id)
      return image ? { ...episode, ...image } : episode
    })
  }
  const tmdbEpisodes = await findTmdbEpisodes(subject, apiKey, fetcher)
  const mapped = mapTmdbEpisodeImages(episodes, tmdbEpisodes)
  // Do not retain an empty result: a transient TMDB/search failure must be
  // retried on the next request instead of hiding stills for half a day.
  if (tmdbEpisodes.length === 0) return episodes
  const images = new Map<number, { imageMedium: string; imageLarge: string }>()
  for (const episode of mapped) {
    if (episode.imageMedium && episode.imageLarge) {
      images.set(episode.id, { imageMedium: episode.imageMedium, imageLarge: episode.imageLarge })
    }
  }
  imageCache.set(subject.id, { expiresAt: Date.now() + CACHE_TTL, images })
  return mapped
}

