/**
 * Fotogalerie – Cloudflare Worker (Backend-Proxy zur Dropbox API)
 * ─────────────────────────────────────────────────────────────────
 * REST-API:
 *   GET  /api/health                          → Lebenszeichen
 *   GET  /api/diagnose                        → Konfigurations-Check
 *   POST /api/auth                            → Passwort prüfen
 *   GET  /api/photos                          → JSON-Liste aller Bilder
 *   GET  /api/thumb?path=...&size=w640h480    → Thumbnail (image/jpeg)
 *   GET  /api/download?path=...               → 302 zur Original-Datei
 *
 * Environment Variables / Secrets:
 *   Empfohlen (OAuth2 Refresh – Token läuft nie ab):
 *     DROPBOX_REFRESH_TOKEN  (Secret) – OAuth2 Refresh-Token
 *     DROPBOX_APP_KEY        (Secret) – App-Key aus Dropbox Developer Console
 *     DROPBOX_APP_SECRET     (Secret) – App-Secret aus Dropbox Developer Console
 *
 *   Alternativ (kurzlebig, läuft nach ~4h ab):
 *     DROPBOX_TOKEN          (Secret) – Kurzlebiger Access-Token
 *
 *   DROPBOX_FOLDER           (Var)    – z.B. /meine-fotos
 *   ALLOWED_ORIGINS          (Var)    – Komma-Liste oder leer = alle
 *   GALLERY_PASSWORD_HASH    (Var/Sec)– optional: SHA-256(SALT + ':' + Passwort)
 *
 * Passwort-Hash erzeugen (im Browser-Konsole oder Node):
 *   const SALT = 'bg-gallery-salt-v1';
 *   const enc  = new TextEncoder().encode(`${SALT}:${PASSWORT}`);
 *   const buf  = await crypto.subtle.digest('SHA-256', enc);
 *   const hex  = [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
 *   console.log(hex);
 */

const VERSION = 'galerie-api/2.1.0';

// Isolate-level token cache – bleibt für die Lebensdauer der Worker-Instanz erhalten
// (typisch 30 Sekunden bis wenige Minuten). Verhindert unnötige Token-Refresh-Anfragen.
let _tokenCache = { token: null, expiresAt: 0 };
const PASSWORD_SALT = 'bg-gallery-salt-v1';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff', 'bmp', 'heic', 'avif']);

const VALID_SIZES = new Set([
  'w32h32', 'w64h64', 'w128h128', 'w256h256',
  'w480h320', 'w640h480', 'w960h640', 'w1024h768', 'w2048h1536',
]);

const PUBLIC_PATHS = new Set(['/api/health', '/api/diagnose', '/api/auth']);

/* ═════════════════════════════════════════════════════════
   TOKEN – OAuth2 Refresh-Flow mit Isolate-Cache
═════════════════════════════════════════════════════════ */
async function getDropboxToken(env) {
  // Gecachten Token verwenden (mit 5-Minuten-Puffer vor Ablauf)
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 5 * 60 * 1000) {
    return _tokenCache.token;
  }

  // OAuth2 Refresh-Flow (empfohlen – Token läuft nie ab)
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
      const errText = await res.text();
      throw httpErr(500, `Token-Refresh fehlgeschlagen (${res.status})`, 'TOKEN_REFRESH_FAILED', errText.slice(0, 300));
    }
    const data = await res.json();
    if (!data.access_token) {
      throw httpErr(500, 'Token-Refresh: kein access_token in Antwort', 'TOKEN_REFRESH_FAILED');
    }
    // expires_in in Sekunden (Dropbox: 14400 = 4h)
    const ttl = (data.expires_in || 14400) * 1000;
    _tokenCache = { token: data.access_token, expiresAt: Date.now() + ttl };
    return data.access_token;
  }

  // Fallback: statischer Access-Token (kurzlebig)
  if (env.DROPBOX_TOKEN) return env.DROPBOX_TOKEN;

  throw httpErr(500,
    'Kein Dropbox-Token konfiguriert. Bitte DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET (oder DROPBOX_TOKEN) als Worker-Secrets setzen.',
    'NO_TOKEN',
  );
}

