import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type {
  BangumiCharacter,
  BangumiCharacterDetail,
  BangumiPerson,
  BangumiPersonDetail,
  BangumiReview,
  BangumiSubjectMetadata,
} from '@animaku/shared'
import { toBangumiOfficialImageUrl } from '@animaku/shared'
import { bangumiApi } from '../../lib/bangumi'

function displayName(value: { nameCn?: string; name?: string }): string {
  return value.nameCn?.trim() || value.name?.trim() || '未知'
}

function ExpandButton({
  expanded,
  onClick,
  hidden,
}: {
  expanded: boolean
  onClick: () => void
  hidden: number
}) {
  if (!expanded && hidden <= 0) return null
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 text-xs font-medium text-[var(--kz-accent)] hover:underline"
    >
      {expanded ? '收起' : `查看全部（还有 ${hidden} 个）`}
    </button>
  )
}

function Avatar({ src, alt, className = 'h-10 w-10' }: { src?: string; alt: string; className?: string }) {
  const [imageSrc, setImageSrc] = useState(src)
  useEffect(() => setImageSrc(src), [src])
  const handleImageError = () => {
    const officialSrc = toBangumiOfficialImageUrl(imageSrc || '')
    if (officialSrc && officialSrc !== imageSrc) {
      setImageSrc(officialSrc)
    } else {
      setImageSrc(undefined)
    }
  }
  return imageSrc ? (
    <img
      src={imageSrc}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={handleImageError}
      className={`${className} shrink-0 rounded-lg object-cover ring-1 ring-[var(--kz-border)]`}
    />
  ) : (
    <span
      aria-hidden
      title={alt || '暂无头像'}
      className={`${className} inline-flex shrink-0 items-center justify-center rounded-lg bg-[var(--kz-bg-soft)] text-xs text-[var(--kz-fg-dim)] ring-1 ring-[var(--kz-border)]`}
    >
      {alt.trim().slice(0, 1) || '图'}
    </span>
  )
}

function CharacterCard({ character, onSelect }: { character: BangumiCharacter; onSelect: (id: number, actors: BangumiPerson[]) => void }) {
  const characterContent = (
    <>
      <Avatar src={character.image} alt={displayName(character)} className="h-12 w-10" />
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-[var(--kz-fg)]">
          {displayName(character)}
        </p>
        {character.nameCn && character.name && character.nameCn !== character.name ? (
          <p className="truncate text-[10px] text-[var(--kz-fg-dim)]">{character.name}</p>
        ) : null}
        {character.role ? (
          <p className="mt-1 truncate text-[10px] text-[var(--kz-fg-muted)]">{character.role}</p>
        ) : null}
      </div>
    </>
  )
  return (
    <div className="min-w-0 rounded-xl border border-[var(--kz-border)]/60 bg-[var(--kz-bg-soft)]/45 p-2">
      {character.id > 0 ? (
        <button
          type="button"
          onClick={() => onSelect(character.id, character.actors)}
          className="flex min-w-0 gap-2 hover:text-[var(--kz-accent)]"
          title={`查看 ${displayName(character)} 的详细资料`}
        >
          {characterContent}
        </button>
      ) : (
        <div className="flex min-w-0 gap-2">{characterContent}</div>
      )}
    </div>
  )
}

function StaffCard({ person, onSelect }: { person: BangumiPerson & { positions?: string[] }; onSelect: (id: number) => void }) {
  const content = (
    <>
      <Avatar src={person.image} alt={displayName(person)} />
      <div className="min-w-0">
        <p className="truncate text-xs text-[var(--kz-fg)]">{displayName(person)}</p>
        <p className="truncate text-[10px] text-[var(--kz-fg-muted)]">
          {person.positions?.join('、') || person.relation || person.career?.join('、') || '制作人员'}
        </p>
      </div>
    </>
  )
  return person.id > 0 ? (
    <button
      type="button"
      onClick={() => onSelect(person.id)}
      className="flex min-w-0 items-center gap-2 rounded-xl border border-[var(--kz-border)]/60 bg-[var(--kz-bg-soft)]/35 p-2 hover:text-[var(--kz-accent)]"
      title={`查看 ${displayName(person)} 的详细资料`}
    >
      {content}
    </button>
  ) : (
    <div className="flex min-w-0 items-center gap-2 p-2">{content}</div>
  )
}

function ReviewCard({ review }: { review: BangumiReview }) {
  return (
    <article className="rounded-xl bg-[var(--kz-bg-soft)]/50 p-2.5">
      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--kz-fg-muted)]">
        <span>{review.user.nickname || review.user.username || '匿名用户'}</span>
        {review.score ? <span>评分 {review.score}</span> : null}
      </div>
      <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-[var(--kz-fg)]">
        {review.content}
      </p>
    </article>
  )
}

