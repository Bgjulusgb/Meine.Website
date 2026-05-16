/**
 * Kundengalerie – Cloudflare Worker v3.0.0
 * ─────────────────────────────────────────────────────────────────
 * Architektur:  GitHub Pages (Frontend) ↔ Worker (Auth + Proxy) ↔ Dropbox (Storage)
 * Bilder sind NIEMALS direkt erreichbar – immer über diesen Worker.
 *
 * REST-API:
 *   GET  /api/health                              → Lebenszeichen
 *   GET  /api/diagnose                            → Konfigurations-Check
 *   POST /api/auth                                → Passwort prüfen / Status
 *   GET  /api/photos[?subfolder=NAME]             → JSON-Liste aller Bilder
 *   GET  /api/thumb?path=...&size=w640h480        → Thumbnail (image/jpeg, gecacht)
 *   GET  /api/download?path=...                   → Datei-Download (gestreamt, kein Redirect)
 *
 * Multi-Kunden: DROPBOX_FOLDER ist der Root. Jeder Kunde hat einen Unterordner.
 *   Anfrage mit ?subfolder=lena → liest aus DROPBOX_FOLDER/lena
 *   Der Unterordner darf nur Buchstaben, Ziffern, -, _ und Leerzeichen enthalten.
 *
 * Secrets (Cloudflare Dashboard oder wrangler secret put):
 *   DROPBOX_REFRESH_TOKEN   OAuth2 Refresh-Token (empfohlen, läuft nie ab)
 *   DROPBOX_APP_KEY         App-Key aus Dropbox Developer Console
 *   DROPBOX_APP_SECRET      App-Secret aus Dropbox Developer Console
 *   DROPBOX_TOKEN           Statischer Access-Token (Fallback, läuft nach ~4h ab)
 *   GALLERY_PASSWORD_HASH   SHA-256("bg-gallery-salt-v1:PASSWORT") als Hex (optional)
 *
 * Variables (wrangler.toml [vars]):
 *   DROPBOX_FOLDER          Root-Ordner, z.B. /kundengalerien
 *   ALLOWED_ORIGINS         Komma-getrennte CORS-Origins, z.B. https://benni-photo.com
 */

const VERSION       = 'galerie-api/3.0.0';
const PASSWORD_SALT = 'bg-gallery-salt-v1';

// Token-Cache auf Isolate-Ebene (30 s – einige Minuten Lebensdauer)
let _tokenCache = { token: null, expiresAt: 0 };

const IMAGE_EXTS = new Set(['jpg','jpeg','png','webp','gif','tiff','bmp','heic','avif']);

const VALID_SIZES = new Set([
  'w32h32','w64h64','w128h128','w256h256',
  'w480h320','w640h480','w960h640','w1024h768','w2048h1536',
]);

const PUBLIC_PATHS = new Set(['/api/health','/api/diagnose','/api/auth']);

// Erlaubte Zeichen für Unterordner-Namen (kein Pfad-Traversal)
const SAFE_SUBFOLDER = /^[a-zA-Z0-9_\-äöüÄÖÜß][a-zA-Z0-9_\- äöüÄÖÜß]{0,63}$/;

/* ═══════════════════════════════════════════════════════
   ENTRY POINT
═══════════════════════════════════════════════════════ */
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    try {
      if (!PUBLIC_PATHS.has(url.pathname) && !(await checkAuth(request, env))) {
        return json({ error: 'Nicht autorisiert', code: 'AUTH_REQUIRED',
          detail: 'Bitte mit dem Galerie-Passwort anmelden.' }, 401, origin, env);
      }

      switch (url.pathname) {
        case '/api/health':   return json({ status: 'ok', time: Date.now(), version: VERSION }, 200, origin, env);
        case '/api/diagnose': return handleDiagnose(env, origin);
        case '/api/auth':     return handleAuth(request, env, origin);
        case '/api/photos':   return handlePhotos(url, env, origin, ctx);
        case '/api/thumb':    return handleThumb(url, env, origin, ctx);
        case '/api/download': return handleDownload(url, env, origin);
        default:              return json({ error: 'Not found', code: 'NOT_FOUND', path: url.pathname }, 404, origin, env);
      }
    } catch (err) {
      console.error('[Worker]', url.pathname, err?.message);
      return json({
        error:  err.message || 'Internal error',
        code:   err.code    || 'INTERNAL',
        path:   url.pathname,
        detail: err.detail  || undefined,
      }, err.status || 500, origin, env);
    }
  },
};

