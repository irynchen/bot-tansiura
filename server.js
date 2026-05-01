const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_KEY        = process.env.ANTHROPIC_API_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_URL        = 'https://nalog.goeloria.com';
const PORT = 3000;

const FAQ_PATH    = path.join(__dirname, 'faq.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATS_PATH  = path.join(__dirname, 'stats.json');
const DB_PATH     = path.join(__dirname, 'bot.db');

// ── SQLite setup ──────────────────────────────────────────────────────────────

let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id     INTEGER PRIMARY KEY,
      username    TEXT,
      first_name  TEXT,
      last_name   TEXT,
      first_seen  TEXT NOT NULL,
      last_seen   TEXT NOT NULL,
      msg_count   INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     INTEGER NOT NULL,
      text        TEXT,
      answered_by TEXT DEFAULT 'faq',
      answer      TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  `);
  try { db.prepare('ALTER TABLE messages ADD COLUMN answer TEXT').run(); } catch {}
  console.log('SQLite инициализирована:', DB_PATH);
} catch (e) {
  console.warn('better-sqlite3 не установлен — логирование пользователей отключено. Установите: npm install better-sqlite3');
  db = null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function dbUpsertUser(chatId, username, firstName, lastName) {
  if (!db) return;
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO users (chat_id, username, first_name, last_name, first_seen, last_seen, msg_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(chat_id) DO UPDATE SET
        username   = excluded.username,
        first_name = excluded.first_name,
        last_name  = excluded.last_name,
        last_seen  = excluded.last_seen,
        msg_count  = msg_count + 1
    `).run(chatId, username || null, firstName || null, lastName || null, now, now);
  } catch(e) { console.error('[DB] upsert error:', e.message); }
}

function dbLogMessage(chatId, text, answeredBy, answer) {
  if (!db) return;
  const clean = answer ? answer.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
  db.prepare(`INSERT INTO messages (chat_id, text, answered_by, answer, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(chatId, text || '', answeredBy || 'faq', clean || null, new Date().toISOString());
}

function dbGetUsers({ limit = 50, offset = 0, search = '' } = {}) {
  if (!db) return { users: [], total: 0 };
  const like = `%${search}%`;
  const where = search
    ? `WHERE username LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR CAST(chat_id AS TEXT) LIKE ?`
    : '';
  const params = search ? [like, like, like, like] : [];
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM users ${where}`).get(...params).cnt;
  const users = db.prepare(`
    SELECT chat_id, username, first_name, last_name, first_seen, last_seen, msg_count
    FROM users ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { users, total };
}

function dbGetUserMessages(chatId, limit = 50) {
  if (!db) return [];
  return db.prepare(`
    SELECT text, answered_by, answer, created_at FROM messages
    WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(chatId, limit);
}

function dbGetUserStats() {
  if (!db) return { total: 0, active_today: 0, active_week: 0, new_today: 0 };
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const week  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    total:        db.prepare(`SELECT COUNT(*) as n FROM users`).get().n,
    active_today: db.prepare(`SELECT COUNT(*) as n FROM users WHERE last_seen >= ?`).get(today).n,
    active_week:  db.prepare(`SELECT COUNT(*) as n FROM users WHERE last_seen >= ?`).get(week).n,
    new_today:    db.prepare(`SELECT COUNT(*) as n FROM users WHERE first_seen >= ?`).get(today).n,
  };
}