function EntityDialog({
  selected,
  onClose,
  onSelect,
}: {
  selected: { kind: 'character' | 'person'; id: number; actors?: BangumiPerson[] }
  onClose: () => void
  onSelect: (selected: { kind: 'character' | 'person'; id: number; actors?: BangumiPerson[] }) => void
}) {
  const characterQuery = useQuery({
    queryKey: ['bangumi-character', selected.id],
    queryFn: ({ signal }) => bangumiApi.character(selected.id, { signal }),
    enabled: selected.kind === 'character',
    staleTime: 60 * 60_000,
  })
  const personQuery = useQuery({
    queryKey: ['bangumi-person', selected.id],
    queryFn: ({ signal }) => bangumiApi.person(selected.id, { signal }),
    enabled: selected.kind === 'person',
    staleTime: 60 * 60_000,
  })
  const loading = selected.kind === 'character' ? characterQuery.isLoading : personQuery.isLoading
  const error = selected.kind === 'character' ? characterQuery.isError : personQuery.isError
  const detail = (selected.kind === 'character' ? characterQuery.data?.data : personQuery.data?.data) as BangumiCharacterDetail | BangumiPersonDetail | undefined
  const title = detail ? displayName(detail) : selected.kind === 'character' ? '角色详情' : '人员详情'

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="absolute inset-0 cursor-default" aria-label="关闭详情" onClick={onClose} />
      <div className="relative z-10 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-[var(--kz-bg-elevated)] p-4 shadow-2xl sm:rounded-2xl sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-[var(--kz-fg)]">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-[var(--kz-fg-muted)] hover:bg-[var(--kz-bg-hover)]">关闭</button>
        </div>
        {loading ? <p className="text-sm text-[var(--kz-fg-muted)]">正在加载详情…</p> : null}
        {error ? <p className="text-sm text-[var(--kz-fg-muted)]">详情暂时加载失败。</p> : null}
        {detail ? (
          <div className="space-y-5">
            <div className="flex gap-4">
              <Avatar src={detail.image} alt={displayName(detail)} className="h-28 w-24 rounded-xl" />
              <div className="min-w-0">
                <h3 className="text-base font-medium text-[var(--kz-fg)]">{displayName(detail)}</h3>
                {detail.nameCn && detail.name && detail.nameCn !== detail.name ? <p className="mt-1 text-sm text-[var(--kz-fg-muted)]">{detail.name}</p> : null}
                {'gender' in detail && detail.gender ? <p className="mt-2 text-xs text-[var(--kz-fg-muted)]">性别：{detail.gender}</p> : null}
                {'career' in detail && detail.career.length > 0 ? <p className="mt-2 text-xs text-[var(--kz-fg-muted)]">类型：{detail.career.join('、')}</p> : null}
                {'collects' in detail && detail.collects ? <p className="mt-2 text-xs text-[var(--kz-fg-muted)]">{detail.collects} 人收藏</p> : null}
              </div>
            </div>
            {detail.summary ? <section><h3 className="mb-1 text-sm font-semibold text-[var(--kz-fg)]">简介</h3><p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--kz-fg-muted)]">{detail.summary}</p></section> : null}
            {detail.infobox.length > 0 ? <section><h3 className="mb-2 text-sm font-semibold text-[var(--kz-fg)]">基本信息</h3><dl className="grid gap-2 text-xs sm:grid-cols-2">{detail.infobox.map((entry) => <div key={entry.key}><dt className="text-[var(--kz-fg-dim)]">{entry.key}</dt><dd className="text-[var(--kz-fg)]">{entry.value}</dd></div>)}</dl></section> : null}
            {selected.kind === 'character' && selected.actors && selected.actors.length > 0 ? (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-[var(--kz-fg)]">配音演员</h3>
                <div className="flex flex-wrap gap-2">
                  {selected.actors.map((actor) => actor.id > 0 ? (
                    <button key={`${actor.id}-${actor.name}`} type="button" onClick={() => onSelect({ kind: 'person', id: actor.id })} className="flex items-center gap-2 rounded-lg bg-[var(--kz-bg-soft)]/60 px-2 py-1.5 text-left hover:text-[var(--kz-accent)]">
                      <Avatar src={actor.image} alt={displayName(actor)} className="h-8 w-8 rounded-full" />
                      <span className="text-xs">{displayName(actor)}</span>
                    </button>
                  ) : <span key={actor.name} className="rounded-lg bg-[var(--kz-bg-soft)]/60 px-2 py-1.5 text-xs">{displayName(actor)}</span>)}
                </div>
              </section>
            ) : null}
            {'characters' in detail && detail.characters.length > 0 ? <section><h3 className="mb-2 text-sm font-semibold text-[var(--kz-fg)]">出演角色（{detail.characters.length}）</h3><div className="grid gap-2 sm:grid-cols-2">{detail.characters.slice(0, 12).map((work) => <Link key={`${work.id}-${work.name}`} to={work.id > 0 ? `/subject/${work.id}` : '#'} onClick={onClose} className="flex gap-2 rounded-lg bg-[var(--kz-bg-soft)]/50 p-2 hover:text-[var(--kz-accent)]"><Avatar src={work.image} alt={work.nameCn || work.name} className="h-12 w-9" /><span className="min-w-0 truncate text-xs">{work.nameCn || work.name}</span></Link>)}</div></section> : null}
            {'works' in detail && detail.works.length > 0 ? <section><h3 className="mb-2 text-sm font-semibold text-[var(--kz-fg)]">参与作品（{detail.works.length}）</h3><div className="grid gap-2 sm:grid-cols-2">{detail.works.slice(0, 12).map((work) => <Link key={`${work.id}-${work.name}`} to={work.id > 0 ? `/subject/${work.id}` : '#'} onClick={onClose} className="flex gap-2 rounded-lg bg-[var(--kz-bg-soft)]/50 p-2 hover:text-[var(--kz-accent)]"><Avatar src={work.image} alt={work.nameCn || work.name} className="h-12 w-9" /><span className="min-w-0"><span className="block truncate text-xs">{work.nameCn || work.name}</span>{work.role ? <span className="block truncate text-[10px] text-[var(--kz-fg-muted)]">{work.role}</span> : null}</span></Link>)}</div></section> : null}
            <p className="text-[11px] text-[var(--kz-fg-dim)]">评论数据由 Bangumi 官方接口提供；当前接口没有单独的角色/人员评论列表，因此这里显示可用的简介、收藏和作品信息。</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function BangumiMetadataPanel({ subjectId }: { subjectId: number }) {
  const [selected, setSelected] = useState<{ kind: 'character' | 'person'; id: number; actors?: BangumiPerson[] } | null>(null)
  const [charactersOpen, setCharactersOpen] = useState(false)
  const [staffOpen, setStaffOpen] = useState(false)
  const [relationsOpen, setRelationsOpen] = useState(false)
  const [reviewsOpen, setReviewsOpen] = useState(false)
  const [reviewOffset, setReviewOffset] = useState(0)
  const [extraReviews, setExtraReviews] = useState<BangumiReview[]>([])
  const query = useQuery({
    queryKey: ['bangumi-metadata', subjectId],
    queryFn: ({ signal }) => bangumiApi.metadata(subjectId, { signal }),
    enabled: subjectId > 0,
    staleTime: 30 * 60_000,
  })
  const reviewPageQuery = useQuery({
    queryKey: ['bangumi-metadata-reviews', subjectId, reviewOffset],
    queryFn: ({ signal }) => bangumiApi.metadata(subjectId, { signal, reviewsLimit: 20, reviewsOffset: reviewOffset }),
    enabled: subjectId > 0 && reviewOffset > 0,
    staleTime: 30 * 60_000,
  })
  useEffect(() => {
    const page = reviewPageQuery.data?.data.reviews
    if (!page || page.length === 0) return
    setExtraReviews((current) => {
      const existing = new Set(current.map((review) => String(review.id)))
      const additions = page.filter((review) => !existing.has(String(review.id)))
      return additions.length > 0 ? [...current, ...additions] : current
    })
  }, [reviewPageQuery.data])
  useEffect(() => {
    setReviewOffset(0)
    setExtraReviews([])
    setSelected(null)
  }, [subjectId])
  const metadata: BangumiSubjectMetadata | undefined = query.data?.data

  if (query.isLoading) {
    return <section className="kz-watch-panel p-3 text-xs text-[var(--kz-fg-muted)] sm:p-4">正在加载角色、制作人员与评价…</section>
  }
  if (query.isError) {
    return <section className="kz-watch-panel p-3 text-xs text-[var(--kz-fg-muted)] sm:p-4">资料暂时加载失败，不影响播放。</section>
  }
  if (!metadata) return null

  const visibleCharacters = charactersOpen ? metadata.characters : metadata.characters.slice(0, 6)
  const visibleStaff = staffOpen ? metadata.staff : metadata.staff.slice(0, 6)
  const visibleRelations = relationsOpen ? metadata.relations : metadata.relations.slice(0, 6)
  const allReviews = [...metadata.reviews, ...extraReviews]
  const visibleReviews = reviewsOpen ? allReviews : allReviews.slice(0, 3)
  const hasContent = metadata.characters.length > 0 || metadata.staff.length > 0 || metadata.relations.length > 0 || metadata.reviews.length > 0

  return (
    <section className="kz-watch-panel overflow-hidden">
      <div className="space-y-5 p-3 sm:p-4">
        {metadata.characters.length > 0 ? (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-[var(--kz-fg)]">角色 <span className="text-xs font-normal text-[var(--kz-fg-muted)]">{metadata.characters.length}</span></h3>
              <span className="text-[10px] text-[var(--kz-fg-dim)]">点击角色查看详情，配音在弹窗内</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-2">
              {visibleCharacters.map((character) => <CharacterCard key={character.id || character.name} character={character} onSelect={(id, actors) => setSelected({ kind: 'character', id, actors })} />)}
            </div>
            <ExpandButton expanded={charactersOpen} onClick={() => setCharactersOpen((value) => !value)} hidden={metadata.characters.length - visibleCharacters.length} />
          </div>
        ) : null}

        {metadata.staff.length > 0 ? (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-[var(--kz-fg)]">制作人员 <span className="text-xs font-normal text-[var(--kz-fg-muted)]">{metadata.staff.length}</span></h3>
              <span className="text-[10px] text-[var(--kz-fg-dim)]">点击人员可查看详情</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-2">
              {visibleStaff.map((person) => <StaffCard key={person.id || person.name} person={person} onSelect={(id) => setSelected({ kind: 'person', id })} />)}
            </div>
            <ExpandButton expanded={staffOpen} onClick={() => setStaffOpen((value) => !value)} hidden={metadata.staff.length - visibleStaff.length} />
          </div>
        ) : null}

        {metadata.relations.length > 0 ? (
          <div>
            <h3 className="text-sm font-semibold text-[var(--kz-fg)]">关联作品 <span className="text-xs font-normal text-[var(--kz-fg-muted)]">{metadata.relations.length}</span></h3>
            <div className="mt-2 flex gap-3 overflow-x-auto pb-1">
              {visibleRelations.map((relation) => (
                <Link key={`${relation.id}-${relation.relation}`} to={`/subject/${relation.id}`} className="group w-24 shrink-0 overflow-hidden rounded-xl border border-[var(--kz-border)]/70 bg-[var(--kz-bg-soft)]/40 hover:border-[var(--kz-accent)]">
                  <Avatar src={relation.image} alt={displayName(relation)} className="h-28 w-full rounded-none border-0 ring-0" />
                  <span className="block truncate px-2 pt-1.5 text-[11px] font-medium text-[var(--kz-fg)] group-hover:text-[var(--kz-accent)]">{displayName(relation)}</span>
                  <span className="block truncate px-2 pb-1.5 text-[10px] text-[var(--kz-fg-muted)]">{relation.relation}</span>
                </Link>
              ))}
            </div>
            <ExpandButton expanded={relationsOpen} onClick={() => setRelationsOpen((value) => !value)} hidden={metadata.relations.length - visibleRelations.length} />
          </div>
        ) : null}

        {metadata.reviews.length > 0 ? (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-[var(--kz-fg)]">评价 <span className="text-xs font-normal text-[var(--kz-fg-muted)]">{metadata.reviewsTotal || metadata.reviews.length}</span></h3>
              <span className="text-[10px] text-[var(--kz-fg-dim)]">已加载 {allReviews.length} 条 · 来自 Bangumi</span>
            </div>
            <div className="mt-2 space-y-2">
              {visibleReviews.map((review) => <ReviewCard key={String(review.id)} review={review} />)}
            </div>
            <ExpandButton expanded={reviewsOpen} onClick={() => setReviewsOpen((value) => !value)} hidden={allReviews.length - visibleReviews.length} />
            {reviewsOpen && allReviews.length < metadata.reviewsTotal ? (
              <button type="button" disabled={reviewPageQuery.isFetching} onClick={() => setReviewOffset(allReviews.length)} className="mt-2 text-xs font-medium text-[var(--kz-accent)] hover:underline disabled:opacity-60">
                {reviewPageQuery.isFetching ? '正在加载…' : `加载更多评价（还剩 ${metadata.reviewsTotal - allReviews.length} 条）`}
              </button>
            ) : null}
          </div>
        ) : metadata.reviewsUnavailable ? (
          <p className="text-[11px] text-[var(--kz-fg-muted)]">Bangumi 评价暂时不可用。</p>
        ) : null}

        {!hasContent ? <p className="text-xs text-[var(--kz-fg-muted)]">Bangumi 暂无额外资料。</p> : null}
      </div>
      {selected ? <EntityDialog selected={selected} onClose={() => setSelected(null)} onSelect={setSelected} /> : null}
    </section>
  )
}
