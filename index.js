// ─── Deezer Eclipse Addon — Cloudflare Worker ────────────────────────────────
// Free mode:    previews + search, zero config, no account needed
// Premium mode: full 320kbps streams — set DEEZER_ARL in Worker env vars
//               OR pass X-Deezer-ARL header from a private URL
// ─────────────────────────────────────────────────────────────────────────────

const DEEZER_API = 'https://api.deezer.com';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
};

// ─── Entry point ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const arl = request.headers.get('x-deezer-arl') || env.DEEZER_ARL || null;

    // Strip leading slash and split path
    const path = url.pathname.replace(/^\//, '');
    const segments = path.split('/');

    try {
      if (path === 'manifest.json') return handleManifest(arl);
      if (path === 'search') return handleSearch(url);
      if (segments[0] === 'stream' && segments[1]) return handleStream(segments[1], arl);
      if (segments[0] === 'album' && segments[1]) return handleAlbum(segments[1]);
      if (segments[0] === 'artist' && segments[1]) return handleArtist(segments[1]);
      if (segments[0] === 'playlist' && segments[1]) return handlePlaylist(segments[1]);

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

// ─── Manifest ────────────────────────────────────────────────────────────────
function handleManifest(arl) {
  return json({
    id: 'com.eclipse.deezer',
    name: arl ? 'Deezer (Premium)' : 'Deezer (Previews)',
    version: '1.0.0',
    description: arl
      ? 'Full Deezer streaming via your Premium account.'
      : 'Search + 30-second previews. Add your ARL for full tracks.',
    icon: 'https://e-cdns-files.dzcdn.net/cache/hack/images/common/favicon/favicon-96x96.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist'],
    contentType: 'music',
  });
}

// ─── Search ───────────────────────────────────────────────────────────────────
async function handleSearch(url) {
  const q = url.searchParams.get('q') || '';
  if (!q) return json({ tracks: [], albums: [], artists: [], playlists: [] });

  const [tracksRes, albumsRes, artistsRes, playlistsRes] = await Promise.all([
    deezerGet('/search/track', { q, limit: 20 }),
    deezerGet('/search/album', { q, limit: 10 }),
    deezerGet('/search/artist', { q, limit: 5 }),
    deezerGet('/search/playlist', { q, limit: 5 }),
  ]);

  const tracks = (tracksRes.data || []).map(t => ({
    id: String(t.id),
    title: t.title,
    artist: t.artist?.name || '',
    album: t.album?.title || '',
    duration: t.duration,
    artworkURL: t.album?.cover_xl || t.album?.cover_big || t.album?.cover || '',
    isrc: t.isrc || '',
    format: 'mp3',
    streamURL: t.preview || '',
  }));

  const albums = (albumsRes.data || []).map(a => ({
    id: String(a.id),
    title: a.title,
    artist: a.artist?.name || '',
    artworkURL: a.cover_xl || a.cover_big || a.cover || '',
    trackCount: a.nb_tracks || 0,
    year: a.release_date ? String(a.release_date).slice(0, 4) : '',
  }));

  const artists = (artistsRes.data || []).map(a => ({
    id: String(a.id),
    name: a.name,
    artworkURL: a.picture_xl || a.picture_big || a.picture || '',
  }));

  const playlists = (playlistsRes.data || []).map(p => ({
    id: String(p.id),
    title: p.title,
    creator: p.user?.name || '',
    artworkURL: p.picture_xl || p.picture_big || p.picture || '',
    trackCount: p.nb_tracks || 0,
  }));

  return json({ tracks, albums, artists, playlists });
}

// ─── Stream ──────────────────────────────────────────────────────────────────
async function handleStream(trackId, arl) {
  // Premium: attempt full-length stream via ARL
  if (arl) {
    const result = await getFullStreamURL(trackId, arl);
    if (result) return json(result);
    // Fall through to preview on failure
  }

  // Free: 30-second preview
  const track = await deezerGet(`/track/${trackId}`);
  if (track?.preview) {
    return json({ url: track.preview, format: 'mp3', quality: 'preview_30s' });
  }
  return json({ error: 'No preview available' }, 404);
}

// ─── Album ───────────────────────────────────────────────────────────────────
async function handleAlbum(albumId) {
  const data = await deezerGet(`/album/${albumId}`);
  const tracks = (data.tracks?.data || []).map(t => ({
    id: String(t.id),
    title: t.title,
    artist: t.artist?.name || data.artist?.name || '',
    album: data.title,
    duration: t.duration,
    artworkURL: data.cover_xl || data.cover_big || '',
    isrc: t.isrc || '',
    format: 'mp3',
  }));

  return json({
    id: String(data.id),
    title: data.title,
    artist: data.artist?.name || '',
    artworkURL: data.cover_xl || data.cover_big || '',
    year: data.release_date ? String(data.release_date).slice(0, 4) : '',
    trackCount: data.nb_tracks,
    tracks,
  });
}

// ─── Artist ──────────────────────────────────────────────────────────────────
async function handleArtist(artistId) {
  const [artist, topRes, albumsRes] = await Promise.all([
    deezerGet(`/artist/${artistId}`),
    deezerGet(`/artist/${artistId}/top`, { limit: 10 }),
    deezerGet(`/artist/${artistId}/albums`, { limit: 20 }),
  ]);

  const topTracks = (topRes.data || []).map(t => ({
    id: String(t.id),
    title: t.title,
    artist: artist.name,
    duration: t.duration,
    artworkURL: t.album?.cover_xl || '',
    isrc: t.isrc || '',
    format: 'mp3',
  }));

  const albums = (albumsRes.data || []).map(a => ({
    id: String(a.id),
    title: a.title,
    artist: artist.name,
    artworkURL: a.cover_xl || a.cover_big || '',
    trackCount: a.nb_tracks || 0,
    year: a.release_date ? String(a.release_date).slice(0, 4) : '',
  }));

  return json({
    id: String(artist.id),
    name: artist.name,
    artworkURL: artist.picture_xl || artist.picture_big || '',
    topTracks,
    albums,
  });
}

// ─── Playlist ────────────────────────────────────────────────────────────────
async function handlePlaylist(playlistId) {
  const data = await deezerGet(`/playlist/${playlistId}`);
  const tracks = (data.tracks?.data || []).map(t => ({
    id: String(t.id),
    title: t.title,
    artist: t.artist?.name || '',
    album: t.album?.title || '',
    duration: t.duration,
    artworkURL: t.album?.cover_xl || '',
    isrc: t.isrc || '',
    format: 'mp3',
  }));

  return json({
    id: String(data.id),
    title: data.title,
    description: data.description || '',
    artworkURL: data.picture_xl || data.picture_big || '',
    creator: data.creator?.name || '',
    tracks,
  });
}

// ─── Premium stream: reconstruct CDN URL via internal Deezer gateway ──────────
async function getFullStreamURL(trackId, arl) {
  try {
    // Hit the internal gw-light API to get MD5_ORIGIN + MEDIA_VERSION
    const gwRes = await fetch(
      'https://www.deezer.com/ajax/gw-light.php?method=song.getData&input=3&api_version=1.0&api_token=null',
      {
        method: 'POST',
        headers: {
          'Cookie': `arl=${arl}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ SNG_ID: trackId }),
      }
    );

    const gwData = await gwRes.json();
    const r = gwData?.results;
    if (!r?.MD5_ORIGIN) return null;

    const { MD5_ORIGIN, MEDIA_VERSION, SNG_ID } = r;
    const url = buildCDNUrl(MD5_ORIGIN, MEDIA_VERSION, String(SNG_ID), 3);
    return { url, format: 'mp3', quality: '320kbps' };
  } catch (e) {
    console.error('[stream] Premium error:', e.message);
    return null;
  }
}

// ─── AES-128-ECB CDN URL builder (matches deemix/streamrip method) ────────────
async function buildCDNUrl(md5Origin, mediaVersion, trackId, quality) {
  // quality: 1=128kbps, 3=320kbps, 9=flac
  const SEP = '\xa4';
  const step1 = [md5Origin, quality, trackId, mediaVersion].join(SEP);

  // MD5 of step1
  const md5Hex = await md5(step1);

  const step2 = md5Hex + SEP + step1 + SEP;
  const padded = step2.padEnd(Math.ceil(step2.length / 16) * 16, '\0');

  // AES-128-ECB encrypt
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('jo6aey6haid2Teih'),
    { name: 'AES-CBC' }, // Workers don't support ECB natively; we simulate with CBC + zero IV
    false,
    ['encrypt']
  );

  // Simulate ECB by encrypting each 16-byte block independently with zero IV
  const blocks = [];
  const encoder = new TextEncoder();
  const paddedBytes = encoder.encode(padded);

  for (let i = 0; i < paddedBytes.length; i += 16) {
    const block = paddedBytes.slice(i, i + 16);
    const zeroIV = new Uint8Array(16);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIV }, key, block);
    // AES-CBC with zero IV on a single block = ECB block output (first 16 bytes)
    blocks.push(new Uint8Array(encrypted).slice(0, 16));
  }

  const hexResult = blocks.map(b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')).join('');
  return `https://e-cdns-proxy-${md5Origin[0]}.dzcdn.net/mobile/1/${hexResult}`;
}

// ─── MD5 via SubtleCrypto (Workers-compatible) ────────────────────────────────
// Note: SubtleCrypto doesn't support MD5. We use a pure-JS fallback.
async function md5(str) {
  // Pure-JS MD5 — lightweight implementation
  function safeAdd(x, y) { const lsw = (x & 0xffff) + (y & 0xffff); const msw = (x >> 16) + (y >> 16) + (lsw >> 16); return (msw << 16) | (lsw & 0xffff); }
  function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

  const bytes = new TextEncoder().encode(str);
  const len8 = bytes.length;
  const len32 = Math.ceil((len8 + 9) / 64) * 16;
  const M = new Int32Array(len32);
  for (let i = 0; i < len8; i++) M[i >> 2] |= bytes[i] << ((i % 4) * 8);
  M[len8 >> 2] |= 0x80 << ((len8 % 4) * 8);
  M[len32 - 2] = len8 * 8;

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < len32; i += 16) {
    const [A, B, C, D] = [a, b, c, d];
    a = md5ff(a,b,c,d,M[i],7,-680876936); d = md5ff(d,a,b,c,M[i+1],12,-389564586); c = md5ff(c,d,a,b,M[i+2],17,606105819); b = md5ff(b,c,d,a,M[i+3],22,-1044525330);
    a = md5ff(a,b,c,d,M[i+4],7,-176418897); d = md5ff(d,a,b,c,M[i+5],12,1200080426); c = md5ff(c,d,a,b,M[i+6],17,-1473231341); b = md5ff(b,c,d,a,M[i+7],22,-45705983);
    a = md5ff(a,b,c,d,M[i+8],7,1770035416); d = md5ff(d,a,b,c,M[i+9],12,-1958414417); c = md5ff(c,d,a,b,M[i+10],17,-42063); b = md5ff(b,c,d,a,M[i+11],22,-1990404162);
    a = md5ff(a,b,c,d,M[i+12],7,1804603682); d = md5ff(d,a,b,c,M[i+13],12,-40341101); c = md5ff(c,d,a,b,M[i+14],17,-1502002290); b = md5ff(b,c,d,a,M[i+15],22,1236535329);
    a = md5gg(a,b,c,d,M[i+1],5,-165796510); d = md5gg(d,a,b,c,M[i+6],9,-1069501632); c = md5gg(c,d,a,b,M[i+11],14,643717713); b = md5gg(b,c,d,a,M[i],20,-373897302);
    a = md5gg(a,b,c,d,M[i+5],5,-701558691); d = md5gg(d,a,b,c,M[i+10],9,38016083); c = md5gg(c,d,a,b,M[i+15],14,-660478335); b = md5gg(b,c,d,a,M[i+4],20,-405537848);
    a = md5gg(a,b,c,d,M[i+9],5,568446438); d = md5gg(d,a,b,c,M[i+14],9,-1019803690); c = md5gg(c,d,a,b,M[i+3],14,-187363961); b = md5gg(b,c,d,a,M[i+8],20,1163531501);
    a = md5gg(a,b,c,d,M[i+13],5,-1444681467); d = md5gg(d,a,b,c,M[i+2],9,-51403784); c = md5gg(c,d,a,b,M[i+7],14,1735328473); b = md5gg(b,c,d,a,M[i+12],20,-1926607734);
    a = md5hh(a,b,c,d,M[i+5],4,-378558); d = md5hh(d,a,b,c,M[i+8],11,-2022574463); c = md5hh(c,d,a,b,M[i+11],16,1839030562); b = md5hh(b,c,d,a,M[i+14],23,-35309556);
    a = md5hh(a,b,c,d,M[i+1],4,-1530992060); d = md5hh(d,a,b,c,M[i+4],11,1272893353); c = md5hh(c,d,a,b,M[i+7],16,-155497632); b = md5hh(b,c,d,a,M[i+10],23,-1094730640);
    a = md5hh(a,b,c,d,M[i+13],4,681279174); d = md5hh(d,a,b,c,M[i],11,-358537222); c = md5hh(c,d,a,b,M[i+3],16,-722521979); b = md5hh(b,c,d,a,M[i+6],23,76029189);
    a = md5hh(a,b,c,d,M[i+9],4,-640364487); d = md5hh(d,a,b,c,M[i+12],11,-421815835); c = md5hh(c,d,a,b,M[i+15],16,530742520); b = md5hh(b,c,d,a,M[i+2],23,-995338651);
    a = md5ii(a,b,c,d,M[i],6,-198630844); d = md5ii(d,a,b,c,M[i+7],10,1126891415); c = md5ii(c,d,a,b,M[i+14],15,-1416354905); b = md5ii(b,c,d,a,M[i+5],21,-57434055);
    a = md5ii(a,b,c,d,M[i+12],6,1700485571); d = md5ii(d,a,b,c,M[i+3],10,-1894986606); c = md5ii(c,d,a,b,M[i+10],15,-1051523); b = md5ii(b,c,d,a,M[i+1],21,-2054922799);
    a = md5ii(a,b,c,d,M[i+8],6,1873313359); d = md5ii(d,a,b,c,M[i+15],10,-30611744); c = md5ii(c,d,a,b,M[i+6],15,-1560198380); b = md5ii(b,c,d,a,M[i+13],21,1309151649);
    a = md5ii(a,b,c,d,M[i+4],6,-145523070); d = md5ii(d,a,b,c,M[i+11],10,-1120210379); c = md5ii(c,d,a,b,M[i+2],15,718787259); b = md5ii(b,c,d,a,M[i+9],21,-343485551);
    a = safeAdd(a,A); b = safeAdd(b,B); c = safeAdd(c,C); d = safeAdd(d,D);
  }

  return [a,b,c,d].map(n => {
    let h = '';
    for (let i = 0; i < 4; i++) h += ('0' + ((n >> (i*8)) & 0xff).toString(16)).slice(-2);
    return h;
  }).join('');
}

// ─── Shared helpers ───────────────────────────────────────────────────────────
async function deezerGet(endpoint, params = {}) {
  const url = new URL(`${DEEZER_API}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return res.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}
