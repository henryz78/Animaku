import { ALLOWED_HOSTS } from '../lib/allowlist.js'

export default function handler(_req, res) {
  res.status(200).json({
    ok: true,
    service: 'animaku-egress-proxy',
    allowedHosts: ALLOWED_HOSTS,
    mode: 'small-response-only',
  })
}
