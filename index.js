// ─── Deezer Eclipse Addon — Cloudflare Worker ────────────────────────────────
// Free mode:    previews + full search — click Generate, no login needed
// Premium mode: full 320kbps streams — input your Deezer ARL on the config page
// ─────────────────────────────────────────────────────────────────────────────

const DEEZER_API = 'https://api.deezer.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname.replace(/^\//, '');
    const segs = path.split('/');
    const base = url.origin;

    try {
      // ── Config / landing page ────────────────────────────────────────────
      if (path === '' || path === '/') return html(buildConfigPage(base));

      // ── Token generation ─────────────────────────────────────────────────
      if (path === 'generate' && request.method === 'POST') return handleGenerate(request, env, base);

      // ── Token-scoped routes (/u/:token/...) ──────────────────────────────
      if (segs[0] === 'u' && segs[1] && segs[2]) {
        const token = segs[1];
        const entry = await getTokenEntry(env, token);
        if (!entry) return json({ error: 'Invalid token.' }, 404);

        const sub = segs.slice(2).join('/');

        if (sub === 'manifest.json')          return handleManifest(token, entry, base, env);
        if (sub === 'search')                 return handleSearch(url);
        if (segs[2] === 'stream' && segs[3])  return handleStream(segs[3], entry, env, token, base);
        if (segs[2] === 'album'  && segs[3])  return handleAlbum(segs[3]);
        if (segs[2] === 'artist' && segs[3])  return handleArtist(segs[3]);
        if (segs[2] === 'playlist' && segs[3]) return handlePlaylist(segs[3]);
        if (segs[2] === 'proxy'    && segs[3]) return handleProxy(segs[3], entry, env);
      }

      if (path === 'health') return json({
        status: 'ok',
        version: '1.1.0',
        arlConfigured: !!((env.DEEZER_ARL || env.DEEZERARL)),
        redisConfigured: !!((env.REDIS_URL  || env.REDISURL) && (env.REDIS_TOKEN || env.REDISTOKEN)),
        timestamp: new Date().toISOString(),
      });

      // Debug route — shows full pipeline including media.deezer.com response
      // Usage: /debug/TRACK_ID  (only works if DEEZER_ARL env is set)
      if (segs[0] === 'debug' && segs[1] && (env.DEEZER_ARL || env.DEEZERARL)) {
        const trackId = segs[1];
        const arl = (env.DEEZER_ARL || env.DEEZERARL);
        const sid = await dzPing(arl);
        const userData = await dzGw('deezer.getUserData', {}, arl, sid, 'null');
        const apiToken = userData?.results?.checkForm || 'null';
        const licenseToken = userData?.results?.USER?.OPTIONS?.license_token || null;
        const userId = userData?.results?.USER?.USER_ID || 0;
        const listData = await dzGw('song.getListData', { sng_ids: [String(trackId)] }, arl, sid, apiToken);
        const song = listData?.results?.data?.[0];

        // Step 4: test media.deezer.com directly with full browser headers
        let mediaResponse = null;
        if (song?.TRACK_TOKEN && licenseToken) {
          try {
            const mRes = await fetch('https://media.deezer.com/v1/get_url', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
                'Cookie': `arl=${arl}; sid=${sid || ''}`,
                'Origin': 'https://www.deezer.com',
                'Referer': 'https://www.deezer.com/',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
              },
              body: JSON.stringify({
                license_token: licenseToken,
                media: [{ type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format: 'MP3_320' }] }],
                track_tokens: [song.TRACK_TOKEN],
              }),
            });
            mediaResponse = await mRes.json();
          } catch(e) {
            mediaResponse = { _error: e.message };
          }
        }

        return json({
          step1_sid: sid ? sid.slice(0, 8) + '...' : null,
          step2_userId: userId,
          step2_arlValid: userId !== 0,
          step2_apiToken: apiToken ? apiToken.slice(0, 8) + '...' : null,
          step2_licenseToken: licenseToken ? licenseToken.slice(0, 8) + '...' : null,
          step3_hasMD5: !!(song?.MD5_ORIGIN),
          step3_hasTrackToken: !!(song?.TRACK_TOKEN),
          step3_trackTokenExpiry: song?.TRACK_TOKEN_EXPIRE || null,
          step3_error: listData?.error || null,
          step4_mediaResponse: mediaResponse,
        });
      }

      return json({ error: 'Not found.' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

// ─── In-memory token store (survives within same isolate) ────────────────────
const TOKEN_CACHE = new Map();
// Short-lived cache: stores resolved {url, blowfishKey, quality} keyed by trackId
// so /proxy doesn't need to re-call Deezer (TRACK_TOKEN expires in ~30s)
const STREAM_CACHE = new Map();
function streamCacheSet(trackId, val) {
  STREAM_CACHE.set(trackId, { val, exp: Date.now() + 25000 }); // 25s TTL
}
function streamCacheGet(trackId) {
  const e = STREAM_CACHE.get(trackId);
  if (!e) return null;
  if (Date.now() > e.exp) { STREAM_CACHE.delete(trackId); return null; }
  return e.val;
}

// ─── Upstash Redis (HTTP — works in CF Workers) ───────────────────────────────
// Set REDIS_URL + REDIS_TOKEN env vars to enable token persistence across isolates.
// REDIS_URL = your Upstash REST URL (https://xxx.upstash.io)
async function redisGet(env, key) {
  if (!(env.REDIS_URL  || env.REDISURL) || !(env.REDIS_TOKEN || env.REDISTOKEN)) return null;
  try {
    const r = await fetch(`${(env.REDIS_URL  || env.REDISURL)}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${(env.REDIS_TOKEN || env.REDISTOKEN)}` }
    });
    const j = await r.json();
    return j.result ?? null;
  } catch { return null; }
}

