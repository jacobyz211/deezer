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
        if (segs[2] === 'stream' && segs[3])  return handleStream(segs[3], entry, env);
        if (segs[2] === 'album'  && segs[3])  return handleAlbum(segs[3]);
        if (segs[2] === 'artist' && segs[3])  return handleArtist(segs[3]);
        if (segs[2] === 'playlist' && segs[3]) return handlePlaylist(segs[3]);
      }

      if (path === 'health') return json({
        status: 'ok',
        version: '1.0.2',
        arlConfigured: !!(env.DEEZER_ARL),
        redisConfigured: !!(env.REDIS_URL && env.REDIS_TOKEN),
        timestamp: new Date().toISOString(),
      });

      // Debug route — shows raw Deezer gateway responses for a track ID
      // Usage: /debug/TRACK_ID  (only works if DEEZER_ARL env is set)
      if (segs[0] === 'debug' && segs[1] && env.DEEZER_ARL) {
        const trackId = segs[1];
        const arl = env.DEEZER_ARL;
        const sid = await dzPing(arl);
        const userData = await dzGw('deezer.getUserData', {}, arl, sid, 'null');
        const apiToken = userData?.results?.checkForm || 'null';
        const licenseToken = userData?.results?.USER?.OPTIONS?.license_token || null;
        const userId = userData?.results?.USER?.USER_ID || 0;
        const listData = await dzGw('song.getListData', { sng_ids: [String(trackId)] }, arl, sid, apiToken);
        const song = listData?.results?.data?.[0];
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

// ─── Upstash Redis (HTTP — works in CF Workers) ───────────────────────────────
// Set REDIS_URL + REDIS_TOKEN env vars to enable token persistence across isolates.
// REDIS_URL = your Upstash REST URL (https://xxx.upstash.io)
async function redisGet(env, key) {
  if (!env.REDIS_URL || !env.REDIS_TOKEN) return null;
  try {
    const r = await fetch(`${env.REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.REDIS_TOKEN}` }
    });
    const j = await r.json();
    return j.result ?? null;
  } catch { return null; }
}