function dbGetAiLog({ limit = 20, offset = 0, search = '' } = {}) {
  if (!db) return { items: [], total: 0 };
  const like = `%${search}%`;
  const where = search
    ? `WHERE m.answered_by = 'ai' AND (m.text LIKE ? OR m.answer LIKE ?)`
    : `WHERE m.answered_by = 'ai'`;
  const params = search ? [like, like] : [];
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM messages m ${where}`).get(...params).cnt;
  const items = db.prepare(`
    SELECT m.id, m.chat_id, m.text, m.answer, m.created_at,
           u.first_name, u.last_name, u.username
    FROM messages m LEFT JOIN users u ON u.chat_id = m.chat_id
    ${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { items, total };
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.ico': 'image/x-icon', '.css': 'text/css',
  '.js': 'application/javascript', '.json': 'application/json',
};

// Token prices per million tokens (USD)
const TOKEN_PRICES = {
  'claude-opus-4-7':           { in: 15.00, out: 75.00 },
  'claude-sonnet-4-6':         { in:  3.00, out: 15.00 },
  'claude-haiku-4-5-20251001': { in:  0.80, out:  4.00 },
};

// ── FAQ helpers ───────────────────────────────────────────────────────────────

function loadFaq() {
  try { return JSON.parse(fs.readFileSync(FAQ_PATH, 'utf8')); }
  catch { return { ru: [] }; }
}

function saveFaq(data) {
  fs.writeFileSync(FAQ_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ── Config helpers (cached) ───────────────────────────────────────────────────

let _configCache = null;

function loadConfig() {
  if (!_configCache) {
    try { _configCache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
    catch { _configCache = {}; }
  }
  return _configCache;
}

function reloadConfig() {
  _configCache = null;
  return loadConfig();
}

function saveConfig(data) {
  _configCache = data;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')); }
  catch {
    return { total: 0, faq: 0, ai: 0, topics: {},
             tokens: { client: { in: 0, out: 0, model: '' }, admin: { in: 0, out: 0, model: '' } } };
  }
}

function saveStats(data) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function recordTokens(keyType, model, inputTokens, outputTokens) {
  const s = loadStats();
  const bucket = s.tokens[keyType] || (s.tokens[keyType] = { in: 0, out: 0 });
  bucket.in  += inputTokens  || 0;
  bucket.out += outputTokens || 0;
  bucket.model = model || bucket.model;
  saveStats(s);
}

// ── Key encryption (AES-256-CBC) ──────────────────────────────────────────────

const CIPHER_ALGO = 'aes-256-cbc';

function encryptValue(plaintext) {
  if (!ADMIN_PASSWORD || !plaintext) return plaintext;
  const salt = crypto.randomBytes(16);
  const key  = crypto.scryptSync(ADMIN_PASSWORD, salt, 32);
  const iv   = crypto.randomBytes(16);
  const c    = crypto.createCipheriv(CIPHER_ALGO, key, iv);
  const enc  = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return 'enc:' + salt.toString('hex') + ':' + iv.toString('hex') + ':' + enc.toString('hex');
}

function decryptValue(stored) {
  if (!stored || !stored.startsWith('enc:')) return stored;
  if (!ADMIN_PASSWORD) return '';
  try {
    const [saltHex, ivHex, encHex] = stored.slice(4).split(':');
    const key = crypto.scryptSync(ADMIN_PASSWORD, Buffer.from(saltHex, 'hex'), 32);
    const d   = crypto.createDecipheriv(CIPHER_ALGO, key, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
  } catch { return ''; }
}

function maskValue(stored) {
  if (!stored) return null;
  const plain = decryptValue(stored);
  if (!plain) return '●●●●●●●●';
  return plain.slice(0, 12) + '●'.repeat(6);
}

function getApiKey(type) {
  const cfg = loadConfig();
  const field    = type === 'admin' ? 'apiKeyAdmin' : 'apiKeyClient';
  const fallback = type === 'admin' ? cfg.apiKeyClient : null;
  for (const stored of [cfg[field], fallback]) {
    if (stored) { const k = decryptValue(stored); if (k) return k; }
  }
  return API_KEY;
}

function getModel(type) {
  const cfg = loadConfig();
  return (type === 'admin' ? cfg.modelAdmin : cfg.modelClient) || 'claude-sonnet-4-6';
}

// ── Auth ──────────────────────────────────────────────────────────────────────

const sessions = new Set();
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function isAuthenticated(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') && sessions.has(auth.slice(7));
}

// ── Request / response helpers ────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  try { return JSON.parse(raw); } catch { return {}; }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = STATIC_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'Content-Type': contentType };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ── Claude proxy (tracks token usage) ────────────────────────────────────────

function proxyToClaude(res, bodyStr, apiKey, keyType, model) {
  const req2 = https.request({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      // Track token usage silently
      try {
        const parsed = JSON.parse(data);
        if (parsed.usage) recordTokens(keyType, model, parsed.usage.input_tokens, parsed.usage.output_tokens);
      } catch {}
      res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });
  req2.on('error', err => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
  req2.write(bodyStr);
  req2.end();
}

// ── Normalize FAQ entry (supports old + new menuItems format) ─────────────────

function normalizeEntry(body, id) {
  return {
    id,
    topic:     body.topic     || '',
    keys:      body.keys      || [],
    answer:    body.answer    || '',
    menuItems: body.menuItems || [],
  };
}

// ── Server ────────────────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => console.error('[CRASH] unhandledRejection:', reason));
process.on('uncaughtException',  (err)    => console.error('[CRASH] uncaughtException:', err));

const bizOwners = new Map(); // business_connection_id → owner Telegram user_id

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // ── Client chat (uses client key) ─────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/chat') {
    const rawBody = await readRawBody(req);
    let bodyObj; try { bodyObj = JSON.parse(rawBody); } catch { bodyObj = {}; }
    const model = bodyObj.model || getModel('client');
    bodyObj.model = model;
    proxyToClaude(res, JSON.stringify(bodyObj), getApiKey('client'), 'client', model);
    return;
  }

  // ── Admin chat (uses admin key, protected) ────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/admin/chat') {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    const rawBody = await readRawBody(req);
    let bodyObj; try { bodyObj = JSON.parse(rawBody); } catch { bodyObj = {}; }
    const model = bodyObj.model || getModel('admin');
    bodyObj.model = model;
    proxyToClaude(res, JSON.stringify(bodyObj), getApiKey('admin'), 'admin', model);
    return;
  }

  // ── Stats (client posts faq/ai events) ───────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/stats') {
    const body = await readJsonBody(req);
    const s = loadStats();
    s.total++;
    if (body.type === 'faq') s.faq++;
    else if (body.type === 'ai') s.ai++;
    if (body.topic) s.topics[body.topic] = (s.topics[body.topic] || 0) + 1;
    saveStats(s);
    if (body.tgUser?.id) {
      dbUpsertUser(body.tgUser.id, body.tgUser.username, body.tgUser.first_name, body.tgUser.last_name);
      dbLogMessage(body.tgUser.id, body.text || body.topic || '', body.type || 'faq', body.answer || null);
    }
    json(res, 200, { ok: true });
    return;
  }

  // ── Admin: get stats ─────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/admin/stats') {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    const s = loadStats();
    // Compute cost estimates
    const costs = {};
    for (const [kt, bucket] of Object.entries(s.tokens || {})) {
      const prices = TOKEN_PRICES[bucket.model] || TOKEN_PRICES['claude-sonnet-4-6'];
      costs[kt] = ((bucket.in / 1e6) * prices.in + (bucket.out / 1e6) * prices.out).toFixed(4);
    }
    json(res, 200, { ...s, costs });
    return;
  }

  // ── Admin: reset stats ───────────────────────────────────────────────────
  if (req.method === 'DELETE' && urlPath === '/api/admin/stats') {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    const fresh = { total: 0, faq: 0, ai: 0, topics: {},
                    tokens: { client: { in: 0, out: 0, model: '' }, admin: { in: 0, out: 0, model: '' } } };
    saveStats(fresh);
    json(res, 200, { ...fresh, costs: { client: '0.0000', admin: '0.0000' } });
    return;
  }

  // ── Config (public read — no keys) ────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/config') {
    const cfg = { ...loadConfig() };
    delete cfg.apiKeyClient; delete cfg.apiKeyAdmin;
    json(res, 200, cfg);
    return;
  }

  // ── Config (admin read — masked keys) ─────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/admin/config') {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    const cfg = { ...loadConfig() };
    cfg.apiKeyClientMasked = maskValue(cfg.apiKeyClient) || null;
    cfg.apiKeyAdminMasked  = maskValue(cfg.apiKeyAdmin)  || null;
    delete cfg.apiKeyClient; delete cfg.apiKeyAdmin;
    json(res, 200, cfg);
    return;
  }

  // ── Config (admin write) ───────────────────────────────────────────────────
  if (req.method === 'PUT' && urlPath === '/api/admin/config') {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    const body = await readJsonBody(req);
    const current = loadConfig();
    const isMasked = v => !v || v.includes('●') || v.startsWith('enc:');
    body.apiKeyClient = isMasked(body.apiKeyClient) ? (current.apiKeyClient || '') : encryptValue(body.apiKeyClient.trim());
    body.apiKeyAdmin  = isMasked(body.apiKeyAdmin)  ? (current.apiKeyAdmin  || '') : encryptValue(body.apiKeyAdmin.trim());
    saveConfig(body);
    const resp = { ...body };
    resp.apiKeyClientMasked = maskValue(resp.apiKeyClient) || null;
    resp.apiKeyAdminMasked  = maskValue(resp.apiKeyAdmin)  || null;
    delete resp.apiKeyClient; delete resp.apiKeyAdmin;
    json(res, 200, resp);
    return;
  }

  // ── FAQ (public read) ──────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/faq') {
    json(res, 200, loadFaq());
    return;
  }

  // ── Admin login ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/admin/login') {
    if (!ADMIN_PASSWORD) { json(res, 503, { error: 'ADMIN_PASSWORD nicht gesetzt' }); return; }
    const body = await readJsonBody(req);
    if (body.password !== ADMIN_PASSWORD) { json(res, 401, { error: 'Falsches Passwort' }); return; }
    const token = generateToken();
    sessions.add(token);
    json(res, 200, { token });
    return;
  }

  // ── Admin FAQ routes (protected) ───────────────────────────────────────────
  if (urlPath.startsWith('/api/admin/faq')) {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }

    const parts = urlPath.split('/');
    const lang = parts[4];
    const id   = parts[5] ? parseInt(parts[5]) : null;

    if (lang !== 'ru') { json(res, 400, { error: 'Ungültige Sprache' }); return; }

    if (req.method === 'POST' && id === null) {
      const body = await readJsonBody(req);
      const faq  = loadFaq();
      const maxId = Math.max(0, ...(faq.ru || []).map(e => e.id));
      const entry = normalizeEntry(body, maxId + 1);
      faq.ru = [...(faq.ru || []), entry];
      saveFaq(faq);
      json(res, 201, entry);
      return;
    }

    if (req.method === 'PUT' && id !== null) {
      const body = await readJsonBody(req);
      const faq  = loadFaq();
      const idx  = (faq.ru || []).findIndex(e => e.id === id);
      if (idx === -1) { json(res, 404, { error: 'Nicht gefunden' }); return; }
      faq.ru[idx] = normalizeEntry(body, id);
      saveFaq(faq);
      json(res, 200, faq.ru[idx]);
      return;
    }

    if (req.method === 'DELETE' && id !== null) {
      const faq    = loadFaq();
      const before = (faq.ru || []).length;
      faq.ru = (faq.ru || []).filter(e => e.id !== id);
      if (faq.ru.length === before) { json(res, 404, { error: 'Nicht gefunden' }); return; }
      saveFaq(faq);
      json(res, 200, { ok: true });
      return;
    }

    json(res, 405, { error: 'Methode nicht erlaubt' });
    return;
  }

  // ── Telegram webhook ──────────────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/telegram/webhook') {
    const body = await readJsonBody(req);
    res.writeHead(200); res.end('ok');
    const _msg0 = body.message || body.business_message;
    console.log('[TG] update:', Object.keys(body).join(','), '| from:', _msg0?.from?.id, '| connId:', _msg0?.business_connection_id || 'none', '| text:', JSON.stringify((_msg0?.text||'').slice(0,40)));

    // Store business connection owner IDs (connection_id → owner user_id)
    if (body.business_connection?.id && body.business_connection?.user?.id) {
      bizOwners.set(body.business_connection.id, body.business_connection.user.id);
    }

    const msg       = body.message || body.business_message;
    const bizConnId = body.business_message?.business_connection_id || null;
    if (!msg?.chat?.id) return;
    const chatId = msg.chat.id;
    const text   = (msg.text || '').trim();
    if (!text) return;

    // Skip messages sent BY the business account owner (Alexander's own messages)
    if (bizConnId && msg.from?.id) {
      let ownerId = bizOwners.get(bizConnId);
      if (!ownerId) {
        // Fetch connection info if not cached
        try {
          const connData = JSON.stringify({ business_connection_id: bizConnId });
          const connRes = await new Promise((resolve, reject) => {
            const r = https.request({ hostname:'api.telegram.org', path:`/bot${TG_TOKEN}/getBusinessConnection`, method:'POST',
              headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(connData)} }, rs => {
              let d=''; rs.on('data',c=>d+=c); rs.on('end',()=>resolve(JSON.parse(d)));
            });
            r.on('error', reject); r.write(connData); r.end();
          });
          if (connRes.result?.user?.id) {
            bizOwners.set(bizConnId, connRes.result.user.id);
            ownerId = connRes.result.user.id;
          }
        } catch {}
      }
      if (ownerId && msg.from.id === ownerId) return;
    }

    dbUpsertUser(chatId, msg.chat.username, msg.chat.first_name, msg.chat.last_name);

    if (!TG_TOKEN) return;

    const tg = (method, payload) => new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const r = https.request({ hostname:'api.telegram.org', path:`/bot${TG_TOKEN}/${method}`, method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)} }, rs => {
        let d=''; rs.on('data',c=>d+=c); rs.on('end',()=>resolve(JSON.parse(d)));
      });
      r.on('error', reject); r.write(data); r.end();
    });

    const bizExtra = bizConnId ? { business_connection_id: bizConnId } : {};

    // FAQ search
    const faqList = (loadFaq().ru || []);
    const lower = text.toLowerCase();

    const greetings = ['привет', 'здравствуй', 'добрый', 'hallo', 'hello', 'hi', 'хай', 'салют', 'buenos'];
    const isGreeting = text === '/start' || greetings.some(g => lower.startsWith(g));

    // Business context: strip greeting prefix, keep the question part if any
    let queryText = text;
    if (isGreeting && bizConnId) {
      if (text === '/start') return;
      const matched = greetings.find(g => lower.startsWith(g));
      const rest = matched ? text.slice(matched.length).replace(/^[\s,!.?]+/, '').trim() : '';
      if (!rest) return; // pure greeting — Alexander replies personally
      queryText = rest;
    }
    const queryLower = queryText.toLowerCase();

    if (isGreeting) {
      await tg('sendMessage', { chat_id: chatId,
        text: '👋 Привет! Я помощник налогового консультанта Александра Танцюры из Аликанте. Рад помочь разобраться в испанских налогах и финансовых вопросах. Задавайте ваш вопрос — постараюсь объяснить всё просто и понятно!\n\nМожете задать вопрос прямо здесь или выбрать тему ниже 👇',
        reply_markup: {
          keyboard: [
            [{ text: 'Как зарегистрироваться как autónomo?' }],
            [{ text: 'Какие налоги платит фрилансер?' }],
            [{ text: 'Что такое декларация Renta?' }],
            [{ text: '🌐 Открыть бота', web_app: { url: BOT_URL } }]
          ],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
      dbLogMessage(chatId, text, 'greeting', '👋 Привет! Я помощник налогового консультанта Александра Танцюры из Аликанте. Рад помочь разобраться в испанских налогах и финансовых вопросах. Задавайте ваш вопрос — постараюсь объяснить всё просто и понятно!');
      return;
    }
    let best = null, bestScore = 0;
    for (const item of faqList) {
      const score = (item.keys || []).filter(k => queryLower.includes(k.toLowerCase())).length;
      if (score > bestScore) { bestScore = score; best = item; }
    }
    if (best) {
      const plain = best.answer
        .replace(/<br\s*\/?>/gi, '\n').replace(/<strong>(.*?)<\/strong>/gi, '*$1*')
        .replace(/<span[^>]*>(.*?)<\/span>/gi, '$1').replace(/<[^>]+>/g, '').trim();
      const faqMarkup = bizConnId ? undefined
        : { inline_keyboard: [[{ text: '🌐 Открыть бота', web_app: { url: BOT_URL } }]] };
      await tg('sendMessage', { ...bizExtra, chat_id: chatId, text: plain + '\n\n✅ Проверено Александром', parse_mode: 'Markdown',
        ...(faqMarkup ? { reply_markup: faqMarkup } : {})
      });
      const sf = loadStats(); sf.total++; sf.faq++;
      if (best.title) sf.topics[best.title] = (sf.topics[best.title] || 0) + 1;
      saveStats(sf);
      dbLogMessage(chatId, text, 'faq', plain);
      return;
    }

    // AI fallback
    const apiKey = getApiKey('client');
    if (!apiKey) {
      if (!bizConnId) await tg('sendMessage', { chat_id: chatId, text: 'Бот временно недоступен. Обратитесь напрямую: @AlexanderTantsiura' });
      return;
    }
    await tg('sendChatAction', { ...bizExtra, chat_id: chatId, action: 'typing' });
    const sysPrompt = 'Ты помощник налогового консультанта Александра Танцюры (Аликанте, Испания). Отвечай по-русски, тепло и понятно, максимум 4 предложения. Испанские термины объясняй в скобках. Не придумывай цифры — говори, что цифры лучше уточнить индивидуально. НЕ используй Markdown-символы (* # _ `). Не предлагай сразу писать лично — сначала помоги с вопросом. Если вопрос явно не связан с налогами, финансами или бухгалтерией — ответь строго одним словом: [SKIP]';
    const aiBody = JSON.stringify({ model: getModel('client'), max_tokens: 600, system: sysPrompt, messages: [{ role:'user', content: queryText }] });
    const aiRes  = await new Promise((resolve, reject) => {
      const r = https.request({ hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(aiBody)} }, rs => {
        let d=''; rs.on('data',c=>d+=c); rs.on('end',()=>resolve(JSON.parse(d)));
      });
      r.on('error', reject); r.write(aiBody); r.end();
    });
    const reply = aiRes.content?.[0]?.text || '';
    if (aiRes.usage) recordTokens('client', getModel('client'), aiRes.usage.input_tokens, aiRes.usage.output_tokens);
    console.log('[TG] AI reply:', JSON.stringify(reply.slice(0, 80)), '| biz:', !!bizConnId);
    if (!reply || /^\[?SKIP\]?$/i.test(reply.trim())) { console.log('[TG] SKIP — kein Senden'); return; }
    const aiMarkup = bizConnId ? undefined
      : { inline_keyboard: [[{ text: '🌐 Открыть бота', web_app: { url: BOT_URL } }]] };
    const sendRes = await tg('sendMessage', { ...bizExtra, chat_id: chatId, text: reply + '\n\n💬 Авто-ответ',
      ...(aiMarkup ? { reply_markup: aiMarkup } : {})
    });
    console.log('[TG] sendMessage ok:', sendRes?.ok, sendRes?.description);
    const sa = loadStats(); sa.total++; sa.ai++; saveStats(sa);
    dbLogMessage(chatId, text, 'ai', reply);
    return;
  }

  // ── Admin: user stats summary ─────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/admin/user-stats') {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    json(res, 200, dbGetUserStats());
    return;
  }

  // ── Admin: users list ─────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/admin/users') {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    const qs     = new URLSearchParams(req.url.split('?')[1] || '');
    const limit  = Math.min(parseInt(qs.get('limit')  || '50'), 200);
    const offset = parseInt(qs.get('offset') || '0');
    const search = qs.get('search') || '';
    json(res, 200, dbGetUsers({ limit, offset, search }));
    return;
  }

  // ── Admin: messages for one user ──────────────────────────────────────────
  if (req.method === 'GET' && urlPath.startsWith('/api/admin/users/') && urlPath.endsWith('/messages')) {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    const chatId = parseInt(urlPath.split('/')[4]);
    json(res, 200, dbGetUserMessages(chatId, 50));
    return;
  }

  // ── Admin: AI log ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/admin/ai-log') {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    const qs     = new URLSearchParams(req.url.split('?')[1] || '');
    const limit  = Math.min(parseInt(qs.get('limit')  || '20'), 100);
    const offset = parseInt(qs.get('offset') || '0');
    const search = qs.get('search') || '';
    json(res, 200, dbGetAiLog({ limit, offset, search }));
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (urlPath === '/' || urlPath === '/index.html') { serveFile(res, path.join(__dirname, 'index.html')); return; }
    if (urlPath === '/admin' || urlPath === '/admin.html') { serveFile(res, path.join(__dirname, 'admin.html')); return; }
    const filePath = path.resolve(__dirname, urlPath.slice(1));
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
    serveFile(res, filePath);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── Startup ────────────────────────────────────────────────────────────────────

