/**
 * Data Hub — Supabase REST helpers
 * ======================================================================
 * Keys live in Script Properties (Extensions -> Apps Script -> Project
 * Settings -> Script Properties), set via Hub -> Connect to Supabase. They
 * are never written into the Sheet. Anyone with EDIT access to this Sheet can
 * open the script and read them, so only give edit access to people you'd
 * trust with the whole database.
 */

function newConn_() {
  const p = PropertiesService.getScriptProperties();
  const url = p.getProperty('SUPABASE_URL');
  const key = p.getProperty('SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('Not connected to Supabase yet — use Hub → Connect to Supabase.');
  return { url: url, key: key };
}

function oldConn_() {
  const p = PropertiesService.getScriptProperties();
  const url = p.getProperty('OLD_SUPABASE_URL');
  const key = p.getProperty('OLD_SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('Old project not set — the migration asks for it.');
  return { url: url, key: key };
}

function normalizeUrl_(u) {
  u = String(u || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(u)) {
    throw new Error('That doesn\'t look like a Supabase project URL (https://xxxx.supabase.co).');
  }
  return u;
}

/**
 * opts: { method, body, profile (schema), prefer, query, headers, raw }
 * Returns parsed JSON (or the HTTPResponse when raw = true).
 */
function sbRequest_(conn, path, opts) {
  opts = opts || {};
  const method = (opts.method || 'get').toLowerCase();
  const headers = { apikey: conn.key };
  // Legacy service_role keys are JWTs and go in Authorization too; the newer
  // sb_secret_ keys only go in apikey.
  if (/^eyJ/.test(conn.key)) headers.Authorization = 'Bearer ' + conn.key;
  if (opts.profile) {
    headers[method === 'get' || method === 'head' ? 'Accept-Profile' : 'Content-Profile'] = opts.profile;
  }
  if (opts.prefer) headers.Prefer = opts.prefer;
  Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });

  const req = { method: method, headers: headers, muteHttpExceptions: true };
  if (opts.body !== undefined) {
    req.contentType = 'application/json';
    req.payload = JSON.stringify(opts.body);
  }
  const resp = UrlFetchApp.fetch(conn.url + path, req);
  const code = resp.getResponseCode();
  if (opts.raw) return resp;
  const text = resp.getContentText();
  if (code < 200 || code >= 300) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.message || j.error || text; if (j.hint) msg += ' (' + j.hint + ')'; } catch (e) {}
    const err = new Error('Supabase ' + code + ' on ' + path.split('?')[0] + ': ' + msg);
    err.status = code;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/** Call a function in the public schema (the sheet_sync_* helpers). */
function sbRpc_(conn, fn, args) {
  return sbRequest_(conn, '/rest/v1/rpc/' + fn, { method: 'post', body: args || {} });
}

/** Exact row count of a table (null if the table doesn't exist). */
function sbCount_(conn, schema, table) {
  const resp = sbRequest_(conn, '/rest/v1/' + encodeURIComponent(table) + '?select=*', {
    method: 'get', profile: schema, prefer: 'count=exact', headers: { Range: '0-0' }, raw: true,
  });
  const code = resp.getResponseCode();
  if (code === 404) return null;
  if (code >= 300 && code !== 416) throw new Error('Count failed for ' + schema + '.' + table + ': ' + resp.getContentText());
  const cr = resp.getHeaders()['Content-Range'] || resp.getHeaders()['content-range'] || '';
  const total = String(cr).split('/')[1];
  return total === undefined || total === '*' ? 0 : Number(total);
}

/** Column list / types / primary key for every table in a schema (cached). */
function getSchema_(conn, schema, forceRefresh) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'schema:' + schema;
  if (!forceRefresh) {
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }
  const list = sbRpc_(conn, 'sheet_sync_schema', { p_schema: schema }) || [];
  const byTable = {};
  list.forEach(function (t) { byTable[t.table] = t; });
  try { cache.put(cacheKey, JSON.stringify(byTable), 6 * 60 * 60); } catch (e) { /* >100KB: just don't cache */ }
  return byTable;
}