async function redisSet(env, key, value, ttlSec) {
  if (!(env.REDIS_URL  || env.REDISURL) || !(env.REDIS_TOKEN || env.REDISTOKEN)) return;
  try {
    const path = ttlSec
      ? `/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/ex/${ttlSec}`
      : `/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
    await fetch(`${(env.REDIS_URL  || env.REDISURL)}${path}`, {
      headers: { Authorization: `Bearer ${(env.REDIS_TOKEN || env.REDISTOKEN)}` }
    });
  } catch {}
}

function generateToken() {
  const arr = new Uint8Array(14);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getTokenEntry(env, token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  // Try Redis persistence
  const saved = await redisGet(env, 'dz:token:' + token);
  if (saved) {
    try {
      const entry = JSON.parse(saved);
      TOKEN_CACHE.set(token, entry);
      return entry;
    } catch {}
  }
  // Try KV fallback
  if ((env.DEEZER_KV  || env.DEEZERKV)) {
    const kv = await (env.DEEZER_KV  || env.DEEZERKV).get('token:' + token);
    if (kv) {
      try {
        const entry = JSON.parse(kv);
        TOKEN_CACHE.set(token, entry);
        return entry;
      } catch {}
    }
  }
  // Workers are stateless — trust any well-formed token as a fresh entry
  if (/^[a-f0-9]{28}$/.test(token)) {
    const fresh = { arl: null, createdAt: Date.now() };
    TOKEN_CACHE.set(token, fresh);
    return fresh;
  }
  return null;
}

async function saveToken(env, token, entry) {
  TOKEN_CACHE.set(token, entry);
  // Persist to Redis (90 day TTL)
  await redisSet(env, 'dz:token:' + token, JSON.stringify(entry), 86400 * 90);
  // Also persist to KV if configured
  if ((env.DEEZER_KV  || env.DEEZERKV)) {
    await (env.DEEZER_KV  || env.DEEZERKV).put('token:' + token, JSON.stringify(entry), { expirationTtl: 86400 * 90 });
  }
}

// ─── Generate endpoint ───────────────────────────────────────────────────────
async function handleGenerate(request, env, base) {
  const body = await request.json().catch(() => ({}));
  const arl  = body.arl ? String(body.arl).trim() : null;

  if (arl && !/^[a-f0-9]{150,220}$/.test(arl)) {
    return json({ error: 'Invalid ARL — should be a 192-character hex string from your Deezer cookie.' }, 400);
  }

  const token = generateToken();
  // Store only user-supplied ARL in token — env ARL is always the fallback at stream time
  const entry = { arl: arl || null, createdAt: Date.now() };
  await saveToken(env, token, entry);

  // Premium badge = user has own ARL OR server env ARL is set
  const isPremium = !!(arl || (env.DEEZER_ARL || env.DEEZERARL));
  const manifestUrl = `${base}/u/${token}/manifest.json`;
  return json({ token, manifestUrl, premium: isPremium });
}

// ─── Manifest ────────────────────────────────────────────────────────────────
function handleManifest(token, entry, base, env) {
  const hasPremium = !!(entry.arl || (env.DEEZER_ARL || env.DEEZERARL));
  return json({
    id:          `com.eclipse.deezer.${token.slice(0, 8)}`,
    name:        hasPremium ? 'Deezer (Premium)' : 'Deezer (Previews)',
    version:     '1.1.0',
    description: hasPremium
      ? 'Full Deezer streaming.'
      : 'Deezer search + 30-second previews. Visit the addon page to upgrade to full tracks.',
    icon:        'https://e-cdns-files.dzcdn.net/cache/hack/images/common/favicon/favicon-96x96.png',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist'],
    contentType: 'music',
  });
}

// ─── Search ──────────────────────────────────────────────────────────────────
async function handleSearch(url) {
  const q = url.searchParams.get('q') || '';
  if (!q) return json({ tracks: [], albums: [], artists: [], playlists: [] });

  const [tracksRes, albumsRes, artistsRes, playlistsRes] = await Promise.all([
    deezerGet('/search/track',    { q, limit: 20 }),
    deezerGet('/search/album',    { q, limit: 10 }),
    deezerGet('/search/artist',   { q, limit: 5  }),
    deezerGet('/search/playlist', { q, limit: 5  }),
  ]);

  return json({
    tracks: (tracksRes.data || []).map(t => ({
      id:         String(t.id),
      title:      t.title,
      artist:     t.artist?.name || '',
      album:      t.album?.title || '',
      duration:   t.duration,
      artworkURL: t.album?.cover_xl || t.album?.cover_big || '',
      isrc:       t.isrc || '',
      format:     'mp3',
      streamURL:  t.preview || '',  // embed preview so Eclipse can play without extra /stream call
    })),
    albums: (albumsRes.data || []).map(a => ({
      id:         String(a.id),
      title:      a.title,
      artist:     a.artist?.name || '',
      artworkURL: a.cover_xl || a.cover_big || '',
      trackCount: a.nb_tracks || 0,
      year:       a.release_date ? String(a.release_date).slice(0, 4) : '',
    })),
    artists: (artistsRes.data || []).map(a => ({
      id:         String(a.id),
      name:       a.name,
      artworkURL: a.picture_xl || a.picture_big || '',
    })),
    playlists: (playlistsRes.data || []).map(p => ({
      id:         String(p.id),
      title:      p.title,
      creator:    p.user?.name || '',
      artworkURL: p.picture_xl || p.picture_big || '',
      trackCount: p.nb_tracks || 0,
    })),
  });
}

// ─── Stream ──────────────────────────────────────────────────────────────────
// Deezer BF_CBC_STRIPE streams are Blowfish-encrypted — every 3rd 2048-byte
// chunk must be decrypted before playback. We fetch + decrypt + proxy inline.
async function handleStream(trackId, entry, env, token, base) {
  const arl = entry.arl || (env.DEEZER_ARL || env.DEEZERARL) || null;
  if (arl) {
    const result = await getPremiumStreamInfo(trackId, arl);
    if (result?.url && result?.blowfishKey) {
      // Cache so /proxy can reuse immediately without re-calling Deezer
      streamCacheSet(trackId, result);
      const proxyUrl = `${base}/u/${token}/proxy/${trackId}`;
      return json({ url: proxyUrl, format: 'mp3', quality: result.quality });
    }
  }
  // Free: 30-second official preview
  const track = await deezerGet(`/track/${trackId}`);
  if (track?.preview) return json({ url: track.preview, format: 'mp3', quality: 'preview_30s' });
  return json({ error: 'No stream available' }, 404);
}

// ─── Proxy route: fetches encrypted stream, decrypts, streams back ────────────
// Eclipse hits /u/:token/proxy/:trackId — worker fetches from Deezer, decrypts, returns audio
async function handleProxy(trackId, entry, env) {
  const arl = entry.arl || (env.DEEZER_ARL || env.DEEZERARL) || null;
  if (!arl) return new Response('No ARL configured', { status: 403 });

  // Use cached result from handleStream to avoid re-calling Deezer (token expires in ~30s)
  let result = streamCacheGet(trackId);
  if (!result) {
    // Cache miss — fetch fresh (e.g. direct proxy URL access or cache expired)
    result = await getPremiumStreamInfo(trackId, arl);
  }
  if (!result?.url) return new Response('Could not get stream URL', { status: 502 });

  // Fetch the encrypted stream from Deezer CDN
  const encRes = await fetch(result.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://www.deezer.com',
      'Referer': 'https://www.deezer.com/',
      'Range': 'bytes=0-',
    }
  });

  if (!encRes.ok) return new Response('CDN fetch failed: ' + encRes.status, { status: 502 });

  // Read full encrypted buffer
  const encBuffer = await encRes.arrayBuffer();
  const encBytes   = new Uint8Array(encBuffer);

  // Decrypt: every 3rd 2048-byte chunk with Blowfish CBC, rest pass-through
  const decBytes = await decryptBlowfishStream(encBytes, result.blowfishKey);

  return new Response(decBytes, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(decBytes.byteLength),
      'Accept-Ranges': 'bytes',
      ...CORS,
    }
  });
}

// ─── Album ───────────────────────────────────────────────────────────────────
async function handleAlbum(albumId) {
  const data = await deezerGet(`/album/${albumId}`);
  return json({
    id:         String(data.id),
    title:      data.title,
    artist:     data.artist?.name || '',
    artworkURL: data.cover_xl || data.cover_big || '',
    year:       data.release_date ? String(data.release_date).slice(0, 4) : '',
    trackCount: data.nb_tracks,
    tracks: (data.tracks?.data || []).map(t => ({
      id:         String(t.id),
      title:      t.title,
      artist:     t.artist?.name || data.artist?.name || '',
      album:      data.title,
      duration:   t.duration,
      artworkURL: data.cover_xl || data.cover_big || '',
      isrc:       t.isrc || '',
      format:     'mp3',
    })),
  });
}

// ─── Artist ──────────────────────────────────────────────────────────────────
async function handleArtist(artistId) {
  const [artist, topRes, albumsRes] = await Promise.all([
    deezerGet(`/artist/${artistId}`),
    deezerGet(`/artist/${artistId}/top`, { limit: 10 }),
    deezerGet(`/artist/${artistId}/albums`, { limit: 20 }),
  ]);
  return json({
    id:         String(artist.id),
    name:       artist.name,
    artworkURL: artist.picture_xl || artist.picture_big || '',
    topTracks: (topRes.data || []).map(t => ({
      id: String(t.id), title: t.title, artist: artist.name,
      duration: t.duration, artworkURL: t.album?.cover_xl || '', isrc: t.isrc || '', format: 'mp3',
    })),
    albums: (albumsRes.data || []).map(a => ({
      id: String(a.id), title: a.title, artist: artist.name,
      artworkURL: a.cover_xl || a.cover_big || '',
      trackCount: a.nb_tracks || 0,
      year: a.release_date ? String(a.release_date).slice(0, 4) : '',
    })),
  });
}

// ─── Playlist ────────────────────────────────────────────────────────────────
async function handlePlaylist(playlistId) {
  const data = await deezerGet(`/playlist/${playlistId}`);
  return json({
    id:          String(data.id),
    title:       data.title,
    description: data.description || '',
    artworkURL:  data.picture_xl || data.picture_big || '',
    creator:     data.creator?.name || '',
    tracks: (data.tracks?.data || []).map(t => ({
      id: String(t.id), title: t.title, artist: t.artist?.name || '',
      album: t.album?.title || '', duration: t.duration,
      artworkURL: t.album?.cover_xl || '', isrc: t.isrc || '', format: 'mp3',
    })),
  });
}

// ─── Internal Deezer gateway ─────────────────────────────────────────────────
// Confirmed working flow from https://github.com/yne/dzr/issues/5
// Requires: arl cookie + sid cookie (obtained via deezer.ping first)
async function dzPing(arl) {
  // Get a fresh sid session cookie using the arl
  const res = await fetch(
    'https://www.deezer.com/ajax/gw-light.php?method=deezer.ping&input=3&api_version=1.0&api_token=null',
    {
      method: 'POST',
      headers: {
        'Cookie': `arl=${arl}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.deezer.com',
        'Referer': 'https://www.deezer.com/',
      },
      body: '{}',
    }
  );
  const data = await res.json();
  return data?.results?.SESSION || null;
}

