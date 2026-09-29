// Сервер «Посещаемость» — Cloudflare Worker + база D1.
// Все проверки прав делаются здесь: сайт на GitHub Pages только показывает данные.

const TZ_MS = 5 * 3600 * 1000;               // Ташкент, UTC+5 (без перехода на летнее время)
const LOCK_TIME = '15:10';                   // пятница — итоговый день, неделя закрывается в это время
const SESSION_DAYS = 30;
const PBKDF2_ITER = 5000;                    // бесплатный Workers даёт ~10 мс CPU на запрос; от подбора защищает блокировка
const MAX_STUDENTS = 80, MAX_PAIRS = 8, MAX_GROUPS = 200;
const KEY_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------- Ответы ---------- */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (allowed.includes('*') || allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin || '*';
  return h;
}
function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors }
  });
}

/* ---------- Время (Ташкент) ---------- */

const todayTk = (ms = Date.now()) => new Date(ms + TZ_MS).toISOString().slice(0, 10);
function isDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const weekday = (day) => new Date(day + 'T00:00:00Z').getUTCDay();   // 0 — воскресенье
function addDays(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isSchoolDay = (day) => { const w = weekday(day); return w >= 1 && w <= 5; };
const mondayOf = (day) => { const w = weekday(day); return addDays(day, w === 0 ? -6 : 1 - w); };
const lockAt = (monday) => Date.parse(addDays(monday, 4) + 'T' + LOCK_TIME + ':00+05:00');
const weekDays = (monday) => [0, 1, 2, 3, 4].map((i) => addDays(monday, i));

/* ---------- Криптография ---------- */

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
const sha256 = async (s) => toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: PBKDF2_ITER }, key, 256);
  return toHex(bits);
}
const randomHex = (bytes) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));
function newRegKey() { // вид: K7M2-QX9P-4RTA, около 60 бит случайности
  const r = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (let i = 0; i < 12; i++) s += KEY_ABC[r[i] % KEY_ABC.length] + (i === 3 || i === 7 ? '-' : '');
  return s;
}
const normKey = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ---------- Защита от подбора ---------- */

async function checkThrottle(db, k) {
  const row = await db.prepare('SELECT locked_until FROM throttle WHERE k = ?').bind(k).first();
  if (row && row.locked_until > Date.now()) {
    const min = Math.ceil((row.locked_until - Date.now()) / 60000);
    fail(429, `Слишком много неверных попыток. Подождите ${min} мин.`);
  }
}
async function addFail(db, k, max, lockMin) {
  const row = await db.prepare('SELECT fails, locked_until FROM throttle WHERE k = ?').bind(k).first();
  let fails = row && row.locked_until <= Date.now() && row.locked_until > 0 ? 1 : (row ? row.fails + 1 : 1);
  let locked = 0;
  if (fails >= max) { locked = Date.now() + lockMin * 60000; fails = 0; }
  await db.prepare('INSERT INTO throttle (k, fails, locked_until) VALUES (?, ?, ?) ' +
    'ON CONFLICT(k) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until').bind(k, fails, locked).run();
}
const clearFails = (db, k) => db.prepare('DELETE FROM throttle WHERE k = ?').bind(k).run();

/* ---------- Сессии ---------- */

async function newSession(db, role, groupId) {
  const token = randomHex(32);
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('INSERT INTO sessions (token_hash, role, group_id, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), role, groupId, now + SESSION_DAYS * 86400000)
  ]);
  return token;
}
async function auth(req, db) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('Authorization') || '');
  if (!m) fail(401, 'Нужно войти.');
  const s = await db.prepare('SELECT role, group_id, expires_at FROM sessions WHERE token_hash = ?').bind(await sha256(m[1])).first();
  if (!s || s.expires_at < Date.now()) fail(401, 'Сессия закончилась — войдите заново.');
  return { role: s.role, groupId: s.group_id, tokenHash: await sha256(m[1]) };
}
const requireAdmin = (ctx) => { if (ctx.role !== 'admin') fail(403, 'Только для главного админа.'); };