async function redisSet(env, key, value, ttlSec) {
  if (!env.REDIS_URL || !env.REDIS_TOKEN) return;
  try {
    const path = ttlSec
      ? `/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/ex/${ttlSec}`
      : `/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
    await fetch(`${env.REDIS_URL}${path}`, {
      headers: { Authorization: `Bearer ${env.REDIS_TOKEN}` }
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
  if (env.DEEZER_KV) {
    const kv = await env.DEEZER_KV.get('token:' + token);
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
  if (env.DEEZER_KV) {
    await env.DEEZER_KV.put('token:' + token, JSON.stringify(entry), { expirationTtl: 86400 * 90 });
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
  const isPremium = !!(arl || env.DEEZER_ARL);
  const manifestUrl = `${base}/u/${token}/manifest.json`;
  return json({ token, manifestUrl, premium: isPremium });
}

// ─── Manifest ────────────────────────────────────────────────────────────────
function handleManifest(token, entry, base, env) {
  const hasPremium = !!(entry.arl || env.DEEZER_ARL);
  return json({
    id:          `com.eclipse.deezer.${token.slice(0, 8)}`,
    name:        hasPremium ? 'Deezer (Premium)' : 'Deezer (Previews)',
    version:     '1.0.0',
    description: hasPremium
      ? 'Full Deezer streaming.'
      : 'Deezer search + 30-second previews. Visit the addon page to upgrade to full tracks.',
    icon:        'https://cdn.iconscout.com/icon/free/png-256/free-deezer-logo-icon-svg-download-png-461785.png?f=webp',
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
async function handleStream(trackId, entry, env) {
  // User's own ARL takes priority; fall back to server env ARL
  const arl = entry.arl || env.DEEZER_ARL || null;
  if (arl) {
    const result = await getFullStreamURL(trackId, arl);
    if (result) return json(result);
  }
  // Free: 30-second official preview
  const track = await deezerGet(`/track/${trackId}`);
  if (track?.preview) return json({ url: track.preview, format: 'mp3', quality: 'preview_30s' });
  return json({ error: 'No stream available' }, 404);
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

// ─── Premium stream ───────────────────────────────────────────────────────────
// Based on confirmed working flow: ping → getUserData → song.getListData → media.getUrl
async function getFullStreamURL(trackId, arl) {
  try {
    // Step 1: ping to get sid
    const sid = await dzPing(arl);

    // Step 2: getUserData with sid → get apiToken + licenseToken + userId
    const userRaw  = await dzGw('deezer.getUserData', {}, arl, sid, 'null');
    const apiToken     = userRaw?.results?.checkForm || 'null';
    const licenseToken = userRaw?.results?.USER?.OPTIONS?.license_token || null;
    const userId       = userRaw?.results?.USER?.USER_ID || 0;

    if (!userId || userId === 0) {
      console.error('[stream] ARL invalid/expired — userId=0');
      return null;
    }

    // Step 3: song.getListData (more reliable than song.getData for track tokens)
    const listRaw  = await dzGw('song.getListData', { sng_ids: [String(trackId)] }, arl, sid, apiToken);
    const song     = listRaw?.results?.data?.[0];

    // Fallback to song.getData if getListData fails
    let finalSong = song;
    if (!finalSong?.TRACK_TOKEN) {
      const singleRaw = await dzGw('song.getData', { SNG_ID: String(trackId) }, arl, sid, apiToken);
      finalSong = singleRaw?.results;
    }

    if (!finalSong?.MD5_ORIGIN) {
      console.error('[stream] Could not get track data');
      return null;
    }

    const { MD5_ORIGIN, MEDIA_VERSION, SNG_ID, TRACK_TOKEN } = finalSong;

    // Step 4: media.deezer.com/v1/get_url
    // NOTE: no Cookie header here — only license_token in body
    if (TRACK_TOKEN && licenseToken) {
      try {
        const mediaRes = await fetch('https://media.deezer.com/v1/get_url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            'Origin': 'https://www.deezer.com',
          },
          body: JSON.stringify({
            license_token: licenseToken,
            media: [{ type: 'FULL', formats: [
              { cipher: 'BF_CBC_STRIPE', format: 'MP3_320' },
              { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' },
            ]}],
            track_tokens: [TRACK_TOKEN],
          }),
        });
        const mediaData = await mediaRes.json();
        const streamUrl = mediaData?.data?.[0]?.media?.[0]?.sources?.[0]?.url;
        if (streamUrl) {
          const fmt = mediaData?.data?.[0]?.media?.[0]?.format || 'MP3_320';
          return { url: streamUrl, format: 'mp3', quality: fmt.includes('320') ? '320kbps' : '128kbps' };
        }
        console.error('[stream] media.getUrl returned no URL:', JSON.stringify(mediaData).slice(0, 300));
      } catch(e) {
        console.error('[stream] media.getUrl error:', e.message);
      }
    }

    // Step 5: CDN reconstruction last resort
    const url = await buildCDNUrl(MD5_ORIGIN, MEDIA_VERSION, String(SNG_ID || trackId), 3);
    return { url, format: 'mp3', quality: '320kbps' };

  } catch (e) {
    console.error('[stream] Fatal:', e.message);
    return null;
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
    Optional — only needed if you want to use <b>your own</b> Deezer account. Log into <a href="https://deezer.com" target="_blank">deezer.com</a>, press <code>F12</code> → Application (Chrome) or Storage (Firefox) → Cookies → <code>https://www.deezer.com</code> → copy the <code>arl</code> value (192-char hex string).
  </div>

  <button class="bprimary" id="genBtn" onclick="generate()">Generate My Addon URL</button>
  <div class="box" id="genBox">
    <div class="blbl">Your addon URL — paste into Eclipse <span id="genBadge"></span></div>
    <div class="burl" id="genUrl"></div>
    <button class="bcopy" id="copyBtn" onclick="copyUrl()">Copy URL</button>
  </div>

  <hr>
  <div class="steps">
    <div class="step"><div class="sn">1</div><div class="st">Click <b>Generate</b> above and copy your URL</div></div>
    <div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> → Settings → Connections → Add Connection → Addon</div></div>
    <div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap <b>Install</b></div></div>
    <div class="step"><div class="sn">4</div><div class="st">Search for any artist, album, or track — Deezer will appear as a source</div></div>
  </div>

  <div class="warn">⚠️ ARL tokens are personal and tied to your Deezer account. They expire periodically — if full tracks stop playing, re-grab your ARL and generate a new URL. Never share your ARL publicly.</div>
</div>

<footer>Deezer Eclipse Addon v1.0.0 — <a href="${base}/health" target="_blank" style="color:#333">${base}</a></footer>

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
      ? '<span class="badge badge-premium">Premium ✦</span>'
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
