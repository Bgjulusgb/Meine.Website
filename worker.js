/**
 * Fotogalerie – Cloudflare Worker (Backend-Proxy zur Dropbox API)
 * ─────────────────────────────────────────────────────────────────
 * Aufgabe:
 *   • Hält den Dropbox-Token GEHEIM (Frontend bekommt ihn nie zu sehen).
 *   • REST-API für die Galerie:
 *       GET  /api/photos                          → JSON-Liste aller Bilder
 *       GET  /api/thumb?path=...&size=w640h480    → Thumbnail (image/jpeg)
 *       GET  /api/download?path=...               → 302 zur Original-Datei
 *       GET  /api/health                          → einfacher Health-Check
 *   • CORS nur für die in ALLOWED_ORIGINS erlaubten Domains.
 *
 * Setup:
 *   1. Cloudflare Dashboard → Workers & Pages → "Create Worker"
 *   2. Diesen Code einfügen, deployen.
 *   3. In Settings → Variables and Secrets:
 *        - Secret  DROPBOX_TOKEN     = dein Dropbox-Token
 *        - Var     DROPBOX_FOLDER    = /meine-fotos
 *        - Var     ALLOWED_ORIGINS   = https://benni-photo.com,https://www.benni-photo.com
 *   4. Worker-URL ins Frontend (CONFIG.apiBase) eintragen.
 */

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff', 'bmp', 'heic', 'avif']);

const VALID_SIZES = new Set([
  'w32h32', 'w64h64', 'w128h128', 'w256h256',
  'w480h320', 'w640h480', 'w960h640', 'w1024h768', 'w2048h1536',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    try {
      if (url.pathname === '/api/photos')   return await handlePhotos(env, origin, ctx);
      if (url.pathname === '/api/thumb')    return await handleThumb(url, env, origin, ctx);
      if (url.pathname === '/api/download') return await handleDownload(url, env, origin);
      if (url.pathname === '/api/health')   return json({ status: 'ok', time: Date.now() }, 200, origin, env);

      return json({ error: 'Not found' }, 404, origin, env);
    } catch (err) {
      console.error('[Worker]', err);
      return json({ error: err.message || 'Internal error' }, err.status || 500, origin, env);
    }
  },
};

/* ─── /api/photos ─────────────────────────────────────────────── */
async function handlePhotos(env, origin, ctx) {
  if (!env.DROPBOX_TOKEN) throw httpErr(500, 'DROPBOX_TOKEN nicht konfiguriert');

  const folder = env.DROPBOX_FOLDER || '/';

  // Edge-Cache: für 60s wiederverwenden (entlastet Dropbox-API)
  const cacheKey = new Request(`https://internal/photos${encodeURIComponent(folder)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type':                'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin : '',
        'X-Cache':                     'HIT',
        'Cache-Control':               'public, max-age=60',
      },
    });
  }

  const entries = await listFolderRecursive(folder, env.DROPBOX_TOKEN);

  const photos = entries
    .filter(e => e['.tag'] === 'file' && !e.name.startsWith('.'))
    .filter(e => {
      const ext = e.name.split('.').pop()?.toLowerCase();
      return ext && IMAGE_EXTS.has(ext);
    })
    .map(e => ({
      id:       e.id,
      name:     e.name,
      path:     e.path_lower,
      size:     e.size ?? 0,
      modified: e.server_modified ?? null,
      width:    e.media_info?.metadata?.dimensions?.width  ?? null,
      height:   e.media_info?.metadata?.dimensions?.height ?? null,
    }));

  const body = JSON.stringify({ photos, folder });
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin : '',
      'X-Cache':                     'MISS',
      'Cache-Control':               'public, max-age=60',
      'X-Content-Type-Options':      'nosniff',
    },
  });

  ctx.waitUntil(cache.put(cacheKey, new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  })));

  return response;
}

/* ─── /api/thumb?path=...&size=w640h480 ───────────────────────── */
async function handleThumb(url, env, origin, ctx) {
  if (!env.DROPBOX_TOKEN) throw httpErr(500, 'DROPBOX_TOKEN nicht konfiguriert');

  const path = url.searchParams.get('path');
  const size = url.searchParams.get('size') || 'w640h480';

  if (!path || !path.startsWith('/')) throw httpErr(400, 'Invalid path');
  if (!VALID_SIZES.has(size))         throw httpErr(400, 'Invalid size');

  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const res = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${env.DROPBOX_TOKEN}`,
      'Dropbox-API-Arg': JSON.stringify({
        resource: { '.tag': 'path', path },
        format:   { '.tag': 'jpeg' },
        size:     { '.tag': size },
        mode:     { '.tag': 'fitone_bestfit' },
      }),
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw httpErr(res.status, `Thumbnail-Fehler: ${errText.slice(0, 200)}`);
  }

  const response = new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type':                'image/jpeg',
      'Cache-Control':               'public, max-age=86400, immutable',
      'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin : '',
      'X-Content-Type-Options':      'nosniff',
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/* ─── /api/download?path=... ──────────────────────────────────── */
async function handleDownload(url, env, origin) {
  if (!env.DROPBOX_TOKEN) throw httpErr(500, 'DROPBOX_TOKEN nicht konfiguriert');

  const path = url.searchParams.get('path');
  if (!path || !path.startsWith('/')) throw httpErr(400, 'Invalid path');

  const res = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.DROPBOX_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ path }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw httpErr(res.status, `Download-Fehler: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return new Response(null, {
    status: 302,
    headers: {
      'Location':                    data.link,
      'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin : '',
      'Cache-Control':               'no-store',
    },
  });
}

/* ─── Dropbox-Helfer ──────────────────────────────────────────── */
async function listFolderRecursive(path, token) {
  const out = [];
  let data = await dbx('https://api.dropboxapi.com/2/files/list_folder', token, {
    path, recursive: false, include_media_info: true, limit: 2000,
  });
  out.push(...data.entries);
  while (data.has_more) {
    data = await dbx('https://api.dropboxapi.com/2/files/list_folder/continue', token, {
      cursor: data.cursor,
    });
    out.push(...data.entries);
  }
  return out;
}

async function dbx(endpoint, token, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw httpErr(res.status, errText.slice(0, 300));
  }
  return res.json();
}

/* ─── Utils ───────────────────────────────────────────────────── */
function corsHeaders(origin, env) {
  const allowed = isAllowed(origin, env);
  return {
    'Access-Control-Allow-Origin':  allowed ? origin : '',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

function isAllowed(origin, env) {
  if (!origin) return true;  // Direct fetch (kein CORS-Origin) auch erlauben (Browser-Cache, etc.)
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  return list.some(allowed => {
    if (allowed === origin) return true;
    if (allowed === '*')    return true;
    return false;
  });
}

function json(obj, status, origin, env, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin : '',
      'X-Content-Type-Options':      'nosniff',
      ...extraHeaders,
    },
  });
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
