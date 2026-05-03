# What changed in v1.1.0

## Root cause
`media.deezer.com/v1/get_url` was being called without session cookies (`arl` + `sid`) and without a `Referer` header. Deezer silently returned an error, `streamUrl` stayed `null`, and the code fell through to the legacy CDN builder which no longer works — resulting in 30-second previews playing instead of full tracks.

## Fix applied to `index.js`
1. `getPremiumStreamInfo` — added `Cookie: arl=...; sid=...`, `Referer`, `Accept`, and `Accept-Language` headers to the `media.deezer.com` POST
2. Added `MP3_64` as a third format fallback in the `formats` array
3. `/debug/:id` route — added `step4_mediaResponse` field so you can see the raw response from `media.deezer.com` and diagnose future issues
4. Version bumped to `1.1.0`

## Env vars
| Var | Required? | What it does |
|---|---|---|
| `DEEZER_ARL` | **Yes** (for full tracks) | Your 192-char ARL cookie from deezer.com. Without this, all users get 30s previews. |
| `REDIS_URL` | Optional | Upstash Redis REST URL for token persistence across CF isolates |
| `REDIS_TOKEN` | Optional | Upstash Redis Bearer token (paired with `REDIS_URL`) |

Set `DEEZER_ARL` in Cloudflare Dashboard → Workers & Pages → your worker → Settings → Variables → Add variable (mark as **Secret**).