/* ═══════════════════════════════════════════════════════
   DROPBOX TOKEN – OAuth2 Refresh-Flow + Isolate-Cache
═══════════════════════════════════════════════════════ */
async function getDropboxToken(env) {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 5 * 60 * 1000) {
    return _tokenCache.token;
  }

  if (env.DROPBOX_REFRESH_TOKEN && env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET) {
    const res = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: env.DROPBOX_REFRESH_TOKEN,
        client_id:     env.DROPBOX_APP_KEY,
        client_secret: env.DROPBOX_APP_SECRET,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw httpErr(500, `Token-Refresh fehlgeschlagen (${res.status})`, 'TOKEN_REFRESH_FAILED', t.slice(0, 300));
    }
    const data = await res.json();
    if (!data.access_token) throw httpErr(500, 'Token-Refresh: kein access_token', 'TOKEN_REFRESH_FAILED');
    const ttl = (data.expires_in || 14400) * 1000;
    _tokenCache = { token: data.access_token, expiresAt: Date.now() + ttl };
    return data.access_token;
  }

  if (env.DROPBOX_TOKEN) return env.DROPBOX_TOKEN;

  throw httpErr(500,
    'Kein Dropbox-Token konfiguriert. Secrets setzen: DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET',
    'NO_TOKEN');
}

function hasAnyDropboxToken(env) {
  return !!(env.DROPBOX_REFRESH_TOKEN || env.DROPBOX_TOKEN);
}

/* ═══════════════════════════════════════════════════════
   PFAD-HILFSFUNKTIONEN
═══════════════════════════════════════════════════════ */
function resolveFolder(env, subfolder) {
  const root = (env.DROPBOX_FOLDER || '').replace(/\/+$/, '');
  if (!subfolder) return root;
  if (!SAFE_SUBFOLDER.test(subfolder.trim())) {
    throw httpErr(400, 'Ungültiger Unterordner-Name', 'BAD_FOLDER');
  }
  return `${root}/${subfolder.trim()}`;
}

function assertPathInRoot(path, env, subfolder) {
  // Stellt sicher, dass ein angefragter Pfad unter dem erlaubten Ordner liegt.
  const folder = resolveFolder(env, subfolder || null).toLowerCase();
  const p      = (path || '').toLowerCase();
  if (!p.startsWith(folder + '/') && p !== folder) {
    throw httpErr(403, 'Pfad liegt außerhalb des erlaubten Ordners', 'PATH_FORBIDDEN');
  }
}

/* ═══════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════ */
async function checkAuth(request, env) {
  const required = (env.GALLERY_PASSWORD_HASH || '').trim().toLowerCase();
  if (!required) return true;

  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (m && safeEqualHex(m[1].toLowerCase(), required)) return true;

  const t = (new URL(request.url).searchParams.get('token') || '').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(t) && safeEqualHex(t, required)) return true;

  return false;
}

async function handleAuth(request, env, origin) {
  const required = (env.GALLERY_PASSWORD_HASH || '').trim().toLowerCase();
  if (!required) {
    return json({ ok: true, passwordRequired: false, message: 'Kein Passwort konfiguriert.' }, 200, origin, env);
  }

  let payload = {};
  try { payload = await request.json(); } catch { /* leerer body ok */ }

  let hash = (payload?.hash || '').toLowerCase();
  if (!hash && payload?.password) {
    hash = await sha256Hex(`${PASSWORD_SALT}:${payload.password}`);
  }

  if (!hash) {
    return json({ ok: false, passwordRequired: true, error: 'Passwort erforderlich', code: 'AUTH_REQUIRED' }, 200, origin, env);
  }
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return json({ ok: false, error: 'Hash hat falsches Format', code: 'BAD_INPUT' }, 400, origin, env);
  }
  if (!safeEqualHex(hash, required)) {
    return json({ ok: false, passwordRequired: true, error: 'Passwort falsch', code: 'BAD_PASSWORD' }, 401, origin, env);
  }
  return json({ ok: true, token: hash, passwordRequired: true }, 200, origin, env);
}

