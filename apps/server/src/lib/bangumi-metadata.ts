import type {
  BangumiCharacter,
  BangumiCharacterDetail,
  BangumiEpisode,
  BangumiInfoboxEntry,
  BangumiPerson,
  BangumiPersonDetail,
  BangumiRelation,
  BangumiReview,
  BangumiStaff,
  BangumiUser,
  BangumiWorkReference,
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

function characterRole(value: unknown): string | undefined {
  const numeric = Number(value)
  if (numeric === 1) return '主角'
  if (numeric === 2) return '配角'
  if (numeric === 3) return '客串'
  const label = text(value)
  return label || undefined
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
        role: characterRole(row.type ?? row.role ?? source.role),
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

function mapInfobox(raw: unknown): BangumiInfoboxEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const value = record(entry)
    const key = text(value.key)
    const rawValue = value.value
    const values = Array.isArray(rawValue)
      ? rawValue.map((item) => {
        const object = record(item)
        return text(object.v, object.value, item)
      }).filter(Boolean)
      : [text(rawValue)]
    return { key, value: values.join('、') }
  }).filter((entry) => entry.key || entry.value)
}

function mapWorkReference(raw: unknown): BangumiWorkReference | null {
  const value = record(raw)
  const id = number(value.id, value.subject_id, value.subjectId)
  const name = text(value.name, value.subject_name)
  const nameCn = text(value.name_cn, value.nameCn, value.subject_name_cn)
  if (id <= 0 && !name && !nameCn) return null
  return {
    id,
    name,
    nameCn,
    image: image(value.image || value.images) || undefined,
    role: text(value.staff, value.role, value.relation) || undefined,
    eps: text(value.eps) || undefined,
    type: Number(value.type) || undefined,
  }
}

export function mapBangumiCharacterDetail(raw: unknown, worksRaw: unknown): BangumiCharacterDetail {
  const value = record(raw)
  const stats = record(value.stat)
  const works = Array.isArray(worksRaw)
    ? worksRaw.map(mapWorkReference).filter((work): work is BangumiWorkReference => work != null)
    : []
  return {
    id: number(value.id),
    name: text(value.name),
    nameCn: text(value.name_cn, value.nameCn),
    summary: text(value.summary),
    image: image(value.images || value.image) || undefined,
    gender: text(value.gender) || undefined,
    infobox: mapInfobox(value.infobox),
    collects: Number(stats.collects) || undefined,
    comments: Number(stats.comments) || undefined,
    actors: [],
    works,
  }
}

export function mapBangumiPersonDetail(raw: unknown, worksRaw: unknown, charactersRaw: unknown): BangumiPersonDetail {
  const value = record(raw)
  const works = Array.isArray(worksRaw)
    ? worksRaw.map(mapWorkReference).filter((work): work is BangumiWorkReference => work != null)
    : []
  const characters = Array.isArray(charactersRaw)
    ? charactersRaw.map((entry) => {
      const row = record(entry)
      return mapWorkReference({
        id: row.subject_id,
        name: row.subject_name,
        name_cn: row.subject_name_cn,
        image: row.images,
        role: row.staff,
      })
    }).filter((work): work is BangumiWorkReference => work != null)
    : []
  return {
    id: number(value.id),
    name: text(value.name),
    nameCn: text(value.name_cn, value.nameCn),
    summary: text(value.summary),
    image: image(value.images || value.image) || undefined,
    career: Array.isArray(value.career) ? uniqueStrings(value.career) : [],
    infobox: mapInfobox(value.infobox),
    works,
    characters,
  }
}

