import test from 'node:test'
import assert from 'node:assert/strict'
import { mapTmdbEpisodeImages, type TmdbEpisode } from './tmdb-episodes'
import type { BangumiEpisode } from '@animaku/shared'

function episode(overrides: Partial<BangumiEpisode> = {}): BangumiEpisode {
  return {
    id: 1,
    type: 0,
    sort: 1,
    name: 'Episode One',
    nameCn: '第一集',
    airdate: '2024-01-01',
    duration_seconds: 0,
    ...overrides,
  }
}

function tmdb(overrides: Partial<TmdbEpisode> = {}): TmdbEpisode {
  return {
    id: 100,
    episodeNumber: 1,
    seasonNumber: 1,
    name: 'Episode One',
    originalName: 'Episode One',
    airDate: '2024-01-01',
    stillPath: '/still.jpg',
    ...overrides,
  }
}

test('maps TMDB stills to main episodes by stable episode number', () => {
  const mapped = mapTmdbEpisodeImages([
    episode({ id: 1, sort: 1 }),
    episode({ id: 2, sort: 2, nameCn: '第二集', name: 'Episode Two' }),
  ], [
    tmdb({ id: 100, episodeNumber: 1, stillPath: '/one.jpg' }),
    tmdb({ id: 101, episodeNumber: 2, stillPath: '/two.jpg' }),
  ])

  assert.equal(mapped[0].imageMedium, 'https://image.tmdb.org/t/p/w300/one.jpg')
  assert.equal(mapped[1].imageLarge, 'https://image.tmdb.org/t/p/original/two.jpg')
})

test('does not assign duplicate TMDB stills or special episodes', () => {
  const mapped = mapTmdbEpisodeImages([
    episode({ id: 1, sort: 1 }),
    episode({ id: 2, sort: 1 }),
    episode({ id: 3, type: 1, sort: 1 }),
  ], [tmdb({ id: 100, episodeNumber: 1 })])

  assert.ok(mapped[0].imageMedium)
  assert.equal(mapped[1].imageMedium, undefined)
  assert.equal(mapped[2].imageMedium, undefined)
})