/* ═══════════════════════════════════════════════════════
   DIAGNOSE
═══════════════════════════════════════════════════════ */
async function handleDiagnose(env, origin) {
  const useRefresh = !!(env.DROPBOX_REFRESH_TOKEN && env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET);
  const out = {
    version:           VERSION,
    time:              new Date().toISOString(),
    tokenMode:         useRefresh ? 'oauth2_refresh' : (env.DROPBOX_TOKEN ? 'static_token' : 'none'),
    hasRefreshToken:   !!env.DROPBOX_REFRESH_TOKEN,
    hasAppKey:         !!env.DROPBOX_APP_KEY,
    hasAppSecret:      !!env.DROPBOX_APP_SECRET,
    hasStaticToken:    !!env.DROPBOX_TOKEN,
    folder:            env.DROPBOX_FOLDER || '(nicht gesetzt)',
    allowedOrigins:    (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    passwordProtected: !!(env.GALLERY_PASSWORD_HASH || '').trim(),
    requestOrigin:     origin || null,
    originAllowed:     isAllowed(origin, env),
    dropboxCheck:      null,
  };

  if (hasAnyDropboxToken(env)) {
    try {
      const token = await getDropboxToken(env);
      const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const d = await res.json();
        out.dropboxCheck = { ok: true, account: d?.email || d?.name?.display_name || 'unknown' };
      } else {
        out.dropboxCheck = { ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
      }
    } catch (e) {
      out.dropboxCheck = { ok: false, error: e.message };
    }
  } else {
    out.dropboxCheck = { ok: false, error: 'Kein Dropbox-Token konfiguriert' };
  }

  return json(out, 200, origin, env, { 'Cache-Control': 'no-store' });
}

/* ═══════════════════════════════════════════════════════
   /api/photos
═══════════════════════════════════════════════════════ */
async function handlePhotos(url, env, origin, ctx) {
  if (!hasAnyDropboxToken(env)) throw httpErr(500, 'Kein Dropbox-Token konfiguriert', 'NO_TOKEN');

  const subfolder = url.searchParams.get('subfolder') || '';
  const folder    = resolveFolder(env, subfolder);

  const cacheKey = new Request(`https://internal/photos${encodeURIComponent(folder)}`);
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type':                'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin || '*' : 'null',
        'X-Cache':                     'HIT',
        'Cache-Control':               'public, max-age=60',
        'Vary':                        'Origin',
      },
    });
  }

  const token   = await getDropboxToken(env);
  const entries = await listFolderRecursive(folder, token);

  const photos = entries
    .filter(e => e['.tag'] === 'file' && !e.name.startsWith('.'))
    .filter(e => IMAGE_EXTS.has((e.name.split('.').pop() || '').toLowerCase()))
    .map(e => ({
      id:       e.id,
      name:     e.name,
      path:     e.path_lower,
      size:     e.size    ?? 0,
      modified: e.server_modified ?? null,
      width:    e.media_info?.metadata?.dimensions?.width  ?? null,
      height:   e.media_info?.metadata?.dimensions?.height ?? null,
    }));

  const body = JSON.stringify({ photos, folder: folder || '/', count: photos.length, subfolder: subfolder || null });
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin || '*' : 'null',
      'X-Cache':                     'MISS',
      'Cache-Control':               'public, max-age=60',
      'X-Content-Type-Options':      'nosniff',
      'Vary':                        'Origin',
    },
  });

  ctx.waitUntil(cache.put(cacheKey, new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  })));

  return response;
}

