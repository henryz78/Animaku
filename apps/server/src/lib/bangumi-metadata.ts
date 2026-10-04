import type {
  BangumiCharacter,
  BangumiEpisode,
  BangumiPerson,
  BangumiRelation,
  BangumiReview,
  BangumiStaff,
  BangumiUser,
} from '@animaku/shared'

type RawRecord = Record<string, unknown>

function record(value: unknown): RawRecord {
  return value && typeof value === 'object' ? (value as RawRecord) : {}
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
    if (Number.isFinite(result) && result > 0) return Math.trunc(result)
  }
  return 0
}

function image(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const images = record(value)
  return text(images.large, images.medium, images.common, images.small, images.grid)
}

function uniqueStrings(values: unknown[]): string[] {
  const flattened = values.flatMap((value) => Array.isArray(value) ? value : [value])
  return [...new Set(flattened.map((value) => String(value ?? '').trim()).filter(Boolean))]
}

export function mapBangumiEpisode(raw: unknown): BangumiEpisode {
  const value = record(raw)
  const names = uniqueStrings([
    value.name_cn,
    value.nameCn,
    value.name,
    ...(Array.isArray(value.aliases) ? value.aliases : []),
  ])
  return {
    id: number(value.id),
    type: number(value.type),
    sort: number(value.sort, value.ep),
    name: text(value.name),
    nameCn: text(value.name_cn, value.nameCn),
    airdate: text(value.airdate, value.airDate),
    ep: value.ep == null ? undefined : number(value.ep),
    duration_seconds: number(value.duration_seconds, value.durationSeconds),
    imageMedium: text(value.image_medium, value.imageMedium) || undefined,
    imageLarge: text(value.image_large, value.imageLarge) || undefined,
    aliases: names.length > 0 ? names : undefined,
  }
}

function mapPerson(raw: unknown, fallback?: unknown): BangumiPerson {
  const value = record(raw)
  const source = Object.keys(value).length > 0 ? value : record(fallback)
  return {
    id: number(source.id),
    name: text(source.name),
    nameCn: text(source.name_cn, source.nameCn),
    relation: text(source.relation, source.role) || undefined,
    career: Array.isArray(source.career)
      ? uniqueStrings(source.career)
      : Array.isArray(source.careers)
        ? uniqueStrings(source.careers)
        : undefined,
    image: image(source.images || source.image) || undefined,
  }
}

export function mapBangumiCharacters(raw: unknown): BangumiCharacter[] {
  const rows = Array.isArray(raw) ? raw : []
  return rows
    .map((entry) => {
      const row = record(entry)
      const source = record(row.character || row)
      const actorRows = Array.isArray(row.actors)
        ? row.actors
        : Array.isArray(source.actors)
          ? source.actors
          : []
      const actors = actorRows.map((actor) => {
        const actorRow = record(actor)
        return mapPerson(actorRow.person || actorRow)
      }).filter((person) => person.id > 0 || person.name)
      return {
        id: number(source.id),
        name: text(source.name),
        nameCn: text(source.name_cn, source.nameCn),
        role: text(row.type, row.role, source.role) || undefined,
        image: image(source.images || source.image) || undefined,
        actors,
      }
    })
    .filter((character) => character.id > 0 || character.name)
}

export function mapBangumiStaff(raw: unknown): BangumiStaff[] {
  const rows = Array.isArray(raw) ? raw : []
  return rows
    .map((entry) => {
      const row = record(entry)
      const source = record(row.person || row)
      const positions = uniqueStrings([
        row.position,
        row.positions,
        source.relation,
        source.position,
        source.positions,
        source.career,
        source.careers,
      ])
      return {
        id: number(source.id),
        name: text(source.name),
        nameCn: text(source.name_cn, source.nameCn),
        positions,
        image: image(source.images || source.image) || undefined,
      }
    })
    .filter((person) => person.id > 0 || person.name)
}

export function mapBangumiRelations(raw: unknown): BangumiRelation[] {
  const rows = Array.isArray(raw) ? raw : []
  return rows
    .map((entry) => {
      const row = record(entry)
      const source = record(row.subject || row)
      return {
        id: number(source.id, row.id),
        name: text(source.name, row.name),
        nameCn: text(source.name_cn, source.nameCn, row.name_cn, row.nameCn),
        relation: text(row.relation, row.relation_cn) || '关联',
        image: image(source.images || source.image) || undefined,
      }
    })
    .filter((relation) => relation.id > 0 || relation.name)
}

function mapReviewUser(raw: unknown): BangumiUser {
  const value = record(raw)
  const avatar = record(value.avatar)
  const avatarValues = {
    small: text(avatar.small),
    medium: text(avatar.medium),
    large: text(avatar.large),
  }
  const hasAvatar = Object.values(avatarValues).some(Boolean)
  return {
    id: number(value.id),
    username: text(value.username, value.nickname),
    nickname: text(value.nickname, value.username, '匿名用户'),
    avatar: hasAvatar ? avatarValues : undefined,
  }
}

export function mapBangumiReviews(raw: unknown): { data: BangumiReview[]; total: number } {
  const root = record(raw)
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.reviews)
        ? root.reviews
        : []
  const data = rows.map((entry, index) => {
    const value = record(entry)
    const reviewEntry = record(value.entry)
    const content = text(
      value.content,
      value.comment,
      value.content_bbcode,
      reviewEntry.content,
      reviewEntry.summary,
    )
    const updatedAt = text(
      value.updatedAt,
      value.updated_at,
      value.createdAt,
      value.created_at,
      reviewEntry.updatedAt,
      reviewEntry.updated_at,
      reviewEntry.createdAt,
      reviewEntry.created_at,
    )
    return {
      id:
        typeof value.id === 'string' || typeof value.id === 'number'
          ? value.id
          : `bangumi-review-${index}`,
      user: mapReviewUser(value.user || value.author),
      content,
      score: Number(value.rating ?? value.rate ?? value.score) || undefined,
      updatedAt,
      source: 'bangumi' as const,
    }
  }).filter((review) => review.content || review.user.id > 0 || review.user.nickname)
  return { data, total: number(root.total, data.length) || data.length }
}