async function dzGw(method, params, arl, sid, apiToken) {
  const res = await fetch(
    `https://www.deezer.com/ajax/gw-light.php?method=${method}&input=3&api_version=1.0&api_token=${encodeURIComponent(apiToken || 'null')}`,
    {
      method: 'POST',
      headers: {
        'Cookie': `arl=${arl}; sid=${sid || ''}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.deezer.com',
        'Referer': 'https://www.deezer.com/',
      },
      body: JSON.stringify(params),
    }
  );
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 500) }; }
}

// ─── Premium stream info ─────────────────────────────────────────────────────
// Returns { url, blowfishKey, quality } — url is Blowfish-encrypted, must proxy+decrypt
async function getPremiumStreamInfo(trackId, arl) {
  try {
    const sid          = await dzPing(arl);
    const userRaw      = await dzGw('deezer.getUserData', {}, arl, sid, 'null');
    const apiToken     = userRaw?.results?.checkForm || 'null';
    const licenseToken = userRaw?.results?.USER?.OPTIONS?.license_token || null;
    const userId       = userRaw?.results?.USER?.USER_ID || 0;

    if (!userId || userId === 0) return null;

    const listRaw  = await dzGw('song.getListData', { sng_ids: [String(trackId)] }, arl, sid, apiToken);
    let song       = listRaw?.results?.data?.[0];

    if (!song?.TRACK_TOKEN) {
      const singleRaw = await dzGw('song.getData', { SNG_ID: String(trackId) }, arl, sid, apiToken);
      song = singleRaw?.results;
    }

    if (!song?.MD5_ORIGIN) return null;

    const { MD5_ORIGIN, MEDIA_VERSION, SNG_ID, TRACK_TOKEN } = song;

    // Blowfish key for this track (used to decrypt the stream)
    const blowfishKey = getBlowfishKey(String(SNG_ID || trackId));

    let streamUrl  = null;
    let quality    = '320kbps';

    // Try media.deezer.com first — with full browser headers including session cookies
    if (TRACK_TOKEN && licenseToken) {
      try {
        const mediaRes = await fetch('https://media.deezer.com/v1/get_url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            'Cookie': `arl=${arl}; sid=${sid || ''}`,
            'Origin': 'https://www.deezer.com',
            'Referer': 'https://www.deezer.com/',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          body: JSON.stringify({
            license_token: licenseToken,
            media: [
              { type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format: 'MP3_320' }] },
              { type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format: 'MP3_128' }] },
              { type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format: 'MP3_64'  }] },
            ],
            track_tokens: [TRACK_TOKEN],
          }),
        });
        const mediaData = await mediaRes.json();
        // Scan all returned media entries for a valid URL
        const mediaItems = mediaData?.data?.[0]?.media || [];
        for (const item of mediaItems) {
          const s = item?.sources?.[0]?.url;
          if (s) {
            streamUrl = s;
            const fmt = item.format || 'MP3_320';
            quality = fmt.includes('320') ? '320kbps' : fmt.includes('128') ? '128kbps' : '64kbps';
            break;
          }
        }
        console.log(`[premium] media.deezer.com srcFound=${!!streamUrl} errors=${JSON.stringify(mediaData?.errors||null)}`);
      } catch(e) {
        console.error('[stream] media.deezer.com error:', e.message);
      }
    }

    // Fallback: CDN reconstruction
    if (!streamUrl) {
      streamUrl = await buildCDNUrl(MD5_ORIGIN, MEDIA_VERSION, String(SNG_ID || trackId), 3);
    }

    return { url: streamUrl, blowfishKey, quality };

  } catch (e) {
    console.error('[stream] Fatal:', e.message);
    return null;
  }
}

// ─── Blowfish key derivation (per-track) ─────────────────────────────────────
function getBlowfishKey(trackId) {
  const SECRET = 'g4el58wc0zvf9na1';
  // MD5 of trackId as hex string
  const h = md5Sync(trackId);
  let key = '';
  for (let i = 0; i < 16; i++) {
    key += String.fromCharCode(
      h.charCodeAt(i) ^ h.charCodeAt(i + 16) ^ SECRET.charCodeAt(i)
    );
  }
  return key;
}

// Sync MD5 needed for Blowfish key (pure JS, same algo as the async one)
function md5Sync(str) {
  function safeAdd(x,y){const l=(x&0xffff)+(y&0xffff);const m=(x>>16)+(y>>16)+(l>>16);return(m<<16)|(l&0xffff);}
  function rol(n,c){return(n<<c)|(n>>>(32-c));}
  function cmn(q,a,b,x,s,t){return safeAdd(rol(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b);}
  function ff(a,b,c,d,x,s,t){return cmn((b&c)|(~b&d),a,b,x,s,t);}
  function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&~d),a,b,x,s,t);}
  function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
  function ii(a,b,c,d,x,s,t){return cmn(c^(b|~d),a,b,x,s,t);}
  const bytes=new TextEncoder().encode(str);
  const len8=bytes.length;
  const len32=Math.ceil((len8+9)/64)*16;
  const M=new Int32Array(len32);
  for(let i=0;i<len8;i++)M[i>>2]|=bytes[i]<<((i%4)*8);
  M[len8>>2]|=0x80<<((len8%4)*8);
  M[len32-2]=len8*8;
  let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
  for(let i=0;i<len32;i+=16){
    const[A,B,C,D]=[a,b,c,d];
    a=ff(a,b,c,d,M[i+0],7,-680876936);d=ff(d,a,b,c,M[i+1],12,-389564586);c=ff(c,d,a,b,M[i+2],17,606105819);b=ff(b,c,d,a,M[i+3],22,-1044525330);
    a=ff(a,b,c,d,M[i+4],7,-176418897);d=ff(d,a,b,c,M[i+5],12,1200080426);c=ff(c,d,a,b,M[i+6],17,-1473231341);b=ff(b,c,d,a,M[i+7],22,-45705983);
    a=ff(a,b,c,d,M[i+8],7,1770035416);d=ff(d,a,b,c,M[i+9],12,-1958414417);c=ff(c,d,a,b,M[i+10],17,-42063);b=ff(b,c,d,a,M[i+11],22,-1990404162);
    a=ff(a,b,c,d,M[i+12],7,1804603682);d=ff(d,a,b,c,M[i+13],12,-40341101);c=ff(c,d,a,b,M[i+14],17,-1502002290);b=ff(b,c,d,a,M[i+15],22,1236535329);
    a=gg(a,b,c,d,M[i+1],5,-165796510);d=gg(d,a,b,c,M[i+6],9,-1069501632);c=gg(c,d,a,b,M[i+11],14,643717713);b=gg(b,c,d,a,M[i+0],20,-373897302);
    a=gg(a,b,c,d,M[i+5],5,-701558691);d=gg(d,a,b,c,M[i+10],9,38016083);c=gg(c,d,a,b,M[i+15],14,-660478335);b=gg(b,c,d,a,M[i+4],20,-405537848);
    a=gg(a,b,c,d,M[i+9],5,568446438);d=gg(d,a,b,c,M[i+14],9,-1019803690);c=gg(c,d,a,b,M[i+3],14,-187363961);b=gg(b,c,d,a,M[i+8],20,1163531501);
    a=gg(a,b,c,d,M[i+13],5,-1444681467);d=gg(d,a,b,c,M[i+2],9,-51403784);c=gg(c,d,a,b,M[i+7],14,1735328473);b=gg(b,c,d,a,M[i+12],20,-1926607734);
    a=hh(a,b,c,d,M[i+5],4,-378558);d=hh(d,a,b,c,M[i+8],11,-2022574463);c=hh(c,d,a,b,M[i+11],16,1839030562);b=hh(b,c,d,a,M[i+14],23,-35309556);
    a=hh(a,b,c,d,M[i+1],4,-1530992060);d=hh(d,a,b,c,M[i+4],11,1272893353);c=hh(c,d,a,b,M[i+7],16,-155497632);b=hh(b,c,d,a,M[i+10],23,-1094730640);
    a=hh(a,b,c,d,M[i+13],4,681279174);d=hh(d,a,b,c,M[i+0],11,-358537222);c=hh(c,d,a,b,M[i+3],16,-722521979);b=hh(b,c,d,a,M[i+6],23,76029189);
    a=hh(a,b,c,d,M[i+9],4,-640364487);d=hh(d,a,b,c,M[i+12],11,-421815835);c=hh(c,d,a,b,M[i+15],16,530742520);b=hh(b,c,d,a,M[i+2],23,-995338651);
    a=ii(a,b,c,d,M[i+0],6,-198630844);d=ii(d,a,b,c,M[i+7],10,1126891415);c=ii(c,d,a,b,M[i+14],15,-1416354905);b=ii(b,c,d,a,M[i+5],21,-57434055);
    a=ii(a,b,c,d,M[i+12],6,1700485571);d=ii(d,a,b,c,M[i+3],10,-1894986606);c=ii(c,d,a,b,M[i+10],15,-1051523);b=ii(b,c,d,a,M[i+1],21,-2054922799);
    a=ii(a,b,c,d,M[i+8],6,1873313359);d=ii(d,a,b,c,M[i+15],10,-30611744);c=ii(c,d,a,b,M[i+6],15,-1560198380);b=ii(b,c,d,a,M[i+13],21,1309151649);
    a=ii(a,b,c,d,M[i+4],6,-145523070);d=ii(d,a,b,c,M[i+11],10,-1120210379);c=ii(c,d,a,b,M[i+2],15,718787259);b=ii(b,c,d,a,M[i+9],21,-343485551);
    a=safeAdd(a,A);b=safeAdd(b,B);c=safeAdd(c,C);d=safeAdd(d,D);
  }
  return [a,b,c,d].map(n=>{let h='';for(let i=0;i<4;i++)h+=('0'+((n>>(i*8))&0xff).toString(16)).slice(-2);return h;}).join('');
}

// ─── Blowfish CBC decryption (pure JS, no dependencies) ──────────────────────
// Deezer streams: every 3rd 2048-byte chunk is BF-CBC encrypted, others are plain
async function decryptBlowfishStream(encBytes, keyStr) {
  const CHUNK = 2048;
  const keyBytes = new TextEncoder().encode(keyStr);
  const out = new Uint8Array(encBytes.length);
  const bf  = new Blowfish(keyBytes);

  for (let pos = 0, i = 0; pos < encBytes.length; pos += CHUNK, i++) {
    const end   = Math.min(pos + CHUNK, encBytes.length);
    const chunk = encBytes.slice(pos, end);
    if (i % 3 === 0 && chunk.length === CHUNK) {
      // Decrypt this chunk: BF-CBC with IV = [0,1,2,3,4,5,6,7]
      const dec = bf.decryptCBC(chunk, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
      out.set(dec, pos);
    } else {
      out.set(chunk, pos);
    }
  }
  return out;
}

// ─── Blowfish standard constants (digits of π) ─────────────────────────────
const BF_P = [
  0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0, 0x082efa98, 0xec4e6c89,
  0x452821e6, 0x38d01377, 0xbe5466cf, 0x34e90c6c, 0xc0ac29b7, 0xc97c50dd, 0x3f84d5b5, 0xb5470917,
  0x9216d5d9, 0x8979fb1b
];
const BF_S0 = [
  0xd1310ba6, 0x98dfb5ac, 0x2ffd72db, 0xd01adfb7, 0xb8e1afed, 0x6a267e96, 0xba7c9045, 0xf12c7f99,
  0x24a19947, 0xb3916cf7, 0x0801f2e2, 0x858efc16, 0x636920d8, 0x71574e69, 0xa458fea3, 0xf4933d7e,
  0x0d95748f, 0x728eb658, 0x718bcd58, 0x82154aee, 0x7b54a41d, 0xc25a59b5, 0x9c30d539, 0x2af26013,
  0xc5d1b023, 0x286085f0, 0xca417918, 0xb8db38ef, 0x8e79dcb0, 0x603a180e, 0x6c9e0e8b, 0xb01e8a3e,
  0xd71577c1, 0xbd314b27, 0x78af2fda, 0x55605c60, 0xe65525f3, 0xaa55ab94, 0x57489862, 0x63e81440,
  0x55ca396a, 0x2aab10b6, 0xb4cc5c34, 0x1141e8ce, 0xa15486af, 0x7c72e993, 0xb3ee1411, 0x636fbc2a,
  0x2ba9c55d, 0x741831f6, 0xce5c3e16, 0x9b87931e, 0xafd6ba33, 0x6c24cf5c, 0x7a325381, 0x28958677,
  0x3b8f4898, 0x6b4bb9af, 0xc4bfe81b, 0x66282193, 0x61d809cc, 0xfb21a991, 0x487cac60, 0x5dec8032,
  0xef845d5d, 0xe98575b1, 0xdc262302, 0xeb651b88, 0x23893e81, 0xd396acc5, 0x0f6d6ff3, 0x83f44239,
  0x2e0b4482, 0xa4842004, 0x69c8f04a, 0x9e1f9b5e, 0x21c66842, 0xf6e96c9a, 0x670c9c61, 0xabd388f0,
  0x6a51a0d2, 0xd8542f68, 0x960fa728, 0xab5133a3, 0x6eef0b6c, 0x137a3be4, 0xba3bf050, 0x7efb2a98,
  0xa1f1651d, 0x39af0176, 0x66ca593e, 0x82430e88, 0x8cee8619, 0x456f9fb4, 0x7d84a5c3, 0x3b8b5ebe,
  0xe06f75d8, 0x85c12073, 0x401a449f, 0x56c16aa6, 0x4ed3aa62, 0x363f7706, 0x1bfedf72, 0x429b023d,
  0x37d0d724, 0xd00a1248, 0xdb0fead3, 0x49f1c09b, 0x075372c9, 0x80991b7b, 0x25d479d8, 0xf6e8def7,
  0xe3fe501a, 0xb6794c3b, 0x976ce0bd, 0x04c006ba, 0xc1a94fb6, 0x409f60c4, 0x5e5c9ec2, 0x196a2463,
  0x68fb6faf, 0x3e6c53b5, 0x1339b2eb, 0x3b52ec6f, 0x6dfc511f, 0x9b30952c, 0xcc814544, 0xaf5ebd09,
  0xbee3d004, 0xde334afd, 0x660f2807, 0x192e4bb3, 0xc0cba857, 0x45c8740f, 0xd20b5f39, 0xb9d3fbdb,
  0x5579c0bd, 0x1a60320a, 0xd6a100c6, 0x402c7279, 0x679f25fe, 0xfb1fa3cc, 0x8ea5e9f8, 0xdb3222f8,
  0x3c7516df, 0xfd616b15, 0x2f501ec8, 0xad0552ab, 0x323db5fa, 0xfd238760, 0x53317b48, 0x3e00df82,
  0x9e5c57bb, 0xca6f8ca0, 0x1a87562e, 0xdf1769db, 0xd542a8f6, 0x287effc3, 0xac6732c6, 0x8c4f5573,
  0x695b27b0, 0xbbca58c8, 0xe1ffa35d, 0xb8f011a0, 0x10fa3d98, 0xfd2183b8, 0x4afcb56c, 0x2dd1d35b,
  0x9a53e479, 0xb6f84565, 0xd28e49bc, 0x4bfb9790, 0xe1ddf2da, 0xa4cb7e33, 0x62fb1341, 0xcee4c6e8,
  0xef20cada, 0x36774c01, 0xd07e9efe, 0x2bf11fb4, 0x95dbda4d, 0xae909198, 0xeaad8e71, 0x6b93d5a0,
  0xd08ed1d0, 0xafc725e0, 0x8e3c5b2f, 0x8e7594b7, 0x8ff6e2fb, 0xf2122b64, 0x8888b812, 0x900df01c,
  0x4fad5ea0, 0x688fc31c, 0xd1cff191, 0xb3a8c1ad, 0x2f2f2218, 0xbe0e1777, 0xea752dfe, 0x8b021fa1,
  0xe5a0cc0f, 0xb56f74e8, 0x18acf3d6, 0xce89e299, 0xb4a84fe0, 0xfd13e0b7, 0x7cc43b81, 0xd2ada8d9,
  0x165fa266, 0x80957705, 0x93cc7314, 0x211a1477, 0xe6ad2065, 0x77b5fa86, 0xc75442f5, 0xfb9d35cf,
  0xebcdaf0c, 0x7b3e89a0, 0xd6411bd3, 0xae1e7e49, 0x00250e2d, 0x2071b35e, 0x226800bb, 0x57b8e0af,
  0x2464369b, 0xf009b91e, 0x5563911d, 0x59dfa6aa, 0x78c14389, 0xd95a537f, 0x207d5ba2, 0x02e5b9c5,
  0x83260376, 0x6295cfa9, 0x11c81968, 0x4e734a41, 0xb3472dca, 0x7b14a94a, 0x1b510052, 0x9a532915,
  0xd60f573f, 0xbc9bc6e4, 0x2b60a476, 0x81e67400, 0x08ba6fb5, 0x571be91f, 0xf296ec6b, 0x2a0dd915,
  0xb6636521, 0xe7b9f9b6, 0xff34052e, 0xc5855664, 0x53b02d5d, 0xa99f8fa1, 0x08ba4799, 0x6e85076a
];
const BF_S1 = [
  0x4b7a70e9, 0xb5b32944, 0xdb75092e, 0xc4192623, 0xad6ea6b0, 0x49a7df7d, 0x9cee60b8, 0x8fedb266,
  0xecaa8c71, 0x699a17ff, 0x5664526c, 0xc2b19ee1, 0x193602a5, 0x75094c29, 0xa0591340, 0xe4183a3e,
  0x3f54989a, 0x5b429d65, 0x6b8fe4d6, 0x99f73fd6, 0xa1d29c07, 0xefe830f5, 0x4d2d38e6, 0xf0255dc1,
  0x4cdd2086, 0x8470eb26, 0x6382e9c6, 0x021ecc5e, 0x09686b3f, 0x3ebaefc9, 0x3c971814, 0x6b6a70a1,
  0x687f3584, 0x52a0e286, 0xb79c5305, 0xaa500737, 0x3e07841c, 0x7fdeae5c, 0x8e7d44ec, 0x5716f2b8,
  0xb03ada37, 0xf0500c0d, 0xf01c1f04, 0x0200b3ff, 0xae0cf51a, 0x3cb574b2, 0x25837a58, 0xdc0921bd,
  0xd19113f9, 0x7ca92ff6, 0x94324773, 0x22f54701, 0x3ae5e581, 0x37c2dadc, 0xc8b57634, 0x9af3dda7,
  0xa9446146, 0x0fd0030e, 0xecc8c73e, 0xa4751e41, 0xe238cd99, 0x3bea0e2f, 0x3280bba1, 0x183eb331,
  0x4e548b38, 0x4f6db908, 0x6f420d03, 0xf60a04bf, 0x2cb81290, 0x24977c79, 0x5679b072, 0xbcaf89af,
  0xde9a771f, 0xd9930810, 0xb38bae12, 0xdccf3f2e, 0x5512721f, 0x2e6b7124, 0x501adde6, 0x9f84cd87,
  0x7a584718, 0x7408da17, 0xbc9f9abc, 0xe94b7d8c, 0xec7aec3a, 0xdb851dfa, 0x63094366, 0xc464c3d2,
  0xef1c1847, 0x3215d908, 0xdd433b37, 0x24c2ba16, 0x12a14d43, 0x2a65c451, 0x50940002, 0x133ae4dd,
  0x71dff89e, 0x10314e55, 0x81ac77d6, 0x5f11199b, 0x043556f1, 0xd7a3c76b, 0x3c11183b, 0x5924a509,
  0xf28fe6ed, 0x97f1fbfa, 0x9ebabf2c, 0x1e153c6e, 0x86e34570, 0xeae96fb1, 0x860e5e0a, 0x5a3e2ab3,
  0x771fe71c, 0x4e3d06fa, 0x2965dcb9, 0x99e71d0f, 0x803e89d6, 0x5266c825, 0x2e4cc978, 0x9c10b36a,
  0xc6150eba, 0x94e2ea78, 0xa5fc3c53, 0x1e0a2df4, 0xf2f74ea7, 0x361d2b3d, 0x1939260f, 0x19c27960,
  0x5223a708, 0xf71312b6, 0xebadfe6e, 0xeac31f66, 0xe3bc4595, 0xa67bc883, 0xb17f37d1, 0x018cff28,
  0xc332ddef, 0xbe6c5aa5, 0x65582185, 0x68ab9802, 0xeecea50f, 0xdb2f953b, 0x2aef7dad, 0x5b6e2f84,
  0x1521b628, 0x29076170, 0xecdd4775, 0x619f1510, 0x13cca830, 0xeb61bd96, 0x0334fe1e, 0xaa0363cf,
  0xb5735c90, 0x4c70a239, 0xd59e9e0b, 0xcbaade14, 0xeecc86bc, 0x60622ca7, 0x9cab5cab, 0xb2f3846e,
  0x648b1eaf, 0x19bdf0ca, 0xa02369b9, 0x655abb50, 0x40685a32, 0x3c2ab4b3, 0x319ee9d5, 0xc021b8f7,
  0x9b540b19, 0x875fa099, 0x95f7997e, 0x623d7da8, 0xf837889a, 0x97e32d77, 0x11ed935f, 0x16681281,
  0x0e358829, 0xc7e61fd6, 0x96dedfa1, 0x7858ba99, 0x57f584a5, 0x1b227263, 0x9b83c3ff, 0x1ac24696,
  0xcdb30aeb, 0x532e3054, 0x8fd948e4, 0x6dbc3128, 0x58ebf2ef, 0x34c6ffea, 0xfe28ed61, 0xee7c3c73,
  0x5d4a14d9, 0xe864b7e3, 0x42105d14, 0x203e13e0, 0x45eee2b6, 0xa3aaabea, 0xdb6c4f15, 0xfacb4fd0,
  0xc742f442, 0xef6abbb5, 0x654f3b1d, 0x41cd2105, 0xd81e799e, 0x86854dc7, 0xe44b476a, 0x3d816250,
  0xcf62a1f2, 0x5b8d2646, 0xfc8883a0, 0xc1c7b6a3, 0x7f1524c3, 0x69cb7492, 0x47848a0b, 0x5692b285,
  0x095bbf00, 0xad19489d, 0x1462b174, 0x23820e00, 0x58428d2a, 0x0c55f5ea, 0x1dadf43e, 0x233f7061,
  0x3372f092, 0x8d937e41, 0xd65fecf1, 0x6c223bdb, 0x7cde3759, 0xcbee7460, 0x4085f2a7, 0xce77326e,
  0xa6078084, 0x19f8509e, 0xe8efd855, 0x61d99735, 0xa969a7aa, 0xc50c06c2, 0x5a04abfc, 0x800bcadc,
  0x9e447a2e, 0xc3453484, 0xfdd56705, 0x0e1e9ec9, 0xdb73dbd3, 0x105588cd, 0x675fda79, 0xe3674340,
  0xc5c43465, 0x713e38d8, 0x3d28f89e, 0xf16dff20, 0x153e21e7, 0x8fb03d4a, 0xe6e39f2b, 0xdb83adf7
];
const BF_S2 = [
  0xe93d5a68, 0x948140f7, 0xf64c261c, 0x94692934, 0x411520f7, 0x7602d4f7, 0xbcf46b2e, 0xd4a20068,
  0xd4082471, 0x3320f46a, 0x43b7d4b7, 0x500061af, 0x1e39f62e, 0x97244546, 0x14214f74, 0xbf8b8840,
  0x4d95fc1d, 0x96b591af, 0x70f4ddd3, 0x66a02f45, 0xbfbc09ec, 0x03bd9785, 0x7fac6dd0, 0x31cb8504,
  0x96eb27b3, 0x55fd3941, 0xda2547e6, 0xabca0a9a, 0x28507825, 0x530429f4, 0x0a2c86da, 0xe9b66dfb,
  0x68dc1462, 0xd7486900, 0x680ec0a4, 0x27a18dee, 0x4f3ffea2, 0xe887ad8c, 0xb58ce006, 0x7af4d6b6,
  0xaace1e7c, 0xd3375fec, 0xce78a399, 0x406b2a42, 0x20fe9e35, 0xd9f385b9, 0xee39d7ab, 0x3b124e8b,
  0x1dc9faf7, 0x4b6d1856, 0x26a36631, 0xeae397b2, 0x3a6efa74, 0xdd5b4332, 0x6841e7f7, 0xca7820fb,
  0xfb0af54e, 0xd8feb397, 0x454056ac, 0xba489527, 0x55533a3a, 0x20838d87, 0xfe6ba9b7, 0xd096954b,
  0x55a867bc, 0xa1159a58, 0xcca92963, 0x99e1db33, 0xa62a4a56, 0x3f3125f9, 0x5ef47e1c, 0x9029317c,
  0xfdf8e802, 0x04272f70, 0x80bb155c, 0x05282ce3, 0x95c11548, 0xe4c66d22, 0x48c1133f, 0xc70f86dc,
  0x07f9c9ee, 0x41041f0f, 0x404779a4, 0x5d886e17, 0x325f51eb, 0xd59bc0d1, 0xf2bcc18f, 0x41113564,
  0x257b7834, 0x602a9c60, 0xdff8e8a3, 0x1f636c1b, 0x0e12b4c2, 0x02e1329e, 0xaf664fd1, 0xcad18115,
  0x6b2395e0, 0x333e92e1, 0x3b240b62, 0xeebeb922, 0x85b2a20e, 0xe6ba0d99, 0xde720c8c, 0x2da2f728,
  0xd0127845, 0x95b794fd, 0x647d0862, 0xe7ccf5f0, 0x5449a36f, 0x877d48fa, 0xc39dfd27, 0xf33e8d1e,
  0x0a476341, 0x992eff74, 0x3a6f6eab, 0xf4f8fd37, 0xa812dc60, 0xa1ebddf8, 0x991be14c, 0xdb6e6b0d,
  0xc67b5510, 0x6d672c37, 0x2765d43b, 0xdcd0e804, 0xf1290dc7, 0xcc00ffa3, 0xb5390f92, 0x690fed0b,
  0x667b9ffb, 0xcedb7d9c, 0xa091cf0b, 0xd9155ea3, 0xbb132f88, 0x515bad24, 0x7b9479bf, 0x763bd6eb,
  0x37392eb3, 0xcc115979, 0x8026e297, 0xf42e312d, 0x6842ada7, 0xc66a2b3b, 0x12754ccc, 0x782ef11c,
  0x6a124237, 0xb79251e7, 0x06a1bbe6, 0x4bfb6350, 0x1a6b1018, 0x11caedfa, 0x3d25bdd8, 0xe2e1c3c9,
  0x44421659, 0x0a121386, 0xd90cec6e, 0xd5abea2a, 0x64af674e, 0xda86a85f, 0xbebfe988, 0x64e4c3fe,
  0x9dbc8057, 0xf0f7c086, 0x60787bf8, 0x6003604d, 0xd1fd8346, 0xf6381fb0, 0x7745ae04, 0xd736fccc,
  0x83426b33, 0xf01eab71, 0xb0804187, 0x3c005e5f, 0x77a057be, 0xbde8ae24, 0x55464299, 0xbf582e61,
  0x4e58f48f, 0xf2ddfda2, 0xf474ef38, 0x8789bdc2, 0x5366f9c3, 0xc8b38e74, 0xb475f255, 0x46fcd9b9,
  0x7aeb2661, 0x8b1ddf84, 0x846a0e79, 0x915f95e2, 0x466e598e, 0x20b45770, 0x8cd55591, 0xc902de4c,
  0xb90bace1, 0xbb8205d0, 0x11a86248, 0x7574a99e, 0xb77f19b6, 0xe0a9dc09, 0x662d09a1, 0xc4324633,
  0xe85a1f02, 0x09f0be8c, 0x4a99a025, 0x1d6efe10, 0x1ab93d1d, 0x0ba5a4df, 0xa186f20f, 0x2868f169,
  0xdcb7da83, 0x573906fe, 0xa1e2ce9b, 0x4fcd7f52, 0x50115e01, 0xa70683fa, 0xa002b5c4, 0x0de6d027,
  0x9af88c27, 0x773f8641, 0xc3604c06, 0x61a806b5, 0xf0177a28, 0xc0f586e0, 0x006058aa, 0x30dc7d62,
  0x11e69ed7, 0x2338ea63, 0x53c2dd94, 0xc2c21634, 0xbbcbee56, 0x90bcb6de, 0xebfc7da1, 0xce591d76,
  0x6f05e409, 0x4b7c0188, 0x39720a3d, 0x7c927c24, 0x86e3725f, 0x724d9db9, 0x1ac15bb4, 0xd39eb8fc,
  0xed545578, 0x08fca5b5, 0xd83d7cd3, 0x4dad0fc4, 0x1e50ef5e, 0xb161e6f8, 0xa28514d9, 0x6c51133c,
  0x6fd5c7e7, 0x56e14ec4, 0x362abfce, 0xddc6c837, 0xd79a3234, 0x92638212, 0x670efa8e, 0x406000e0
];
const BF_S3 = [
  0x3a39ce37, 0xd3faf5cf, 0xabc27737, 0x5ac52d1b, 0x5cb0679e, 0x4fa33742, 0xd3822740, 0x99bc9bbe,
  0xd5118e9d, 0xbf0f7315, 0xd62d1c7e, 0xc700c47b, 0xb78c1b6b, 0x21a19045, 0xb26eb1be, 0x6a366eb4,
  0x5748ab2f, 0xbc946e79, 0xc6a376d2, 0x6549c2c8, 0x530ff8ee, 0x468dde7d, 0xd5730a1d, 0x4cd04dc6,
  0x2939bbdb, 0xa9ba4650, 0xac9526e8, 0xbe5ee304, 0xa1fad5f0, 0x6a2d519a, 0x63ef8ce2, 0x9a86ee22,
  0xc089c2b8, 0x43242ef6, 0xa51e03aa, 0x9cf2d0a4, 0x83c061ba, 0x9be96a4d, 0x8fe51550, 0xba645bd6,
  0x2826a2f9, 0xa73a3ae1, 0x4ba99586, 0xef5562e9, 0xc72fefd3, 0xf752f7da, 0x3f046f69, 0x77fa0a59,
  0x80e4a915, 0x87b08601, 0x9b09e6ad, 0x3b3ee593, 0xe990fd5a, 0x9e34d797, 0x2cf0b7d9, 0x022b8b51,
  0x96d5ac3a, 0x017da67d, 0xd1cf3ed6, 0x7c7d2d28, 0x1f9f25cf, 0xadf2b89b, 0x5ad6b472, 0x5a88f54c,
  0xe029ac71, 0xe019a5e6, 0x47b0acfd, 0xed93fa9b, 0xe8d3c48d, 0x283b57cc, 0xf8d56629, 0x79132e28,
  0x785f0191, 0xed756055, 0xf7960e44, 0xe3d35e8c, 0x15056dd4, 0x88f46dba, 0x03a16125, 0x0564f0bd,
  0xc3eb9e15, 0x3c9057a2, 0x97271aec, 0xa93a072a, 0x1b3f6d9b, 0x1e6321f5, 0xf59c66fb, 0x26dcf319,
  0x7533d928, 0xb155fdf5, 0x03563482, 0x8aba3cbb, 0x28517711, 0xc20ad9f8, 0xabcc5167, 0xccad925f,
  0x4de81751, 0x3830dc8e, 0x379d5862, 0x9320f991, 0xea7a90c2, 0xfb3e7bce, 0x5121ce64, 0x774fbe32,
  0xa8b6e37e, 0xc3293d46, 0x48de5369, 0x6413e680, 0xa2ae0810, 0xdd6db224, 0x69852dfd, 0x09072166,
  0xb39a460a, 0x6445c0dd, 0x586cdecf, 0x1c20c8ae, 0x5bbef7dd, 0x1b588d40, 0xccd2017f, 0x6bb4e3bb,
  0xdda26a7e, 0x3a59ff45, 0x3e350a44, 0xbcb4cdd5, 0x72eacea8, 0xfa6484bb, 0x8d6612ae, 0xbf3c6f47,
  0xd29be463, 0x542f5d9e, 0xaec2771b, 0xf64e6370, 0x740e0d8d, 0xe75b1357, 0xf8721671, 0xaf537d5d,
  0x4040cb08, 0x4eb4e2cc, 0x34d2466a, 0x0115af84, 0xe1b00428, 0x95983a1d, 0x06b89fb4, 0xce6ea048,
  0x6f3f3b82, 0x3520ab82, 0x011a1d4b, 0x277227f8, 0x611560b1, 0xe7933fdc, 0xbb3a792b, 0x344525bd,
  0xa08839e1, 0x51ce794b, 0x2f32c9b7, 0xa01fbac9, 0xe01cc87e, 0xbcc7d1f6, 0xcf0111c3, 0xa1e8aac7,
  0x1a908749, 0xd44fbd9a, 0xd0dadecb, 0xd50ada38, 0x0339c32a, 0xc6913667, 0x8df9317c, 0xe0b12b4f,
  0xf79e59b7, 0x43f5bb3a, 0xf2d519ff, 0x27d9459c, 0xbf97222c, 0x15e6fc2a, 0x0f91fc71, 0x9b941525,
  0xfae59361, 0xceb69ceb, 0xc2a86459, 0x12baa8d1, 0xb6c1075e, 0xe3056a0c, 0x10d25065, 0xcb03a442,
  0xe0ec6e0e, 0x1698db3b, 0x4c98a0be, 0x3278e964, 0x9f1f9532, 0xe0d392df, 0xd3a0342b, 0x8971f21e,
  0x1b0a7441, 0x4ba3348c, 0xc5be7120, 0xc37632d8, 0xdf359f8d, 0x9b992f2e, 0xe60b6f47, 0x0fe3f11d,
  0xe54cda54, 0x1edad891, 0xce6279cf, 0xcd3e7e6f, 0x1618b166, 0xfd2c1d05, 0x848fd2c5, 0xf6fb2299,
  0xf523f357, 0xa6327623, 0x93a83531, 0x56cccd02, 0xacf08162, 0x5a75ebb5, 0x6e163697, 0x88d273cc,
  0xde966292, 0x81b949d0, 0x4c50901b, 0x71c65614, 0xe6c6c7bd, 0x327a140a, 0x45e1d006, 0xc3f27b9a,
  0xc9aa53fd, 0x62a80f00, 0xbb25bfe2, 0x35bdd2f6, 0x71126905, 0xb2040222, 0xb6cbcf7c, 0xcd769c2b,
  0x53113ec0, 0x1640e3d3, 0x38abbd60, 0x2547adf0, 0xba38209c, 0xf746ce76, 0x77afa1c5, 0x20756060,
  0x85cbfe4e, 0x8ae88dd8, 0x7aaaf9b0, 0x4cf9aa7e, 0x1948c25c, 0x02fb8a8c, 0x01c36ae4, 0xd6ebe1f9,
  0x90d4f869, 0xa65cdea0, 0x3f09252d, 0xc208e69f, 0xb74e6132, 0xce77e25b, 0x578fdfe3, 0x3ac372e6
];

// ─── Minimal Blowfish CBC implementation ─────────────────────────────────────
class Blowfish {
  constructor(key) {
    this.P = BF_P.slice();
    this.S = [BF_S0.slice(), BF_S1.slice(), BF_S2.slice(), BF_S3.slice()];
    let j = 0;
    for (let i = 0; i < 18; i++) {
      let data = 0;
      for (let k = 0; k < 4; k++) {
        data = (data << 8) | key[j % key.length];
        j++;
      }
      this.P[i] ^= data;
    }
    let l = 0, r = 0;
    for (let i = 0; i < 18; i += 2) {
      [l, r] = this._encipher(l, r);
      this.P[i] = l; this.P[i + 1] = r;
    }
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 256; i += 2) {
        [l, r] = this._encipher(l, r);
        this.S[s][i] = l; this.S[s][i + 1] = r;
      }
    }
  }

  _F(x) {
    return (((this.S[0][x >>> 24] + this.S[1][(x >>> 16) & 0xff]) ^ this.S[2][(x >>> 8) & 0xff]) + this.S[3][x & 0xff]) >>> 0;
  }

  _encipher(l, r) {
    for (let i = 0; i < 16; i++) {
      l = (l ^ this.P[i]) >>> 0;
      r = (this._F(l) ^ r) >>> 0;
      [l, r] = [r, l];
    }
    [l, r] = [r, l];
    r = (r ^ this.P[16]) >>> 0;
    l = (l ^ this.P[17]) >>> 0;
    return [l, r];
  }

  _decipher(l, r) {
    for (let i = 17; i > 1; i--) {
      l = (l ^ this.P[i]) >>> 0;
      r = (this._F(l) ^ r) >>> 0;
      [l, r] = [r, l];
    }
    [l, r] = [r, l];
    r = (r ^ this.P[1]) >>> 0;
    l = (l ^ this.P[0]) >>> 0;
    return [l, r];
  }

  decryptCBC(data, iv) {
    const out = new Uint8Array(data.length);
    let prevL = (iv[0]<<24)|(iv[1]<<16)|(iv[2]<<8)|iv[3];
    let prevR = (iv[4]<<24)|(iv[5]<<16)|(iv[6]<<8)|iv[7];
    for (let i = 0; i < data.length; i += 8) {
      const bl = (data[i]<<24)|(data[i+1]<<16)|(data[i+2]<<8)|data[i+3];
      const br = (data[i+4]<<24)|(data[i+5]<<16)|(data[i+6]<<8)|data[i+7];
      let [pl, pr] = this._decipher(bl >>> 0, br >>> 0);
      pl = (pl ^ prevL) >>> 0;
      pr = (pr ^ prevR) >>> 0;
      out[i]   = (pl>>>24)&0xff; out[i+1] = (pl>>>16)&0xff;
      out[i+2] = (pl>>>8)&0xff;  out[i+3] =  pl&0xff;
      out[i+4] = (pr>>>24)&0xff; out[i+5] = (pr>>>16)&0xff;
      out[i+6] = (pr>>>8)&0xff;  out[i+7] =  pr&0xff;
      prevL = bl >>> 0; prevR = br >>> 0;
    }
    return out;
  }
}

async function buildCDNUrl(md5Origin, mediaVersion, trackId, quality) {
  const SEP   = '\xa4';
  const step1 = [md5Origin, quality, trackId, mediaVersion].join(SEP);
  const md5Hex = await md5(step1);
  const step2  = md5Hex + SEP + step1 + SEP;
  const padded = step2.padEnd(Math.ceil(step2.length / 16) * 16, '\0');

  const rawKey = new TextEncoder().encode('jo6aey6haid2Teih');
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['encrypt']);

  const blocks = [];
  const paddedBytes = new TextEncoder().encode(padded);
  for (let i = 0; i < paddedBytes.length; i += 16) {
    const block  = paddedBytes.slice(i, i + 16);
    const zeroIV = new Uint8Array(16);
    const enc    = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIV }, key, block);
    blocks.push(new Uint8Array(enc).slice(0, 16));
  }
  const hexResult = blocks.map(b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')).join('');
  return `https://e-cdns-proxy-${md5Origin[0]}.dzcdn.net/mobile/1/${hexResult}`;
}

// Pure-JS MD5 (SubtleCrypto doesn't support MD5)
async function md5(str) {
  function safeAdd(x, y) { const l = (x & 0xffff) + (y & 0xffff); const m = (x >> 16) + (y >> 16) + (l >> 16); return (m << 16) | (l & 0xffff); }
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function ff(a,b,c,d,x,s,t){return cmn((b&c)|(~b&d),a,b,x,s,t);}
  function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&~d),a,b,x,s,t);}
  function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
  function ii(a,b,c,d,x,s,t){return cmn(c^(b|~d),a,b,x,s,t);}
  const bytes = new TextEncoder().encode(str);
  const len8  = bytes.length;
  const len32 = Math.ceil((len8 + 9) / 64) * 16;
  const M = new Int32Array(len32);
  for (let i = 0; i < len8; i++) M[i >> 2] |= bytes[i] << ((i % 4) * 8);
  M[len8 >> 2] |= 0x80 << ((len8 % 4) * 8);
  M[len32 - 2] = len8 * 8;
  let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
  for (let i = 0; i < len32; i += 16) {
    const [A,B,C,D]=[a,b,c,d];
    a=ff(a,b,c,d,M[i+0],7,-680876936);d=ff(d,a,b,c,M[i+1],12,-389564586);c=ff(c,d,a,b,M[i+2],17,606105819);b=ff(b,c,d,a,M[i+3],22,-1044525330);
    a=ff(a,b,c,d,M[i+4],7,-176418897);d=ff(d,a,b,c,M[i+5],12,1200080426);c=ff(c,d,a,b,M[i+6],17,-1473231341);b=ff(b,c,d,a,M[i+7],22,-45705983);
    a=ff(a,b,c,d,M[i+8],7,1770035416);d=ff(d,a,b,c,M[i+9],12,-1958414417);c=ff(c,d,a,b,M[i+10],17,-42063);b=ff(b,c,d,a,M[i+11],22,-1990404162);
    a=ff(a,b,c,d,M[i+12],7,1804603682);d=ff(d,a,b,c,M[i+13],12,-40341101);c=ff(c,d,a,b,M[i+14],17,-1502002290);b=ff(b,c,d,a,M[i+15],22,1236535329);
    a=gg(a,b,c,d,M[i+1],5,-165796510);d=gg(d,a,b,c,M[i+6],9,-1069501632);c=gg(c,d,a,b,M[i+11],14,643717713);b=gg(b,c,d,a,M[i+0],20,-373897302);
    a=gg(a,b,c,d,M[i+5],5,-701558691);d=gg(d,a,b,c,M[i+10],9,38016083);c=gg(c,d,a,b,M[i+15],14,-660478335);b=gg(b,c,d,a,M[i+4],20,-405537848);
    a=gg(a,b,c,d,M[i+9],5,568446438);d=gg(d,a,b,c,M[i+14],9,-1019803690);c=gg(c,d,a,b,M[i+3],14,-187363961);b=gg(b,c,d,a,M[i+8],20,1163531501);
    a=gg(a,b,c,d,M[i+13],5,-1444681467);d=gg(d,a,b,c,M[i+2],9,-51403784);c=gg(c,d,a,b,M[i+7],14,1735328473);b=gg(b,c,d,a,M[i+12],20,-1926607734);
    a=hh(a,b,c,d,M[i+5],4,-378558);d=hh(d,a,b,c,M[i+8],11,-2022574463);c=hh(c,d,a,b,M[i+11],16,1839030562);b=hh(b,c,d,a,M[i+14],23,-35309556);
    a=hh(a,b,c,d,M[i+1],4,-1530992060);d=hh(d,a,b,c,M[i+4],11,1272893353);c=hh(c,d,a,b,M[i+7],16,-155497632);b=hh(b,c,d,a,M[i+10],23,-1094730640);
    a=hh(a,b,c,d,M[i+13],4,681279174);d=hh(d,a,b,c,M[i+0],11,-358537222);c=hh(c,d,a,b,M[i+3],16,-722521979);b=hh(b,c,d,a,M[i+6],23,76029189);
    a=hh(a,b,c,d,M[i+9],4,-640364487);d=hh(d,a,b,c,M[i+12],11,-421815835);c=hh(c,d,a,b,M[i+15],16,530742520);b=hh(b,c,d,a,M[i+2],23,-995338651);
    a=ii(a,b,c,d,M[i+0],6,-198630844);d=ii(d,a,b,c,M[i+7],10,1126891415);c=ii(c,d,a,b,M[i+14],15,-1416354905);b=ii(b,c,d,a,M[i+5],21,-57434055);
    a=ii(a,b,c,d,M[i+12],6,1700485571);d=ii(d,a,b,c,M[i+3],10,-1894986606);c=ii(c,d,a,b,M[i+10],15,-1051523);b=ii(b,c,d,a,M[i+1],21,-2054922799);
    a=ii(a,b,c,d,M[i+8],6,1873313359);d=ii(d,a,b,c,M[i+15],10,-30611744);c=ii(c,d,a,b,M[i+6],15,-1560198380);b=ii(b,c,d,a,M[i+13],21,1309151649);
    a=ii(a,b,c,d,M[i+4],6,-145523070);d=ii(d,a,b,c,M[i+11],10,-1120210379);c=ii(c,d,a,b,M[i+2],15,718787259);b=ii(b,c,d,a,M[i+9],21,-343485551);
    a=safeAdd(a,A);b=safeAdd(b,B);c=safeAdd(c,C);d=safeAdd(d,D);
  }
  return [a,b,c,d].map(n=>{let h='';for(let i=0;i<4;i++)h+=('0'+((n>>(i*8))&0xff).toString(16)).slice(-2);return h;}).join('');
}