function hasAnyDropboxToken(env) {
  return !!(env.DROPBOX_REFRESH_TOKEN || env.DROPBOX_TOKEN);
}

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    try {
      // Auth-Gate (außer für PUBLIC_PATHS)
      if (!PUBLIC_PATHS.has(url.pathname) && !(await checkAuth(request, env))) {
        return json({
          error:   'Nicht autorisiert',
          code:    'AUTH_REQUIRED',
          detail:  'Bitte mit dem Galerie-Passwort anmelden.',
        }, 401, origin, env);
      }

      if (url.pathname === '/api/health')   return json({ status: 'ok', time: Date.now(), version: VERSION }, 200, origin, env);
      if (url.pathname === '/api/diagnose') return await handleDiagnose(env, origin);
      if (url.pathname === '/api/auth')     return await handleAuth(request, env, origin);
      if (url.pathname === '/api/photos')   return await handlePhotos(env, origin, ctx);
      if (url.pathname === '/api/thumb')    return await handleThumb(url, env, origin, ctx);
      if (url.pathname === '/api/download') return await handleDownload(url, env, origin);

      return json({ error: 'Not found', code: 'NOT_FOUND', path: url.pathname }, 404, origin, env);
    } catch (err) {
      console.error('[Worker]', url.pathname, err);
      return json({
        error:  err.message || 'Internal error',
        code:   err.code   || 'INTERNAL',
        path:   url.pathname,
        detail: err.detail || undefined,
      }, err.status || 500, origin, env);
    }
  },
};