// Группа, с которой работает запрос: у старосты — только своя, админ выбирает параметром g.
async function groupOf(ctx, url, db) {
  const id = ctx.role === 'group' ? ctx.groupId : Number(url.searchParams.get('g'));
  const g = id ? await db.prepare('SELECT id, name, pairs_per_day FROM groups WHERE id = ?').bind(id).first() : null;
  if (!g) fail(404, 'Группа не найдена.');
  return g;
}

/* ---------- Проверки ввода ---------- */

async function body(req) {
  try { return await req.json(); } catch (e) { fail(400, 'Неверный запрос.'); }
}
const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ');
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8) fail(400, 'Пароль — не короче 8 символов.');
  if (p.length > 200) fail(400, 'Слишком длинный пароль.');
}
const ip = (req) => req.headers.get('CF-Connecting-IP') || 'local';

// Можно ли менять отметки этого дня. Староста — только текущая неделя, до пятницы 15:10. Админ — любой прошедший учебный день.
function editState(day, ctx, now = Date.now()) {
  const today = todayTk(now);
  if (!isSchoolDay(day)) return { ok: false, why: 'Суббота и воскресенье — выходные, отметок нет.' };
  if (day > today) return { ok: false, why: 'Этот день ещё не наступил.' };
  if (ctx.role === 'admin') return { ok: true };
  if (mondayOf(day) !== mondayOf(today)) return { ok: false, why: 'Прошлые недели менять нельзя — только главный админ.' };
  if (now >= lockAt(mondayOf(day))) return { ok: false, why: 'Неделя закрыта в пятницу в ' + LOCK_TIME + ' — итог подведён.' };
  return { ok: true };
}

/* ---------- Обработчики ---------- */

const routes = [];
const on = (method, path, fn) => routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$'), fn });

// Список групп для входа (только названия и только тех, где староста уже зарегистрировался).
on('GET', '/api/groups', async ({ db }) => {
  const { results } = await db.prepare('SELECT id, name FROM groups WHERE pass_hash IS NOT NULL').all();
  return { groups: results.sort((a, b) => a.name.localeCompare(b.name, 'ru')) };
});

on('POST', '/api/admin/login', async ({ req, db, env }) => {
  const b = await body(req), k = 'admin:' + ip(req);
  await checkThrottle(db, k);
  if (!env.ADMIN_PASSWORD) fail(500, 'На сервере не задан пароль админа (ADMIN_PASSWORD).');
  if (!sameHex(await sha256(String(b.password || '')), await sha256(env.ADMIN_PASSWORD))) {
    await addFail(db, k, 5, 15);
    fail(401, 'Неверный пароль админа.');
  }
  await clearFails(db, k);
  return { token: await newSession(db, 'admin', null) };
});

// Регистрация старосты: ключ от админа (одноразовый) + свой пароль.
on('POST', '/api/register', async ({ req, db }) => {
  const b = await body(req), k = 'reg:' + ip(req);
  await checkThrottle(db, k);
  checkPassword(b.password);
  const key = normKey(b.key);
  const g = key.length === 12 ? await db.prepare('SELECT id, name FROM groups WHERE reg_key_hash = ?').bind(await sha256(key)).first() : null;
  if (!g) { await addFail(db, k, 10, 30); fail(401, 'Ключ не подходит или уже использован.'); }
  const salt = randomHex(16);
  await db.batch([
    db.prepare('UPDATE groups SET pass_hash = ?, pass_salt = ?, reg_key_hash = NULL WHERE id = ?')
      .bind(await hashPassword(b.password, salt), salt, g.id),
    db.prepare('DELETE FROM sessions WHERE group_id = ?').bind(g.id)
  ]);
  await clearFails(db, k);
  return { token: await newSession(db, 'group', g.id), group: g };
});

