import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mapBangumiCharacters,
  mapBangumiEpisode,
  mapBangumiRelations,
  mapBangumiReviews,
  mapBangumiStaff,
} from './bangumi-metadata.js'

test('maps episode aliases and optional upstream stills without inventing artwork', () => {
  const episode = mapBangumiEpisode({
    id: 42,
    type: 0,
    sort: 14,
    ep: 2,
    name: 'Original title',
    name_cn: '第二话',
    image_medium: 'https://cdn.test/still-medium.jpg',
  })
  assert.equal(episode.id, 42)
  assert.equal(episode.sort, 14)
  assert.equal(episode.ep, 2)
  assert.deepEqual(episode.aliases, ['第二话', 'Original title'])
  assert.equal(episode.imageMedium, 'https://cdn.test/still-medium.jpg')
  assert.equal(episode.imageLarge, undefined)
})

test('maps Bangumi characters, actors, staff and relations', () => {
  const characters = mapBangumiCharacters([
    {
      character: { id: 1, name: 'Alice', name_cn: '爱丽丝', images: { medium: 'char.jpg' } },
      type: 1,
      actors: [{ person: { id: 2, name: 'Voice', name_cn: '配音' } }],
    },
  ])
  const staff = mapBangumiStaff([
    { id: 3, name: 'Director', relation: '导演', career: ['producer'] },
  ])
  const relations = mapBangumiRelations([
    { id: 4, relation: '续集', name: 'Next', name_cn: '后续' },
  ])
  assert.equal(characters[0].actors[0].nameCn, '配音')
  assert.equal(characters[0].role, '主角')
  assert.equal(staff[0].positions[0], '导演')
  assert.equal(relations[0].relation, '续集')
})

test('maps reviews from Bangumi private API payloads', () => {
  const reviews = mapBangumiReviews({
    total: 1,
    data: [{
      id: 9,
      user: { id: 5, nickname: '用户' },
      entry: { summary: '很好看', createdAt: 1700000000 },
      rate: 9,
    }],
  })
  assert.equal(reviews.total, 1)
  assert.equal(reviews.data[0].user.nickname, '用户')
  assert.equal(reviews.data[0].score, 9)
  assert.equal(reviews.data[0].content, '很好看')
  assert.equal(reviews.data[0].updatedAt, '1700000000')
})

