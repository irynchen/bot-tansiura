const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch(e) {}

const API_KEY        = process.env.ANTHROPIC_API_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_URL        = 'https://nalog.goeloria.com';
const PORT = 3000;

const CLIENT_SYSTEM_PROMPT = `Ты помощник налогового консультанта Александра Танцюры (Аликанте, Испания). Отвечай по-русски, тепло и понятно, максимум 4 предложения. Испанские термины объясняй в скобках. Не придумывай цифры — говори, что цифры лучше уточнить индивидуально. НЕ используй Markdown-символы (* # _ \`). Не предлагай сразу писать лично — сначала помоги с вопросом.

Александр НЕ занимается следующими темами. Если вопрос касается их — вежливо объясни это и порекомендуй другого специалиста, не отвечай по существу:
- ВНЖ, вид на жительство, миграция, оформление резидентства → специалист по иммиграционному праву (abogado de extranjería)
- Пенсии, трудовые отношения, увольнения, трудовой договор (laboral) → специалист по трудовому праву (asesor laboral)
- Юридические вопросы, суды, иски, защита прав → адвокат (abogado)

Если вопрос не связан ни с налогами/финансами/бухгалтерией, ни с перечисленными исключениями — ответь строго одним словом: [SKIP]`;

// Multi-user support: ADMIN_USERS env var as JSON, e.g. {"admin":"pw","ishev":"festival"}
// Falls back to single ADMIN_PASSWORD (username "admin") if not set.
let ADMIN_USERS = null;
try { if (process.env.ADMIN_USERS) ADMIN_USERS = JSON.parse(process.env.ADMIN_USERS); } catch(e) {}