on('POST', '/api/login', async ({ req, db }) => {
  const b = await body(req), id = Number(b.groupId);
  const k = 'login:' + id + ':' + ip(req);
  await checkThrottle(db, k);
  const g = id ? await db.prepare('SELECT id, name, pass_hash, pass_salt FROM groups WHERE id = ?').bind(id).first() : null;
  if (!g || !g.pass_hash) fail(404, 'Группа не найдена.');
  if (!sameHex(await hashPassword(String(b.password || ''), g.pass_salt), g.pass_hash)) {
    await addFail(db, k, 5, 15);
    fail(401, 'Неверный пароль.');
  }
  await clearFails(db, k);
  return { token: await newSession(db, 'group', g.id), group: { id: g.id, name: g.name } };
});

on('POST', '/api/logout', async ({ ctx, db }) => {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(ctx.tokenHash).run();
  return { ok: true };
});

on('GET', '/api/me', async ({ ctx, db }) => {
  const now = Date.now(), today = todayTk(now);
  let group = null;
  if (ctx.role === 'group') {
    group = await db.prepare('SELECT id, name, pairs_per_day AS pairsPerDay FROM groups WHERE id = ?').bind(ctx.groupId).first();
    if (!group) fail(401, 'Группа удалена.');
  }
  return { role: ctx.role, group, today, now, lockTime: LOCK_TIME, weekLockAt: lockAt(mondayOf(today)) };
});

/* --- Админ: группы и ключи --- */

on('GET', '/api/admin/groups', async ({ ctx, db }) => {
  requireAdmin(ctx);
  const { results } = await db.prepare(
    'SELECT g.id, g.name, g.pairs_per_day AS pairsPerDay, g.pass_hash IS NOT NULL AS registered, ' +
    'g.reg_key_hash IS NOT NULL AS keyPending, ' +
    '(SELECT COUNT(*) FROM students s WHERE s.group_id = g.id AND s.active = 1) AS students ' +
    'FROM groups g').all();
  results.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { groups: results.map((g) => ({ ...g, registered: !!g.registered, keyPending: !!g.keyPending })) };
});

on('POST', '/api/admin/groups', async ({ req, ctx, db }) => {
  requireAdmin(ctx);
  const name = cleanName((await body(req)).name);
  if (name.length < 1 || name.length > 60) fail(400, 'Название группы — от 1 до 60 символов.');
  const { results } = await db.prepare('SELECT name FROM groups').all();
  if (results.length >= MAX_GROUPS) fail(400, 'Слишком много групп.');
  // COLLATE NOCASE в SQLite не понимает кириллицу, поэтому сравниваем здесь.
  if (results.some((r) => r.name.toLowerCase() === name.toLowerCase())) fail(409, 'Группа с таким названием уже есть.');
  const key = newRegKey();
  const r = await db.prepare('INSERT INTO groups (name, reg_key_hash, created_at) VALUES (?, ?, ?)')
    .bind(name, await sha256(normKey(key)), Date.now()).run();
  return { group: { id: r.meta.last_row_id, name }, key };
});

// Новый ключ: старый пароль старосты перестаёт работать, все его входы сбрасываются.
on('POST', '/api/admin/groups/:id/reset', async ({ ctx, db, params }) => {
  requireAdmin(ctx);
  const id = Number(params.id);
  if (!await db.prepare('SELECT 1 FROM groups WHERE id = ?').bind(id).first()) fail(404, 'Группа не найдена.');
  const key = newRegKey();
  await db.batch([
    db.prepare('UPDATE groups SET reg_key_hash = ?, pass_hash = NULL, pass_salt = NULL WHERE id = ?').bind(await sha256(normKey(key)), id),
    db.prepare('DELETE FROM sessions WHERE group_id = ?').bind(id)
  ]);
  return { key };
});

on('DELETE', '/api/admin/groups/:id', async ({ ctx, db, params }) => {
  requireAdmin(ctx);
  const id = Number(params.id);
  await db.batch([
    db.prepare('DELETE FROM marks WHERE student_id IN (SELECT id FROM students WHERE group_id = ?)').bind(id),
    db.prepare('DELETE FROM students WHERE group_id = ?').bind(id),
    db.prepare('DELETE FROM sessions WHERE group_id = ?').bind(id),
    db.prepare('DELETE FROM groups WHERE id = ?').bind(id)
  ]);
  return { ok: true };
});