/* ═════════════════════════════════════════════════════════
   AUTH
═════════════════════════════════════════════════════════ */
async function checkAuth(request, env) {
  const required = (env.GALLERY_PASSWORD_HASH || '').trim().toLowerCase();
  if (!required) return true; // Galerie ist offen

  // Authorization-Header (bevorzugt)
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (m && safeEqualHex(m[1].toLowerCase(), required)) return true;

  // Fallback: ?token=... in URL (für <img src> und Download-Links)
  const url = new URL(request.url);
  const t = (url.searchParams.get('token') || '').toLowerCase();
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

  // Akzeptiert entweder fertigen Hash oder Klartext-Passwort
  let hash = (payload?.hash || '').toLowerCase();
  if (!hash && payload?.password) {
    hash = await sha256Hex(`${PASSWORD_SALT}:${payload.password}`);
  }

  // Nur „check" Anfrage ohne Hash → 200 mit passwordRequired: true
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

/* ═════════════════════════════════════════════════════════
   DIAGNOSE
═════════════════════════════════════════════════════════ */
async function handleDiagnose(env, origin) {
  const useRefreshFlow = !!(env.DROPBOX_REFRESH_TOKEN && env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET);
  const out = {
    version:            VERSION,
    time:               new Date().toISOString(),
    tokenMode:          useRefreshFlow ? 'oauth2_refresh' : (env.DROPBOX_TOKEN ? 'static_token' : 'none'),
    hasRefreshToken:    !!env.DROPBOX_REFRESH_TOKEN,
    hasAppKey:          !!env.DROPBOX_APP_KEY,
    hasAppSecret:       !!env.DROPBOX_APP_SECRET,
    hasStaticToken:     !!env.DROPBOX_TOKEN,
    staticTokenLen:     env.DROPBOX_TOKEN ? env.DROPBOX_TOKEN.length : 0,
    folder:             env.DROPBOX_FOLDER || '(default: /)',
    allowedOrigins:     (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    passwordProtected:  !!(env.GALLERY_PASSWORD_HASH || '').trim(),
    requestOrigin:      origin || null,
    originAllowed:      isAllowed(origin, env),
    dropboxCheck:       null,
  };

  if (hasAnyDropboxToken(env)) {
    try {
      const token = await getDropboxToken(env);
      const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        out.dropboxCheck = {
          ok:      true,
          account: data?.email || data?.name?.display_name || 'unknown',
        };
      } else {
        const txt = await res.text();
        out.dropboxCheck = { ok: false, status: res.status, error: txt.slice(0, 300) };
      }
    } catch (e) {
      out.dropboxCheck = { ok: false, error: e.message };
    }
  } else {
    out.dropboxCheck = { ok: false, error: 'Kein Dropbox-Token konfiguriert' };
  }

  return json(out, 200, origin, env, { 'Cache-Control': 'no-store' });
}

/* ═════════════════════════════════════════════════════════
   /api/photos
═════════════════════════════════════════════════════════ */
async function handlePhotos(env, origin, ctx) {
  if (!hasAnyDropboxToken(env)) throw httpErr(500, 'Kein Dropbox-Token konfiguriert', 'NO_TOKEN');

  const folder = env.DROPBOX_FOLDER || '';

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

  const body = JSON.stringify({ photos, folder: folder || '/', count: photos.length });
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

/* ═════════════════════════════════════════════════════════
   /api/thumb
═════════════════════════════════════════════════════════ */
async function handleThumb(url, env, origin, ctx) {
  if (!hasAnyDropboxToken(env)) throw httpErr(500, 'Kein Dropbox-Token konfiguriert', 'NO_TOKEN');

  const path = url.searchParams.get('path');
  const size = url.searchParams.get('size') || 'w640h480';

  if (!path || !path.startsWith('/')) throw httpErr(400, 'Invalid path', 'BAD_PATH');
  if (!VALID_SIZES.has(size))         throw httpErr(400, `Invalid size: ${size}`, 'BAD_SIZE');

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
    const errText = await res.text();
    throw httpErr(res.status, `Thumbnail-Fehler (Dropbox ${res.status})`, 'DROPBOX_THUMB', errText.slice(0, 300));
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

/* ═════════════════════════════════════════════════════════
   /api/download
═════════════════════════════════════════════════════════ */
async function handleDownload(url, env, origin) {
  if (!hasAnyDropboxToken(env)) throw httpErr(500, 'Kein Dropbox-Token konfiguriert', 'NO_TOKEN');

  const path = url.searchParams.get('path');
  if (!path || !path.startsWith('/')) throw httpErr(400, 'Invalid path', 'BAD_PATH');

  const token = await getDropboxToken(env);
  const res = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ path }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw httpErr(res.status, `Download-Fehler (Dropbox ${res.status})`, 'DROPBOX_DOWNLOAD', errText.slice(0, 300));
  }

  const data = await res.json();
  return new Response(null, {
    status: 302,
    headers: {
      'Location':                    data.link,
      'Access-Control-Allow-Origin': isAllowed(origin, env) ? origin || '*' : 'null',
      'Cache-Control':               'no-store',
      'Vary':                        'Origin',
    },
  });
}

/* ═════════════════════════════════════════════════════════
   Dropbox-Helfer
═════════════════════════════════════════════════════════ */
async function listFolderRecursive(path, token) {
  const out = [];
  // Dropbox API: '/' bedeutet Root und ist nicht gültig - leerer String benutzen
  const apiPath = path === '/' ? '' : path;
  let data = await dbx('https://api.dropboxapi.com/2/files/list_folder', token, {
    path: apiPath, recursive: false, include_media_info: true, limit: 2000,
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
    throw httpErr(res.status, `Dropbox ${res.status}: ${shortDropboxError(errText)}`, 'DROPBOX_API', errText.slice(0, 300));
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

/* ═════════════════════════════════════════════════════════
   Utils
═════════════════════════════════════════════════════════ */
function corsHeaders(origin, env) {
  const allowed = isAllowed(origin, env);
  return {
    'Access-Control-Allow-Origin':  allowed ? (origin || '*') : 'null',
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
      'Vary':                        'Origin',
      'X-Worker-Version':            VERSION,
      ...extraHeaders,
    },
  });
}

function httpErr(status, message, code, detail) {
  const e = new Error(message);
  e.status = status;
  e.code   = code;
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