const FAQ_PATH    = path.join(__dirname, 'faq.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATS_PATH  = path.join(__dirname, 'stats.json');
const USERS_PATH  = path.join(__dirname, 'portal_users.json');

const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours
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
      msg_count   INTEGER DEFAULT 0,
      excluded    INTEGER DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS session_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL,
      login_at   TEXT NOT NULL,
      logout_at  TEXT,
      ip         TEXT
    );
  `);
  try { db.prepare('ALTER TABLE messages ADD COLUMN answer TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE users ADD COLUMN excluded INTEGER DEFAULT 0').run(); } catch {}
  // Close any sessions that were open before this restart
  try { db.prepare("UPDATE session_history SET logout_at = '[restart] ' || ? WHERE logout_at IS NULL").run(new Date().toISOString()); } catch {}
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
    SELECT chat_id, username, first_name, last_name, first_seen, last_seen, msg_count, excluded
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

// ── Session history helpers ────────────────────────────────────────────────────

let _sessionDbIds = new Map(); // token → db row id

function dbSessionStart(username, token, ip) {
  if (!db) return;
  try {
    const info = db.prepare('INSERT INTO session_history (username, login_at, ip) VALUES (?, ?, ?)')
      .run(username, new Date().toISOString(), ip || null);
    _sessionDbIds.set(token, info.lastInsertRowid);
  } catch(e) {}
}

function dbSessionEnd(token) {
  if (!db) return;
  const rowId = _sessionDbIds.get(token);
  if (rowId) {
    try { db.prepare('UPDATE session_history SET logout_at = ? WHERE id = ?').run(new Date().toISOString(), rowId); } catch(e) {}
    _sessionDbIds.delete(token);
  }
}

function dbGetSessionHistory(limit = 100) {
  if (!db) return [];
  try { return db.prepare('SELECT id, username, login_at, logout_at, ip FROM session_history ORDER BY id DESC LIMIT ?').all(limit); }
  catch(e) { return []; }
}

// ── Portal user management ─────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    return crypto.scryptSync(password, salt, 64).toString('hex') === hash;
  } catch { return false; }
}

function loadPortalUsers() {
  try {
    if (fs.existsSync(USERS_PATH)) return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  } catch(e) {}
  // Bootstrap from env vars
  const users = [];
  if (ADMIN_USERS) {
    for (const [username, password] of Object.entries(ADMIN_USERS)) {
      users.push({ username, passwordHash: hashPassword(password), email: '', role: username === 'ishev' ? 'superadmin' : 'admin' });
    }
  } else if (ADMIN_PASSWORD) {
    users.push({ username: 'admin', passwordHash: hashPassword(ADMIN_PASSWORD), email: '', role: 'admin' });
  }
  if (users.length) fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), 'utf8');
  return users;
}

function savePortalUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), 'utf8');
}

function genTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({length: 10}, () => chars[crypto.randomInt(chars.length)]).join('');
}

async function sendMail(to, subject, text) {
  if (!nodemailer) throw new Error('nodemailer nicht installiert');
  const cfg = loadConfig();
  const smtp = cfg.smtp || {};
  if (!smtp.host || !smtp.user || !smtp.pass) throw new Error('SMTP nicht konfiguriert');
  const transporter = nodemailer.createTransport({
    host: smtp.host, port: smtp.port || 587,
    secure: (smtp.port || 587) === 465,
    auth: { user: smtp.user, pass: smtp.pass }
  });
  await transporter.sendMail({ from: smtp.from || smtp.user, to, subject, text });
}

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

// token → { username, role, expiresAt }
const sessions = new Map();

// userId → { options:[{id,topic}], query, expiresAt } — pending FAQ clarification
const pendingClarifications = new Map();
const conversationHistories = new Map();
const CONV_TTL = 30 * 60 * 1000;
const CONV_MAX = 6; // 3 user + 3 assistant messages
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingClarifications)  if (v.expiresAt < now) pendingClarifications.delete(k);
  for (const [k, v] of conversationHistories) if (v.expiresAt < now) conversationHistories.delete(k);
}, 60 * 1000);

function getConvHistory(chatId) {
  const h = conversationHistories.get(chatId);
  return (h && Date.now() < h.expiresAt) ? [...h.messages] : [];
}

function recordConvTurn(chatId, userText, assistantText) {
  const msgs = getConvHistory(chatId);
  msgs.push({ role: 'user', content: userText });
  msgs.push({ role: 'assistant', content: assistantText });
  conversationHistories.set(chatId, { messages: msgs.slice(-CONV_MAX), expiresAt: Date.now() + CONV_TTL });
}

function generateToken() { return crypto.randomBytes(32).toString('hex'); }

function getToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function getSession(req) {
  const token = getToken(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); dbSessionEnd(token); return null; }
  return s;
}

function isAuthenticated(req) { return !!getSession(req); }
function isSuperAdmin(req) { const s = getSession(req); return s && s.role === 'superadmin'; }

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

function normalizeEntry(body, id, username) {
  return {
    id,
    topic:     body.topic     || '',
    keys:      body.keys      || [],
    answer:    body.answer    || '',
    menuItems: body.menuItems || [],
    approved:  !!body.approved,
    updatedAt: new Date().toISOString(),
    updatedBy: username || 'unknown',
  };
}

// ── FAQ / AI helpers ──────────────────────────────────────────────────────────

function answerToPlain(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<strong>(.*?)<\/strong>/gi, '*$1*')
    .replace(/<span[^>]*>(.*?)<\/span>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

async function callClaudeInternal(bodyObj, apiKey) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey,
                 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    }, rs => { let d = ''; rs.on('data', c => d += c); rs.on('end', () => resolve(JSON.parse(d))); });
    r.on('error', reject); r.write(body); r.end();
  });
}

// Semantic FAQ search via Claude Haiku — cheap + fast
// Returns [{id, confidence:'high'|'medium'}] sorted by relevance
async function searchFaqSemantic(queryText, faqEntries, apiKey) {
  if (!faqEntries.length) return [];
  const index = faqEntries.map(e =>
    `${e.id}|${e.topic || ''}${e.keys?.length ? '|' + e.keys.join(',') : ''}`
  ).join('\n');
  const sys = `You are a FAQ search engine for a tax consultant bot in Spain (Russian-speaking clients).

Your task: find which FAQ entry BEST answers the user's question.

CRITICAL RULES:
1. Match by TOPIC first: a question about taxes (налог, платить, IRPF) must match a TAXES entry, NOT a visa/registration entry — even if both mention the same subject (e.g. nomads).
2. Match by SUBJECT second: who/what the question is about (autónomo, nomad, empresa, etc.)
3. "кочевник" = "номад" = "nómada" = "digital nomad" — treat as synonyms.
4. confidence "high" = entry clearly and directly answers the full question.
5. confidence "medium" = partially relevant, not a perfect match.
6. Return max 3 matches, best first. Empty array if nothing is relevant.