/* --- Группа: ученики и настройки --- */

on('GET', '/api/students', async ({ ctx, db, url }) => {
  const g = await groupOf(ctx, url, db);
  const { results } = await db.prepare('SELECT id, full_name AS name FROM students WHERE group_id = ? AND active = 1').bind(g.id).all();
  results.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { group: { id: g.id, name: g.name, pairsPerDay: g.pairs_per_day }, students: results };
});

on('POST', '/api/students', async ({ req, ctx, db, url }) => {
  const g = await groupOf(ctx, url, db);
  const name = cleanName((await body(req)).name);
  if (name.length < 2 || name.length > 80) fail(400, 'Имя ученика — от 2 до 80 символов.');
  const { results } = await db.prepare('SELECT full_name FROM students WHERE group_id = ? AND active = 1').bind(g.id).all();
  if (results.length >= MAX_STUDENTS) fail(400, `В группе уже ${MAX_STUDENTS} учеников — это максимум.`);
  if (results.some((s) => s.full_name.toLowerCase() === name.toLowerCase())) fail(409, 'Такой ученик уже есть в списке.');
  const r = await db.prepare('INSERT INTO students (group_id, full_name, created_at) VALUES (?, ?, ?)').bind(g.id, name, Date.now()).run();
  return { student: { id: r.meta.last_row_id, name } };
});

// Удаление из списка. Прошлые отметки остаются в итогах тех недель.
on('DELETE', '/api/students/:id', async ({ ctx, db, url, params }) => {
  const g = await groupOf(ctx, url, db);
  const r = await db.prepare('UPDATE students SET active = 0, removed_at = ? WHERE id = ? AND group_id = ? AND active = 1')
    .bind(Date.now(), Number(params.id), g.id).run();
  if (!r.meta.changes) fail(404, 'Ученик не найден в этой группе.');
  return { ok: true };
});

on('PATCH', '/api/group', async ({ req, ctx, db, url }) => {
  const g = await groupOf(ctx, url, db);
  const n = Number((await body(req)).pairsPerDay);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAIRS) fail(400, `Пар в день — от 1 до ${MAX_PAIRS}.`);
  await db.prepare('UPDATE groups SET pairs_per_day = ? WHERE id = ?').bind(n, g.id).run();
  return { pairsPerDay: n };
});

/* --- Отметки --- */

on('GET', '/api/marks', async ({ ctx, db, url }) => {
  const g = await groupOf(ctx, url, db);
  const day = url.searchParams.get('day');
  if (!isDay(day)) fail(400, 'Неверная дата.');
  const { results } = await db.prepare(
    'SELECT m.student_id AS s, m.pair AS p, m.present AS v FROM marks m JOIN students st ON st.id = m.student_id ' +
    'WHERE st.group_id = ? AND m.day = ?').bind(g.id, day).all();
  const marks = {};
  results.forEach((r) => { (marks[r.s] = marks[r.s] || {})[r.p] = r.v; });
  const st = editState(day, ctx);
  return { day, pairsPerDay: g.pairs_per_day, editable: st.ok, why: st.why || null, marks };
});

