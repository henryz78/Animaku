import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type {
  BangumiCharacter,
  BangumiPerson,
  BangumiSubjectMetadata,
} from '@animaku/shared'
import { bangumiApi } from '../../lib/bangumi'

function displayName(value: { nameCn?: string; name?: string }): string {
  return value.nameCn?.trim() || value.name?.trim() || '未知'
}

function PersonImage({ person, alt }: { person: BangumiPerson; alt: string }) {
  const src = person.image
  if (!src) return null
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      className="h-10 w-10 shrink-0 rounded-lg object-cover ring-1 ring-[var(--kz-border)]"
    />
  )
}

function CharacterCard({ character }: { character: BangumiCharacter }) {
  return (
    <div className="flex min-w-0 gap-2 rounded-xl border border-[var(--kz-border)]/60 bg-[var(--kz-bg-soft)]/45 p-2">
      {character.image ? (
        <img
          src={character.image}
          alt=""
          loading="lazy"
          className="h-12 w-10 shrink-0 rounded-lg object-cover ring-1 ring-[var(--kz-border)]"
        />
      ) : null}
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-[var(--kz-fg)]">
          {displayName(character)}
        </p>
        {character.nameCn && character.name && character.nameCn !== character.name ? (
          <p className="truncate text-[10px] text-[var(--kz-fg-dim)]">{character.name}</p>
        ) : null}
        {character.actors.length > 0 ? (
          <p className="mt-1 truncate text-[10px] text-[var(--kz-fg-muted)]">
            配音：{character.actors.map(displayName).join('、')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export function BangumiMetadataPanel({ subjectId }: { subjectId: number }) {
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: ['bangumi-metadata', subjectId],
    queryFn: ({ signal }) => bangumiApi.metadata(subjectId, { signal }),
    enabled: open && subjectId > 0,
    staleTime: 30 * 60_000,
  })
  const metadata: BangumiSubjectMetadata | undefined = query.data?.data

  return (
    <section className="kz-watch-panel overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left text-sm font-medium text-[var(--kz-fg)] hover:bg-[var(--kz-bg-hover)] sm:px-4"
        aria-expanded={open}
      >
        <span>角色、制作人员与评价</span>
        <span className="text-xs font-normal text-[var(--kz-fg-muted)]">
          {open ? '收起' : '展开'}
        </span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-[var(--kz-border)]/60 p-3 sm:p-4">
          {query.isLoading ? (
            <p className="text-xs text-[var(--kz-fg-muted)]">正在加载 Bangumi 资料…</p>
          ) : query.isError ? (
            <p className="text-xs text-[var(--kz-fg-muted)]">资料暂时加载失败，不影响播放。</p>
          ) : !metadata ? (
            <p className="text-xs text-[var(--kz-fg-muted)]">暂无额外资料。</p>
          ) : (
            <>
              {metadata.characters.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-xs font-semibold text-[var(--kz-fg)]">角色与配音</h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {metadata.characters.slice(0, 16).map((character) => (
                      <CharacterCard key={character.id || character.name} character={character} />
                    ))}
                  </div>
                </div>
              ) : null}

              {metadata.staff.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-xs font-semibold text-[var(--kz-fg)]">制作人员</h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {metadata.staff.slice(0, 20).map((person) => (
                      <div key={person.id || person.name} className="flex min-w-0 items-center gap-2">
                        <PersonImage person={person} alt="" />
                        <div className="min-w-0">
                          <p className="truncate text-xs text-[var(--kz-fg)]">{displayName(person)}</p>
                          <p className="truncate text-[10px] text-[var(--kz-fg-muted)]">
                            {person.positions.join('、') || '制作人员'}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {metadata.relations.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-xs font-semibold text-[var(--kz-fg)]">关联作品</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {metadata.relations.map((relation) => (
                      <Link
                        key={`${relation.id}-${relation.relation}`}
                        to={`/subject/${relation.id}`}
                        className="rounded-lg border border-[var(--kz-border)] px-2 py-1 text-[11px] text-[var(--kz-fg-muted)] hover:border-[var(--kz-accent)] hover:text-[var(--kz-accent)]"
                      >
                        {relation.relation} · {displayName(relation)}
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}

              {metadata.reviews.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-xs font-semibold text-[var(--kz-fg)]">
                    Bangumi 评价{metadata.reviewsTotal > metadata.reviews.length ? `（${metadata.reviewsTotal}）` : ''}
                  </h3>
                  <div className="space-y-2">
                    {metadata.reviews.slice(0, 5).map((review) => (
                      <article key={String(review.id)} className="rounded-xl bg-[var(--kz-bg-soft)]/50 p-2.5">
                        <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--kz-fg-muted)]">
                          <span>{review.user.nickname || review.user.username || '匿名用户'}</span>
                          {review.score ? <span>评分 {review.score}</span> : null}
                        </div>
                        <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-[var(--kz-fg)]">
                          {review.content}
                        </p>
                      </article>
                    ))}
                  </div>
                </div>
              ) : metadata.reviewsUnavailable ? (
                <p className="text-[11px] text-[var(--kz-fg-muted)]">Bangumi 评价暂时不可用。</p>
              ) : null}

              {metadata.characters.length === 0 && metadata.staff.length === 0 && metadata.relations.length === 0 && metadata.reviews.length === 0 ? (
                <p className="text-xs text-[var(--kz-fg-muted)]">Bangumi 暂无额外资料。</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