const _startCfg = loadConfig();
if (!API_KEY && !_startCfg.apiKeyClient && !_startCfg.apiKeyAdmin) {
  console.warn('HINWEIS: Kein API-Key gesetzt. Bitte im Admin-Panel hinterlegen.');
} else if (!API_KEY) {
  console.log('API-Key wird aus der Konfiguration geladen.');
}
if (!ADMIN_PASSWORD) {
  console.warn('HINWEIS: ADMIN_PASSWORD fehlt — Admin-Panel deaktiviert.');
}

server.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
  if (ADMIN_PASSWORD) console.log(`Admin-Panel: http://localhost:${PORT}/admin`);
  if (TG_TOKEN) {
    const webhookUrl = `${BOT_URL}/api/telegram/webhook`;
    const tgCall = (method, payload) => new Promise((resolve, reject) => {
      const data = payload ? JSON.stringify(payload) : null;
      const opts = { hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/${method}`, method: data ? 'POST' : 'GET',
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} };
      const r = https.request(opts, rs => { let d=''; rs.on('data',c=>d+=c); rs.on('end',()=>resolve(JSON.parse(d))); });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
    tgCall('deleteWebhook', { drop_pending_updates: false })
      .then(() => tgCall('setWebhook', {
        url: webhookUrl,
        allowed_updates: ['message', 'business_message', 'business_connection', 'edited_business_message']
      }))
      .then(r => console.log('[TG] Webhook gesetzt:', r.description, '| allowed:', r.ok))
      .then(() => tgCall('getWebhookInfo'))
      .then(r => console.log('[TG] Webhook-Info: url=', r.result?.url, 'allowed=', JSON.stringify(r.result?.allowed_updates)))
      .catch(e => console.error('[TG] Webhook-Fehler:', e.message));
  }
});