/* ═══════════════════════════════════════════════════════
   /api/thumb
═══════════════════════════════════════════════════════ */
async function handleThumb(url, env, origin, ctx) {
  if (!hasAnyDropboxToken(env)) throw httpErr(500, 'Kein Dropbox-Token konfiguriert', 'NO_TOKEN');

  const path = url.searchParams.get('path');
  const size = url.searchParams.get('size') || 'w640h480';

  if (!path || !path.startsWith('/')) throw httpErr(400, 'Ungültiger Pfad', 'BAD_PATH');
  if (!VALID_SIZES.has(size))         throw httpErr(400, `Ungültige Größe: ${size}`, 'BAD_SIZE');

  // Pfad darf nur innerhalb des konfigurierten Ordners liegen
  const root = (env.DROPBOX_FOLDER || '').replace(/\/+$/, '').toLowerCase();
  if (root && !path.toLowerCase().startsWith(root + '/') && path.toLowerCase() !== root) {
    throw httpErr(403, 'Pfad außerhalb des Galerie-Ordners', 'PATH_FORBIDDEN');
  }

  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  const token = await getDropboxToken(env);
  const res = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({
        resource: { '.tag': 'path', path },
        format:   { '.tag': 'jpeg' },
        size:     { '.tag': size },
        mode:     { '.tag': 'fitone_bestfit' },
      }),
    },
  });

  if (!res.ok) {
    const t = await res.text();
    throw httpErr(res.status, `Thumbnail-Fehler (Dropbox ${res.status})`, 'DROPBOX_THUMB', t.slice(0, 300));
  }

  const response = new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type':                'image/jpeg',
      'Cache-Control':               'public, max-age=86400, immutable',
      'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin || '*' : 'null',
      'X-Content-Type-Options':      'nosniff',
      'Vary':                        'Origin',
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/* ═══════════════════════════════════════════════════════
   /api/download  –  Streaming (kein 302-Redirect!)
   Bilder werden NIE direkt an den Client weitergeleitet.
   URL ist damit nicht teilbar.
═══════════════════════════════════════════════════════ */
async function handleDownload(url, env, origin) {
  if (!hasAnyDropboxToken(env)) throw httpErr(500, 'Kein Dropbox-Token konfiguriert', 'NO_TOKEN');

  const path = url.searchParams.get('path');
  if (!path || !path.startsWith('/')) throw httpErr(400, 'Ungültiger Pfad', 'BAD_PATH');

  // Pfad-Schutz
  const root = (env.DROPBOX_FOLDER || '').replace(/\/+$/, '').toLowerCase();
  if (root && !path.toLowerCase().startsWith(root + '/') && path.toLowerCase() !== root) {
    throw httpErr(403, 'Pfad außerhalb des Galerie-Ordners', 'PATH_FORBIDDEN');
  }

  const token = await getDropboxToken(env);

  // Datei direkt streamen (kein temporärer Dropbox-Link der weitergegeben werden kann)
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  });

  if (!res.ok) {
    const t = await res.text();
    throw httpErr(res.status, `Download-Fehler (Dropbox ${res.status})`, 'DROPBOX_DOWNLOAD', t.slice(0, 300));
  }

  const filename   = path.split('/').pop() || 'download';
  const contentType = res.headers.get('Content-Type') || 'application/octet-stream';

  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type':                contentType,
      'Content-Disposition':         `attachment; filename="${encodeURIComponent(filename)}"`,
      'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin || '*' : 'null',
      'Cache-Control':               'no-store',
      'X-Content-Type-Options':      'nosniff',
      'Vary':                        'Origin',
    },
  });
}

/* ═══════════════════════════════════════════════════════
   DROPBOX HELPERS
═══════════════════════════════════════════════════════ */
async function listFolderRecursive(path, token) {
  const out     = [];
  const apiPath = path === '/' ? '' : path;
  let data = await dbx('https://api.dropboxapi.com/2/files/list_folder', token, {
    path: apiPath, recursive: false, include_media_info: true, limit: 2000,
  });
  out.push(...data.entries);
  while (data.has_more) {
    data = await dbx('https://api.dropboxapi.com/2/files/list_folder/continue', token, { cursor: data.cursor });
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
    const t = await res.text();
    throw httpErr(res.status, `Dropbox ${res.status}: ${shortDropboxError(t)}`, 'DROPBOX_API', t.slice(0, 300));
  }
  return res.json();
}

function shortDropboxError(text) {
  try {
    const j = JSON.parse(text);
    if (j.error_summary) return j.error_summary;
    if (j.error?.['.tag']) return j.error['.tag'];
  } catch { /* nope */ }
  return text.slice(0, 120);
}

/* ═══════════════════════════════════════════════════════
   UTILS
═══════════════════════════════════════════════════════ */
function corsHeaders(origin, env) {
  return {
    'Access-Control-Allow-Origin':  isAllowed(origin, env) ? (origin || '*') : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

function isAllowed(origin, env) {
  if (!origin) return true;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  return list.some(a => a === '*' || a === origin);
}

function json(obj, status, origin, env, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': isAllowed(origin, env) ? (origin || '*') : 'null',
      'Access-Control-Allow-Headers':'Content-Type, Authorization',
      'X-Content-Type-Options':      'nosniff',
      'X-Worker-Version':            VERSION,
      'Vary':                        'Origin',
      ...extraHeaders,
    },
  });
}

function httpErr(status, message, code, detail) {
  const e = new Error(message);
  e.status = status; e.code = code;
  if (detail) e.detail = detail;
  return e;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
