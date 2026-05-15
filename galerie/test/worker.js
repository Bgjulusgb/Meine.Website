/**
 * Fotogalerie – Cloudflare Worker (Backend-Proxy zur Dropbox API)
 * ─────────────────────────────────────────────────────────────────
 * Aufgabe:
 *   • Hält den Dropbox-Token GEHEIM (Frontend bekommt ihn nie zu sehen).
 *   • Stellt eine kleine REST-API für die Galerie bereit:
 *       GET  /api/photos                          → JSON-Liste aller Bilder
 *       GET  /api/thumb?path=...&size=w640h480    → Thumbnail (image/jpeg)
 *       GET  /api/download?path=...               → 302 zur Original-Datei
 *   • Aktiviert CORS nur für die in ALLOWED_ORIGINS erlaubten Domains.
 *
 * Setup (einmalig):
 *   1. https://dash.cloudflare.com → Workers & Pages → "Create Worker"
 *   2. Diesen Code einfügen, deployen.
 *   3. Im Worker unter "Settings" → "Variables and Secrets":
 *        - Secret  DROPBOX_TOKEN      = dein neuer Dropbox-Token
 *        - Var     DROPBOX_FOLDER     = /meine-fotos
 *        - Var     ALLOWED_ORIGINS    = https://deinedomain.de,https://www.deinedomain.de
 *   4. Die Worker-URL (z.B. https://galerie-api.dein-account.workers.dev)
 *      ins Frontend (CONFIG.apiBase) eintragen.
 *
 * Kosten: 100.000 Anfragen/Tag sind im kostenlosen Plan inklusive.
 */

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff', 'bmp', 'heic', 'avif']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // ─── CORS-Preflight ────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    // ─── Routing ───────────────────────────────────────────────────
    try {
      if (url.pathname === '/api/photos')   return await handlePhotos(env, origin);
      if (url.pathname === '/api/thumb')    return await handleThumb(url, env, origin, ctx);
      if (url.pathname === '/api/download') return await handleDownload(url, env, origin);

      return json({ error: 'Not found' }, 404, origin, env);
    } catch (err) {
      console.error('[Worker]', err);
      return json({ error: err.message || 'Internal error' }, err.status || 500, origin, env);
    }
  },
};

/* ─── Endpoint: /api/photos ─────────────────────────────────────── */
async function handlePhotos(env, origin) {
  const folder = env.DROPBOX_FOLDER || '/';
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
      // Mit Aspect-Ratio aus Media-Info, falls vorhanden (für Masonry)
      width:    e.media_info?.metadata?.dimensions?.width  ?? null,
      height:   e.media_info?.metadata?.dimensions?.height ?? null,
    }));

  return json({ photos, folder }, 200, origin, env, {
    'Cache-Control': 'public, max-age=60', // 1 Min Cache am Edge
  });
}

/* ─── Endpoint: /api/thumb?path=...&size=w640h480 ───────────────── */
async function handleThumb(url, env, origin, ctx) {
  const path = url.searchParams.get('path');
  const size = url.searchParams.get('size') || 'w640h480';

  if (!path || !path.startsWith('/')) throw httpErr(400, 'Invalid path');
  if (!/^w(32|64|128|256|480|640|960|1024|2048)h(32|32|96|128|320|480|640|768|1536)$/.test(size)) {
    throw httpErr(400, 'Invalid size');
  }

  // Versuch: Cache lesen
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const res = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
    method: 'POST',
    headers: {
      'Authorization':     `Bearer ${env.DROPBOX_TOKEN}`,
      'Dropbox-API-Arg':   JSON.stringify({
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

  // Antwort mit langem Cache, da Bild + Pfad stabil sind
  const response = new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type':                'image/jpeg',
      'Cache-Control':               'public, max-age=86400, immutable', // 1 Tag
      'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin : '',
      'X-Content-Type-Options':      'nosniff',
    },
  });

  // Im Hintergrund cachen
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/* ─── Endpoint: /api/download?path=... ──────────────────────────── */
async function handleDownload(url, env, origin) {
  const path = url.searchParams.get('path');
  if (!path || !path.startsWith('/')) throw httpErr(400, 'Invalid path');

  // Temporary Link von Dropbox holen (4 h gültig) und Browser dorthin schicken.
  // Das spart Bandbreite des Workers und liefert die Original-Datei direkt.
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

/* ─── Dropbox-Helfer ─────────────────────────────────────────────── */
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

/* ─── Utils ─────────────────────────────────────────────────────── */
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
  if (!origin) return false;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.length === 0 ? true : list.includes(origin);
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