Reply ONLY valid JSON (no markdown): {"matches":[{"id":"...","confidence":"high|medium"}]}`;
  try {
    const searchModel = getModel('client');
    const result = await callClaudeInternal({
      model: searchModel, max_tokens: 200,
      system: sys,
      messages: [{ role: 'user', content: `Question: "${queryText}"\n\nFAQ index:\n${index}` }]
    }, apiKey);
    if (result.usage) recordTokens('client', searchModel, result.usage.input_tokens, result.usage.output_tokens);
    const raw = result.content?.[0]?.text?.trim() || '';
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim());
    return Array.isArray(parsed.matches) ? parsed.matches : [];
  } catch (e) {
    console.error('[searchFaqSemantic] error:', e.message);
    return [];
  }
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

  // ── Ask: semantic FAQ search for Mini App ────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/ask') {
    const body = await readJsonBody(req);
    const { text, faqId } = body;
    const faqList = loadFaq().ru || [];

    // Direct lookup by ID — used after clarification choice
    if (faqId !== undefined) {
      const entry = faqList.find(e => String(e.id) === String(faqId));
      if (entry) json(res, 200, { type: 'faq', answer: entry.answer, topic: entry.topic || '' });
      else        json(res, 404, { error: 'not found' });
      return;
    }

    if (!text) { json(res, 400, { error: 'text required' }); return; }

    const apiKey     = getApiKey('client');
    const activeEntries = faqList.filter(e => e.keys?.length && e.answer);
    if (!apiKey || !activeEntries.length) { json(res, 200, { type: 'ai' }); return; }

    const matches = await searchFaqSemantic(text, activeEntries, apiKey);

    if (!matches.length) { json(res, 200, { type: 'ai' }); return; }

    if (matches[0].confidence === 'high') {
      // First match is clear → answer directly
      const entry = activeEntries.find(e => String(e.id) === String(matches[0].id));
      if (entry) { json(res, 200, { type: 'faq', answer: entry.answer, topic: entry.topic || '' }); return; }
    }

    if (matches.length === 1) {
      // Single medium-confidence match → answer directly (best guess)
      const entry = activeEntries.find(e => String(e.id) === String(matches[0].id));
      if (entry) { json(res, 200, { type: 'faq', answer: entry.answer, topic: entry.topic || '' }); return; }
    }

    // Multiple medium-confidence matches → ask user to clarify
    const options = matches
      .map(m => activeEntries.find(e => String(e.id) === String(m.id)))
      .filter(Boolean)
      .map(e => ({ id: e.id, topic: e.topic || '' }));
    if (options.length) json(res, 200, { type: 'clarify', options });
    else                json(res, 200, { type: 'ai' });
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

  // ── Admin session check ────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/admin/session') {
    const s = getSession(req);
    if (!s) { json(res, 401, { error: 'Session abgelaufen' }); return; }
    json(res, 200, { username: s.username, role: s.role });
    return;
  }

  // ── Admin logout ───────────────────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/admin/logout') {
    const token = getToken(req);
    if (token) { dbSessionEnd(token); sessions.delete(token); }
    json(res, 200, { ok: true });
    return;
  }

  // ── Admin login ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/admin/login') {
    const body = await readJsonBody(req);
    const username = (body.username || '').trim();
    const password = body.password || '';
    const users = loadPortalUsers();
    const user = users.find(u => u.username === username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      json(res, 401, { error: 'Falscher Benutzername oder Passwort' }); return;
    }
    const token = generateToken();
    sessions.set(token, { username: user.username, role: user.role || 'admin', expiresAt: Date.now() + SESSION_TTL });
    dbSessionStart(user.username, token, req.socket?.remoteAddress);
    json(res, 200, { token, username: user.username, role: user.role || 'admin' });
    return;
  }

  // ── Change own password ────────────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/admin/change-password') {
    const s = getSession(req);
    if (!s) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    const body = await readJsonBody(req);
    const users = loadPortalUsers();
    const user = users.find(u => u.username === s.username);
    if (!user) { json(res, 404, { error: 'Benutzer nicht gefunden' }); return; }
    if (!verifyPassword(body.currentPassword || '', user.passwordHash)) {
      json(res, 401, { error: 'Aktuelles Passwort falsch' }); return;
    }
    if (!body.newPassword || body.newPassword.length < 6) {
      json(res, 400, { error: 'Neues Passwort muss mind. 6 Zeichen haben' }); return;
    }
    user.passwordHash = hashPassword(body.newPassword);
    savePortalUsers(users);
    json(res, 200, { ok: true });
    return;
  }

  // ── Forgot password ───────────────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/admin/forgot-password') {
    const body = await readJsonBody(req);
    const identifier = (body.username || body.email || '').trim().toLowerCase();
    const users = loadPortalUsers();
    const user = users.find(u => u.username.toLowerCase() === identifier || (u.email && u.email.toLowerCase() === identifier));
    if (!user || !user.email) {
      json(res, 404, { error: 'Benutzer nicht gefunden oder keine E-Mail hinterlegt' }); return;
    }
    const tempPw = genTempPassword();
    user.passwordHash = hashPassword(tempPw);
    savePortalUsers(users);
    try {
      await sendMail(user.email, 'Временный пароль — Админ-портал',
        `Здравствуйте, ${user.username}!\n\nВаш временный пароль: ${tempPw}\n\nПожалуйста, войдите и смените пароль.\n\nhttps://nalog.goeloria.com/admin.html`);
      json(res, 200, { ok: true });
    } catch(e) {
      json(res, 500, { error: 'Пароль сброшен, но отправить письмо не удалось: ' + e.message });
    }
    return;
  }

  // ── Portal users (superadmin only) ────────────────────────────────────────
  if (urlPath === '/api/admin/portal-users') {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    if (!isSuperAdmin(req))    { json(res, 403, { error: 'Keine Berechtigung' }); return; }
    if (req.method === 'GET') {
      json(res, 200, loadPortalUsers().map(u => ({ username: u.username, email: u.email || '', role: u.role || 'admin' })));
      return;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const users = loadPortalUsers();
      if (!body.username || !body.password) { json(res, 400, { error: 'username und password erforderlich' }); return; }
      if (users.find(u => u.username === body.username)) { json(res, 409, { error: 'Benutzer existiert bereits' }); return; }
      users.push({ username: body.username.trim(), passwordHash: hashPassword(body.password), email: body.email || '', role: body.role || 'admin' });
      savePortalUsers(users);
      json(res, 200, { ok: true }); return;
    }
  }

  if (urlPath.startsWith('/api/admin/portal-users/')) {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    if (!isSuperAdmin(req))    { json(res, 403, { error: 'Keine Berechtigung' }); return; }
    const uname = decodeURIComponent(urlPath.slice('/api/admin/portal-users/'.length));
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const users = loadPortalUsers();
      const idx = users.findIndex(u => u.username === uname);
      if (idx === -1) { json(res, 404, { error: 'Nicht gefunden' }); return; }
      if (body.email    !== undefined) users[idx].email = body.email;
      if (body.role     !== undefined) users[idx].role  = body.role;
      if (body.password)               users[idx].passwordHash = hashPassword(body.password);
      savePortalUsers(users);
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'DELETE') {
      const users = loadPortalUsers().filter(u => u.username !== uname);
      savePortalUsers(users);
      json(res, 200, { ok: true }); return;
    }
  }

  // ── Session history (superadmin only) ─────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/admin/session-history') {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    if (!isSuperAdmin(req))    { json(res, 403, { error: 'Keine Berechtigung' }); return; }
    json(res, 200, dbGetSessionHistory(200));
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
      const entry = normalizeEntry(body, maxId + 1, getSession(req)?.username);
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
      faq.ru[idx] = normalizeEntry(body, id, getSession(req)?.username);
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

    // ── Inline keyboard callback (FAQ clarification choice) ────────────────
    if (body.callback_query && TG_TOKEN) {
      const cq       = body.callback_query;
      const cbData   = cq.data || '';
      const cbUid    = cq.from?.id;
      const cbChatId = cq.message?.chat?.id;
      const tgCb = (method, payload) => new Promise((resolve, reject) => {
        const d = JSON.stringify(payload);
        const r = https.request({ hostname:'api.telegram.org', path:`/bot${TG_TOKEN}/${method}`, method:'POST',
          headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)} }, rs => {
          let b2=''; rs.on('data',c=>b2+=c); rs.on('end',()=>resolve(JSON.parse(b2)));
        });
        r.on('error', reject); r.write(d); r.end();
      });
      await tgCb('answerCallbackQuery', { callback_query_id: cq.id });

      if (cbData.startsWith('clarify:') && cbChatId) {
        const choice  = cbData.replace('clarify:', '');
        const pending = pendingClarifications.get(cbUid);
        pendingClarifications.delete(cbUid);
        const markup  = { inline_keyboard: [[{ text: '🌐 Открыть бота', web_app: { url: BOT_URL } }]] };

        if (choice === '__ai__') {
          const origQuery = pending?.query || '';
          if (origQuery) {
            const apiKey = getApiKey('client');
            if (apiKey) {
              await tgCb('sendChatAction', { chat_id: cbChatId, action: 'typing' });
              const sysP = CLIENT_SYSTEM_PROMPT;
              const aiR = await callClaudeInternal({ model: getModel('client'), max_tokens: 600,
                system: sysP, messages: [...getConvHistory(cbChatId), { role: 'user', content: origQuery }] }, apiKey);
              const reply = aiR.content?.[0]?.text || '';
              if (aiR.usage) recordTokens('client', getModel('client'), aiR.usage.input_tokens, aiR.usage.output_tokens);
              if (!reply || /^\[?SKIP\]?$/i.test(reply.trim())) {
                const skipMsg = 'Этот вопрос выходит за рамки моей специализации 🙂 Александр занимается налогами и бухгалтерией в Испании. Если есть налоговый вопрос — спрашивайте!';
                await tgCb('sendMessage', { chat_id: cbChatId, text: skipMsg });
                dbLogMessage(cbChatId, origQuery, 'skip', skipMsg);
              } else {
                await tgCb('sendMessage', { chat_id: cbChatId, text: reply + '\n\n💬 Авто-ответ', reply_markup: markup });
                recordConvTurn(cbChatId, origQuery, reply);
                const sa = loadStats(); sa.total++; sa.ai++; saveStats(sa);
                dbLogMessage(cbChatId, origQuery, 'ai', reply);
              }
            }
          }
        } else {
          const entry = (loadFaq().ru || []).find(e => String(e.id) === String(choice));
          if (entry) {
            const plain = answerToPlain(entry.answer);
            await tgCb('sendMessage', { chat_id: cbChatId, text: plain + '\n\n✅ Проверено Александром',
              parse_mode: 'Markdown', reply_markup: markup });
            recordConvTurn(cbChatId, pending?.query || '', plain);
            const sf = loadStats(); sf.total++; sf.faq++;
            if (entry.topic) sf.topics[entry.topic] = (sf.topics[entry.topic] || 0) + 1;
            saveStats(sf);
            dbLogMessage(cbChatId, pending?.query || String(choice), 'faq', plain);
          }
        }
      }
      return;
    }

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

    // Global Business Chat on/off switch
    if (bizConnId && loadConfig().bizBotEnabled === false) return;

    // Skip messages sent BY the business account owner (Alexander's own messages)
    if (bizConnId && msg.from?.id) {
      let ownerId = bizOwners.get(bizConnId);
      if (!ownerId) {
        // Try persistent cache in config first (survives restarts)
        ownerId = loadConfig()._bizOwners?.[bizConnId] || null;
        if (ownerId) {
          bizOwners.set(bizConnId, ownerId);
        } else {
          // Fetch from Telegram API
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
              ownerId = connRes.result.user.id;
              bizOwners.set(bizConnId, ownerId);
              // Persist so it survives server restarts
              const cfg = loadConfig();
              cfg._bizOwners = { ...(cfg._bizOwners || {}), [bizConnId]: ownerId };
              saveConfig(cfg);
              console.log('[BIZ] owner persisted:', bizConnId, '→', ownerId);
            }
          } catch(e) { console.warn('[BIZ] getBusinessConnection failed:', e.message); }
        }
      }
      if (ownerId && msg.from.id === ownerId) { console.log('[BIZ] skipping owner msg'); return; }
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

    // Business context: check exclusion list (only for Business Chat, not direct bot)
    if (bizConnId && db) {
      const userRow = db.prepare('SELECT excluded FROM users WHERE chat_id = ?').get(chatId);
      if (userRow?.excluded) return;
    }

    // FAQ search
    const faqList = (loadFaq().ru || []);
    const lower = text.toLowerCase();

    // In Business Chat: skip contact/callback requests — Alexander replies personally
    if (bizConnId) {
      const contactPhrases = ['свяжитесь', 'свяжется', 'свяжись', 'перезвоните', 'перезвони', 'позвоните', 'позвони', 'напишите мне', 'напиши мне', 'хочу связаться', 'как связаться', 'контакты', 'contact me', 'call me'];
      if (contactPhrases.some(p => lower.includes(p))) {
        const replyText = 'Александр ответит вам лично в ближайшее время 🙂';
        await tg('sendMessage', { ...bizExtra, chat_id: chatId, text: replyText });
        dbLogMessage(chatId, text, 'auto', replyText);
        return;
      }
    }

    const greetings = ['привет', 'здравствуй', 'добрый', 'hallo', 'hello', 'hi', 'хай', 'салют', 'buenos'];
    const isGreeting = text === '/start' || greetings.some(g => lower.startsWith(g));
    let queryText = text;
    let queryLower = lower;
    let bizGreetPrefix = false;

    if (isGreeting && bizConnId) {
      if (text === '/start') return;
      // Remove greeting word (incl. suffix like -те: здравствуй→здравствуйте)
      const matchedG = greetings.find(g => lower.startsWith(g)) || '';
      let afterGreet = text.replace(new RegExp('^' + matchedG + '\\w*', 'i'), '').replace(/^[\s,!.?,]+/, '').trim();
      // Remove time-of-day words that follow "добрый" (вечер/день/утро/ночь)
      afterGreet = afterGreet.replace(/^(вечер|день|утро|ночь|дня)\b\s*/i, '').replace(/^[\s,!.?,]+/, '').trim();
      const questionPart = afterGreet;
      if (!questionPart) {
        // Pure greeting — in away mode stay silent (Telegram's own away message is enough)
        if (loadConfig().bizAwayMode) return;
        const greetingText = '👋 Привет! Я помощник Александра Танцюры по налоговым вопросам в Испании. Задайте ваш вопрос — отвечу сразу!\n\nИли откройте полную версию: https://t.me/TantsiuraTax_Bot';
        await tg('sendMessage', { ...bizExtra, chat_id: chatId, text: greetingText });
        dbLogMessage(chatId, text, 'greeting', greetingText);
        return;
      }
      // Greeting + question — process question, prepend greeting to answer
      queryText  = questionPart;
      queryLower = questionPart.toLowerCase();
      bizGreetPrefix = !loadConfig().bizAwayMode; // no greeting prefix when in away mode
    }

    if (isGreeting && !bizConnId) {
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
    // ── Semantic FAQ search via Claude Haiku ─────────────────────────────────
    const apiKey     = getApiKey('client');
    const activeFaq  = faqList.filter(e => e.keys?.length && e.answer);
    let faqEntry     = null;
    let clarifyOpts  = [];

    if (activeFaq.length && apiKey) {
      const matches = await searchFaqSemantic(queryText, activeFaq, apiKey);
      if (matches.length >= 1 && matches[0].confidence === 'high') {
        // First match is clear → answer directly, ignore lower-confidence alternatives
        faqEntry = activeFaq.find(e => String(e.id) === String(matches[0].id)) || null;
      } else if (matches.length > 1) {
        // Multiple medium-confidence matches → ask user to clarify
        clarifyOpts = matches
          .map(m => activeFaq.find(e => String(e.id) === String(m.id)))
          .filter(Boolean)
          .map(e => ({ id: e.id, topic: e.topic || '' }));
      } else if (matches.length === 1) {
        // Single medium-confidence match → answer directly (best guess)
        faqEntry = activeFaq.find(e => String(e.id) === String(matches[0].id)) || null;
      }
    }

    if (faqEntry) {
      const plain     = answerToPlain(faqEntry.answer);
      const faqMarkup = bizConnId ? undefined
        : { inline_keyboard: [[{ text: '🌐 Открыть бота', web_app: { url: BOT_URL } }]] };
      const faqText   = (bizGreetPrefix ? '👋 Привет!\n\n' : '') + plain + '\n\n✅ Проверено Александром';
      await tg('sendMessage', { ...bizExtra, chat_id: chatId, text: faqText, parse_mode: 'Markdown',
        ...(faqMarkup ? { reply_markup: faqMarkup } : {}) });
      recordConvTurn(chatId, queryText, plain);
      const sf = loadStats(); sf.total++; sf.faq++;
      if (faqEntry.topic) sf.topics[faqEntry.topic] = (sf.topics[faqEntry.topic] || 0) + 1;
      saveStats(sf);
      dbLogMessage(chatId, text, 'faq', plain);
      return;
    }

    if (clarifyOpts.length) {
      const userId = msg.from?.id || chatId;
      pendingClarifications.set(userId, { options: clarifyOpts, query: queryText, expiresAt: Date.now() + 5 * 60 * 1000 });
      const keyboard = clarifyOpts.map(opt => [{ text: opt.topic, callback_data: `clarify:${opt.id}` }]);
      keyboard.push([{ text: '❓ Ничего из этого → Авто-ответ', callback_data: 'clarify:__ai__' }]);
      await tg('sendMessage', { ...bizExtra, chat_id: chatId,
        text: '🤔 Уточните, пожалуйста, о чём ваш вопрос:',
        reply_markup: { inline_keyboard: keyboard } });
      dbLogMessage(chatId, text, 'clarify', '🤔 Уточните, пожалуйста, о чём ваш вопрос:');
      return;
    }

    // ── AI fallback ──────────────────────────────────────────────────────────
    if (!apiKey) {
      if (!bizConnId) await tg('sendMessage', { chat_id: chatId, text: 'Бот временно недоступен. Обратитесь напрямую: @AlexanderTantsiura' });
      return;
    }
    await tg('sendChatAction', { ...bizExtra, chat_id: chatId, action: 'typing' });
    const sysPrompt = CLIENT_SYSTEM_PROMPT;
    const aiRes = await callClaudeInternal({
      model: getModel('client'), max_tokens: 600,
      system: sysPrompt,
      messages: [...getConvHistory(chatId), { role: 'user', content: queryText }]
    }, apiKey);
    const reply = aiRes.content?.[0]?.text || '';
    if (aiRes.usage) recordTokens('client', getModel('client'), aiRes.usage.input_tokens, aiRes.usage.output_tokens);
    console.log('[TG] AI reply:', JSON.stringify(reply.slice(0, 80)), '| biz:', !!bizConnId);
    if (!reply || /^\[?SKIP\]?$/i.test(reply.trim())) {
      console.log('[TG] SKIP — freundliche Meldung');
      const skipMsg = 'Этот вопрос выходит за рамки моей специализации 🙂 Александр занимается налогами и бухгалтерией в Испании. Если есть налоговый вопрос — спрашивайте!';
      if (!bizConnId) await tg('sendMessage', { chat_id: chatId, text: skipMsg });
      dbLogMessage(chatId, text, 'skip', skipMsg);
      return;
    }
    const aiMarkup = bizConnId ? undefined
      : { inline_keyboard: [[{ text: '🌐 Открыть бота', web_app: { url: BOT_URL } }]] };
    const aiText = (bizGreetPrefix ? '👋 Привет!\n\n' : '') + reply + '\n\n💬 Авто-ответ';
    const sendRes = await tg('sendMessage', { ...bizExtra, chat_id: chatId, text: aiText,
      ...(aiMarkup ? { reply_markup: aiMarkup } : {})
    });
    console.log('[TG] sendMessage ok:', sendRes?.ok, sendRes?.description);
    recordConvTurn(chatId, queryText, reply);
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

  // ── Admin: exclude/include user from Business Chat ────────────────────────
  if (req.method === 'POST' && urlPath.match(/^\/api\/admin\/users\/\d+\/exclude$/)) {
    if (!isAuthenticated(req)) { json(res, 401, { error: 'Nicht autorisiert' }); return; }
    const chatId  = parseInt(urlPath.split('/')[4]);
    const body    = await readJsonBody(req);
    const excluded = body.excluded ? 1 : 0;
    if (db) db.prepare('UPDATE users SET excluded = ? WHERE chat_id = ?').run(excluded, chatId);
    json(res, 200, { ok: true, excluded });
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
