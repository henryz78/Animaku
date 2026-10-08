export type HlsAsset = { name: string; url: string; kind: 'segment' | 'key' | 'map'; range?: { start: number; length: number } }
export type HlsPlan = { playlist: string; assets: HlsAsset[]; encrypted: boolean; fragmented: boolean }
export function variantUrl(text: string, base: string): string | undefined {
  const lines = text.trim().split(/\r?\n/)
  // An external audio/video rendition must be downloaded separately. Refuse it
  // rather than silently creating an offline file without sound.
  if (lines.some((line) => line.startsWith('#EXT-X-MEDIA:') && /(?:^|,)TYPE=(?:AUDIO|VIDEO)(?:,|$)/.test(line.slice('#EXT-X-MEDIA:'.length)) && /(?:^|,)URI=/.test(line.slice('#EXT-X-MEDIA:'.length)))) {
    throw new Error('此片源的音画分轨暂不支持离线保存，请换源')
  }
  const variants: Array<{ bandwidth: number; url: string }> = []
  lines.forEach((line, i) => {
    if (line.startsWith('#EXT-X-STREAM-INF:') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
      variants.push({ bandwidth: Number(line.match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1] || 0), url: new URL(lines[i + 1].trim(), base).href })
    }
  })
  // Retain the first declared rendition, consistent with the source's default.
  return variants[0]?.url
}
export function planHls(text: string, base: string): HlsPlan {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('片源没有返回有效播放列表')
  if (!text.includes('#EXT-X-ENDLIST')) throw new Error('直播或尚未结束的播放列表暂不支持缓存')
  if (/#EXT-X-(?:SESSION-KEY|PART|PRELOAD-HINT)/.test(text)) throw new Error('此播放列表格式暂不支持缓存')
  const assets: HlsAsset[] = []
  const uriFiles = new Map<string, string>()
  let encrypted = false
  let fragmented = false
  let range: { length: number; start?: number } | undefined
  let lastRangeUrl = ''
  let rangeEnd = 0
  function file(url: string, kind: HlsAsset['kind'], byteRange?: HlsAsset['range']): string {
    const absolute = new URL(url, base).href
    if (!/^https?:/.test(absolute)) throw new Error('播放列表包含不支持的媒体地址')
    const identity = `${kind}:${absolute}:${byteRange?.start ?? ''}:${byteRange?.length ?? ''}`
    const existing = uriFiles.get(identity)
    if (existing) return existing
    const suffix = kind === 'key' ? 'key' : kind === 'map' || /\.m4s(?:\?|$)/i.test(absolute) ? 'mp4' : 'ts'
    const name = `part-${assets.length}.${suffix}`
    assets.push({ name, url: absolute, kind, range: byteRange })
    uriFiles.set(identity, name)
    return name
  }
  const lines = text.trim().split(/\r?\n/).flatMap((raw) => {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const match = line.match(/^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?$/)
      if (!match) throw new Error('无效的分片字节范围')
      range = { length: Number(match[1]), start: match[2] ? Number(match[2]) : undefined }
      return []
    }
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-MAP:')) {
      const key = line.startsWith('#EXT-X-KEY:')
      if (key && /METHOD=NONE(?:,|$)/.test(line)) return [line]
      if (key && (!/METHOD=AES-128(?:,|$)/.test(line) || /KEYFORMAT=/.test(line))) throw new Error('DRM 或此类加密片源不支持缓存')
      const uri = line.match(/URI="([^"]+)"/)
      if (!uri) throw new Error('分片缺少初始化文件或密钥地址')
      let mapRange: HlsAsset['range']
      const bytes = line.match(/BYTERANGE="(\d+)@(\d+)"/)
      if (line.includes('BYTERANGE=') && !bytes) throw new Error('不支持此初始化文件的字节范围')
      if (bytes) mapRange = { length: Number(bytes[1]), start: Number(bytes[2]) }
      const name = file(uri[1], key ? 'key' : 'map', mapRange)
      encrypted ||= key
      fragmented ||= !key
      return [line.replace(uri[0], `URI="${name}"`).replace(/,?BYTERANGE="[^"]+"/, '')]
    }
    if (!line || line.startsWith('#')) return [line]
    const absolute = new URL(line, base).href
    let byteRange: HlsAsset['range']
    if (range) {
      if (range.start === undefined && lastRangeUrl !== absolute) throw new Error('分片字节范围缺少起点')
      byteRange = { start: range.start ?? rangeEnd, length: range.length }
      rangeEnd = byteRange.start + byteRange.length
      lastRangeUrl = absolute
      range = undefined
    }
    return [file(line, 'segment', byteRange)]
  })
  if (!assets.some((asset) => asset.kind === 'segment')) throw new Error('播放列表没有可缓存的剧集内容')
  return { playlist: lines.join('\n') + '\n', assets, encrypted, fragmented }
}
export function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
  if (!match) return null
  const [start, end, total] = match.slice(1).map(Number)
  return start <= end && end < total && Number.isSafeInteger(total) ? { start, end, total } : null
}