// ─── Config / landing page ────────────────────────────────────────────────────
function buildConfigPage(base) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deezer Addon for Eclipse</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f0f;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}
.card{background:#161616;border:1px solid #232323;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5);margin-bottom:20px}
h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}
h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}
p.sub{font-size:14px;color:#777;margin-bottom:20px;line-height:1.6}
.tip{background:#0d1a2e;border:1px solid #1a3050;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#4a90d9;line-height:1.7}
.tip b{color:#6ab0f5}
.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:8px;margin-top:16px}
input{width:100%;background:#0f0f0f;border:1px solid #222;border-radius:10px;color:#e8e8e8;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}
input:focus{border-color:#a238ff}
input::placeholder{color:#333}
.hint{font-size:12px;color:#484848;margin-bottom:12px;line-height:1.7}
.hint a{color:#a238ff;text-decoration:none}
.hint code{background:#1a1a1a;padding:1px 5px;border-radius:4px;color:#888}
button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}
.bprimary{background:#a238ff;color:#fff}.bprimary:hover{background:#8a2ee0}.bprimary:disabled{background:#252525;color:#444;cursor:not-allowed}
.bsecondary{background:#1a1a2e;color:#e8e8e8;border:1px solid #2a2a50}.bsecondary:hover{background:#22224a}.bsecondary:disabled{background:#252525;color:#444;cursor:not-allowed}
.bcopy{background:#1a1a1a;color:#aaa;border:1px solid #222;font-size:13px;padding:10px}.bcopy:hover{background:#222;color:#fff}
.box{display:none;background:#0f0f0f;border:1px solid #1e1e1e;border-radius:12px;padding:18px;margin-bottom:14px}
.blbl{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.burl{font-size:12px;color:#a238ff;word-break:break-all;font-family:"SF Mono",monospace;margin-bottom:14px;line-height:1.5}
hr{border:none;border-top:1px solid #1a1a1a;margin:24px 0}
.steps{display:flex;flex-direction:column;gap:12px}
.step{display:flex;gap:12px;align-items:flex-start}
.sn{background:#1a1a1a;border:1px solid #252525;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#666}
.st{font-size:13px;color:#666;line-height:1.6}.st b{color:#aaa}
.warn{background:#16100a;border:1px solid #2e1e00;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#8a6000;line-height:1.7}
.status{font-size:13px;color:#666;margin:8px 0;min-height:18px}
.status.ok{color:#5a9e5a}.status.err{color:#c0392b}
.badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;margin-left:8px;vertical-align:middle}
.badge-free{background:#1a2e1a;color:#5a9e5a;border:1px solid #2a4a2a}
.badge-premium{background:#2a1a3e;color:#a238ff;border:1px solid #4a2a70}
footer{margin-top:32px;font-size:12px;color:#333;text-align:center;line-height:1.8}
</style></head><body>
<svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="margin-bottom:20px">
  <circle cx="26" cy="26" r="26" fill="#a238ff"/>
  <path d="M14 32c0-6.6 5.4-12 12-12s12 5.4 12 12" stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity=".4"/>
  <path d="M14 32c0-6.6 5.4-12 12-12" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="26" cy="32" r="4" fill="#fff"/>
  <rect x="28" y="18" width="2.5" height="8" rx="1.25" fill="#fff" opacity=".6"/>
</svg>

<div class="card">
  <h1>Deezer for Eclipse</h1>
  <p class="sub">Generate a URL to add Deezer search and streaming directly into Eclipse Music. No account needed for previews — add your ARL for full tracks.</p>

  <div class="tip"><b>Just click Generate</b> — full tracks are already enabled for everyone. Optionally paste <b>your own ARL</b> below to use your personal Deezer account instead.</div>

  <div class="lbl">Deezer ARL <span style="color:#3a3a3a;font-weight:400;text-transform:none">(optional — only for full tracks)</span></div>
  <input type="password" id="arlInput" placeholder="Leave blank for free previews — or paste your ARL for full tracks">
  <div class="hint">
    Optional — only needed if you want to use <b>your own</b> Deezer account. Log into <a href="https://deezer.com" target="_blank">deezer.com</a>, press <code>F12</code> \u2192 Application (Chrome) or Storage (Firefox) \u2192 Cookies \u2192 <code>https://www.deezer.com</code> \u2192 copy the <code>arl</code> value (192-char hex string).
  </div>

  <button class="bprimary" id="genBtn" onclick="generate()">Generate My Addon URL</button>
  <div class="box" id="genBox">
    <div class="blbl">Your addon URL \u2014 paste into Eclipse <span id="genBadge"></span></div>
    <div class="burl" id="genUrl"></div>
    <button class="bcopy" id="copyBtn" onclick="copyUrl()">Copy URL</button>
  </div>

  <hr>
  <div class="steps">
    <div class="step"><div class="sn">1</div><div class="st">Click <b>Generate</b> above and copy your URL</div></div>
    <div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> \u2192 Settings \u2192 Connections \u2192 Add Connection \u2192 Addon</div></div>
    <div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap <b>Install</b></div></div>
    <div class="step"><div class="sn">4</div><div class="st">Search for any artist, album, or track \u2014 Deezer will appear as a source</div></div>
  </div>

  <div class="warn">\u26a0\ufe0f ARL tokens are personal and tied to your Deezer account. They expire periodically \u2014 if full tracks stop playing, re-grab your ARL and generate a new URL. Never share your ARL publicly.</div>
</div>

<footer>Deezer Eclipse Addon v1.1.0 \u2014 <a href="${base}/health" target="_blank" style="color:#333">${base}</a></footer>

<script>
var _url = '';
function generate() {
  var btn = document.getElementById('genBtn');
  var arl = document.getElementById('arlInput').value.trim();
  btn.disabled = true; btn.textContent = 'Generating...';
  fetch('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arl: arl || null })
  }).then(r => r.json()).then(function(d) {
    if (d.error) { alert(d.error); btn.disabled=false; btn.textContent='Generate My Addon URL'; return; }
    _url = d.manifestUrl;
    document.getElementById('genUrl').textContent = _url;
    document.getElementById('genBadge').innerHTML = d.premium
      ? '<span class="badge badge-premium">Premium \u2736</span>'
      : '<span class="badge badge-free">Free Preview</span>';
    document.getElementById('genBox').style.display = 'block';
    btn.disabled = false; btn.textContent = 'Regenerate URL';
  }).catch(function(e) { alert('Error: ' + e.message); btn.disabled=false; btn.textContent='Generate My Addon URL'; });
}
function copyUrl() {
  if (!_url) return;
  navigator.clipboard.writeText(_url).then(function() {
    var b = document.getElementById('copyBtn');
    b.textContent = 'Copied!';
    setTimeout(function() { b.textContent = 'Copy URL'; }, 1500);
  });
}
</script>
</body></html>`;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────
async function deezerGet(endpoint, params = {}) {
  const u = new URL(`${DEEZER_API}${endpoint}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u.toString());
  return res.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function html(content) {
  return new Response(content, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}