// Сохранить отметки одной пары: marks = [{ id, v }], v: 1 «+», 0 «−», null — снять отметку.
on('PUT', '/api/marks', async ({ req, ctx, db, url }) => {
  const g = await groupOf(ctx, url, db);
  const b = await body(req);
  if (!isDay(b.day)) fail(400, 'Неверная дата.');
  const st = editState(b.day, ctx);
  if (!st.ok) fail(403, st.why);
  const pair = Number(b.pair);
  if (!Number.isInteger(pair) || pair < 1 || pair > g.pairs_per_day) fail(400, 'Неверный номер пары.');
  if (!Array.isArray(b.marks) || !b.marks.length || b.marks.length > MAX_STUDENTS) fail(400, 'Нет отметок.');
  const { results } = await db.prepare('SELECT id FROM students WHERE group_id = ? AND active = 1').bind(g.id).all();
  const mine = new Set(results.map((r) => r.id));
  const now = Date.now();
  const stmts = b.marks.map((m) => {
    const id = Number(m && m.id);
    if (!mine.has(id)) fail(400, 'Ученик не из этой группы.');
    if (m.v === null) return db.prepare('DELETE FROM marks WHERE student_id = ? AND day = ? AND pair = ?').bind(id, b.day, pair);
    if (m.v !== 0 && m.v !== 1) fail(400, 'Отметка — только + или −.');
    return db.prepare('INSERT INTO marks (student_id, day, pair, present, updated_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(student_id, day, pair) DO UPDATE SET present = excluded.present, updated_at = excluded.updated_at')
      .bind(id, b.day, pair, m.v, now);
  });
  await db.batch(stmts);
  return { ok: true, saved: stmts.length };
});

/* --- Итог недели --- */

on('GET', '/api/report', async ({ ctx, db, url }) => {
  const g = await groupOf(ctx, url, db);
  const any = url.searchParams.get('week') || todayTk();
  if (!isDay(any)) fail(400, 'Неверная дата.');
  const monday = mondayOf(any), days = weekDays(monday);
  const weekStartMs = Date.parse(monday + 'T00:00:00+05:00'), weekEndMs = Date.parse(addDays(monday, 5) + 'T00:00:00+05:00');

  const { results: marks } = await db.prepare(
    'SELECT m.student_id AS s, m.day AS d, m.pair AS p, m.present AS v FROM marks m JOIN students st ON st.id = m.student_id ' +
    'WHERE st.group_id = ? AND m.day >= ? AND m.day <= ?').bind(g.id, days[0], days[4]).all();
  // В итог попадают ученики, которые были в списке в эту неделю, и все, у кого есть отметки.
  const { results: studs } = await db.prepare(
    'SELECT id, full_name AS name, active FROM students WHERE group_id = ? AND created_at < ? AND (active = 1 OR removed_at >= ?) ' +
    'UNION SELECT id, full_name, active FROM students WHERE id IN (' +
    'SELECT DISTINCT m.student_id FROM marks m JOIN students st ON st.id = m.student_id WHERE st.group_id = ? AND m.day >= ? AND m.day <= ?)')
    .bind(g.id, weekEndMs, weekStartMs, g.id, days[0], days[4]).all();

  const byId = {};
  studs.forEach((s) => { byId[s.id] = { id: s.id, name: s.name, active: !!s.active, marks: {}, plus: 0, minus: 0 }; });
  const pairsUsed = {};
  days.forEach((d) => { pairsUsed[d] = 0; });
  marks.forEach((m) => {
    const s = byId[m.s];
    if (!s) return;
    (s.marks[m.d] = s.marks[m.d] || {})[m.p] = m.v;
    if (m.v) s.plus++; else s.minus++;
    pairsUsed[m.d] = Math.max(pairsUsed[m.d], m.p);
  });
  const students = Object.values(byId).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const lock = lockAt(monday);
  return {
    group: { id: g.id, name: g.name }, monday, days, pairsUsed, students,
    lockAt: lock, final: Date.now() >= lock, today: todayTk()
  };
});

/* ---------- Точка входа ---------- */

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    try {
      for (const r of routes) {
        const m = r.method === req.method && r.re.exec(url.pathname);
        if (!m) continue;
        const db = env.DB;
        const open = ['/api/groups', '/api/admin/login', '/api/register', '/api/login'].includes(url.pathname);
        const ctx = open ? null : await auth(req, db);
        return json(await r.fn({ req, env, db, url, ctx, params: m.groups || {} }), 200, cors);
      }
      if (url.pathname === '/') return json({ ok: true, service: 'attendance' }, 200, cors);
      return json({ error: 'Не найдено.' }, 404, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      console.error(e);
      return json({ error: 'Ошибка сервера. Попробуйте ещё раз.' }, 500, cors);
    }
  }
};

