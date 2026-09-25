/**
 * search-instagram.mjs (клиентская версия)
 * Ищет виральные карусели/рилсы в Instagram через Hiker API (hikerapi.com)
 *
 * Запуск:
 *   node scripts/search-instagram.mjs
 *   node scripts/search-instagram.mjs --days 60 --min-comments 1000 --top 20
 *   node scripts/search-instagram.mjs --days 60 --min-comments 1000 --min-views 100000 --top 20
 *   node scripts/search-instagram.mjs --carousels-only --days 60 --min-comments 1000
 *   node scripts/search-instagram.mjs --reels-only --days 60 --min-comments 1000 --min-views 100000
 *   node scripts/search-instagram.mjs --account someuser  (парсинг конкретного аккаунта)
 *
 * Фильтры:
 *   --days N            период (дефолт: 60)
 *   --min-comments N    мин. комментариев (дефолт: 1000)
 *   --min-views N       мин. просмотров (только для рилсов, дефолт: 0)
 *   --top N             сколько показать (дефолт: 20)
 *   --carousels-only    только карусели (media_type=8)
 *   --reels-only        только рилсы/видео (media_type=2)
 *   --account USER      парсить конкретный аккаунт (добавляется к донорам)
 *
 * Отдельный режим (не запускает обычный поиск, если пуст --search "фраза" — то
 * добавляется К обычному поиску, а не заменяет его):
 *   --search "фраза"    глобальный поиск рилсов по фразе (v2/fbsearch/reels),
 *                       можно повторять флаг; без значения — дефолтный список фраз.
 *
 * Доп. флаги:
 *   --no-hashtags       пропустить хэштеги (экономия квоты)
 *   --only              с --account: только этот аккаунт, без доноров и хэштегов
 *   --donors-limit N    первые N доноров (0 = все)
 *   --json ПУТЬ         дамп результатов в JSON
 *
 * Конфиг (создаёт мастер /setup): scripts/.hiker-config.json — { "hikerApiKey": "..." }
 *
 * Примечание: относительно нашей внутренней версии (RapidAPI social-api4) здесь
 * НЕТ режимов --discover (поиск новых доноров) и --comments (разбор комментариев) —
 * у Hiker нет прямых аналогов этих эндпоинтов в текущем контракте.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HIKER_CFG_PATH = join(ROOT, 'scripts', '.hiker-config.json');
let KEY;
try {
  KEY = JSON.parse(readFileSync(HIKER_CFG_PATH, 'utf8')).hikerApiKey;
} catch {
  console.error('❌ Нет scripts/.hiker-config.json — запусти /setup в Claude Code');
  console.error('   или создай по образцу scripts/hiker-config.example.json');
  process.exit(1);
}
if (!KEY) {
  console.error('❌ scripts/.hiker-config.json: нет поля "hikerApiKey"');
  process.exit(1);
}

const arg = (name) => process.argv.find((a, i) => process.argv[i-1] === name);
// повторяемый флаг: --search "a" --search "b" → ['a','b']
const argAll = (name) => process.argv.filter((a, i) => process.argv[i-1] === name && !a.startsWith('--'));

const DAYS_ARG       = Number(arg('--days')         ?? 60);
const MIN_CMT        = Number(arg('--min-comments') ?? 1000);
const MIN_VIEWS      = Number(arg('--min-views')    ?? 0);
const TOP_N          = Number(arg('--top')          ?? 20);
const CAROUSELS_ONLY = process.argv.includes('--carousels-only');
const REELS_ONLY     = process.argv.includes('--reels-only');
const EXTRA_ACCOUNT  = arg('--account');
const JSON_OUT       = arg('--json'); // путь для полного дампа результатов
const NO_HASHTAGS    = process.argv.includes('--no-hashtags');   // пропустить хэштеги (экономия квоты)
const ONLY_ACCOUNT   = process.argv.includes('--only');          // с --account: только этот аккаунт
const DONORS_LIMIT   = Number(arg('--donors-limit') ?? 0);       // первые N доноров (0 = все)

// — режим глобального поиска —
const SEARCH_ON      = process.argv.includes('--search');
const SEARCH_QUERIES_ARG = argAll('--search');

const CUTOFF_TS = Math.floor(Date.now() / 1000) - DAYS_ARG * 86400;

// Сколько медиа тянуть за один запрос к хэштегу/аккаунту (баланс охват/квота).
const AMOUNT = 30;

// Фразы для глобального поиска рилсов (v2/fbsearch/reels), если --search без значения.
const SEARCH_QUERIES = [
  'ai agent', 'vibe coding',
];

// Ниша берётся из scripts/.niche.json (его заполняет мастер /setup). Файла нет —
// работают примеры ниже, но результат будет случайным: заполните конфиг.
let NICHE = {};
try {
  NICHE = JSON.parse(readFileSync(join(ROOT, 'scripts', '.niche.json'), 'utf8'));
} catch { /* конфига нет — идём на примерах */ }

// Ключевые слова для фильтра релевантности при обходе доноров и поиска.
// Порядок запасных вариантов важен: если у клиента не задано "keywords", берём
// его же хэштеги. Иначе донорские посты молча отсеиваются демо-списком AI-ниши,
// и обход доноров даёт ноль при исправных настройках.
const KEYWORDS = NICHE.keywords?.length ? NICHE.keywords
  : NICHE.hashtags?.length ? NICHE.hashtags
  : [
      'claude', 'anthropic', 'chatgpt', 'openai', 'ai agent', 'ai tools',
      'mcp server', 'mcp', 'vibe coding', 'vibecoding', 'automation', 'n8n',
    ];

// Пара примеров — замени на хэштеги своей ниши (или задай их в .niche.json).
const HASHTAGS = NICHE.hashtags?.length ? NICHE.hashtags : [
  'aitools', 'artificialintelligence',
];

// 3-5 публичных примеров AI-ниши — замени на аккаунты своей ниши.
const DONOR_ACCOUNTS = NICHE.donors?.length ? [...NICHE.donors] : [
  'openai',
  'nvidia',
  'huggingface',
  'midjourney',
  'deeplearningai',
];

if (EXTRA_ACCOUNT) DONOR_ACCOUNTS.push(EXTRA_ACCOUNT);

// ─── БЛОКЛИСТ: заполняй по мере того как посты уходят в работу (пусто по умолчанию) ──
const BLOCKED_ACCOUNTS = new Set();
const BLOCKED_CODES = new Set();

async function apiGet(path) {
  const r = await fetch(`https://api.hikerapi.com/${path}`, {
    headers: { 'x-access-key': KEY },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || body?.state === false) {
    throw new Error(body?.error || `${r.status}`);
  }
  return body;
}

// Ответы Hiker бывают то плоским массивом медиа, то вложены в data/items —
// собираем рекурсивно все объекты, похожие на media (code + media_type).
function collectMediaItems(node, out = [], depth = 0) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    for (const it of node) collectMediaItems(it, out, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    if (typeof node.code === 'string' && typeof node.media_type === 'number') {
      out.push(node);
      return out;
    }
    for (const v of Object.values(node)) collectMediaItems(v, out, depth + 1);
  }
  return out;
}

function getCaptionText(item) {
  return item.caption_text ?? '';
}

function matchesKeywords(text) {
  const lower = text.toLowerCase();
  return KEYWORDS.some(kw => lower.includes(kw));
}

function passesTypeFilter(media_type) {
  if (CAROUSELS_ONLY) return media_type === 8;
  if (REELS_ONLY)     return media_type === 2;
  return true;
}

function passesViewsFilter(item) {
  if (MIN_VIEWS === 0) return true;
  if (item.media_type !== 2) return true; // просмотры только у рилсов
  const views = item.play_count ?? item.view_count ?? 0;
  return views >= MIN_VIEWS;
}

function mediaTypeLabel(t) {
  if (t === 8) return 'карусель';
  if (t === 2) return 'рилс';
  if (t === 1) return 'фото';
  return `type${t}`;
}

// taken_at у Hiker бывает unix-секундами (taken_at_ts) или ISO-строкой (taken_at).
function takenAtSec(item) {
  if (typeof item.taken_at_ts === 'number') return item.taken_at_ts;
  if (item.taken_at) {
    const ms = Date.parse(item.taken_at);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

function formatDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fmtN(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

const found = new Map();

function addItem(item, requireKeywords = false) {
  const ts = takenAtSec(item);
  if (!ts || ts < CUTOFF_TS) return false;
  if (BLOCKED_CODES.has(item.code)) return false;
  if (BLOCKED_ACCOUNTS.has((item.user?.username ?? '').toLowerCase())) return false;
  if ((item.comment_count ?? 0) < MIN_CMT) return false;
  if (!passesTypeFilter(item.media_type)) return false;
  if (!passesViewsFilter(item)) return false;
  if (requireKeywords) {
    const text = getCaptionText(item);
    if (!matchesKeywords(text)) return false;
  }
  const id = item.id ?? item.pk ?? item.code;
  if (!found.has(id)) { found.set(id, item); return true; }
  return false;
}

async function searchHashtag(hashtag) {
  // `recent` у Hiker сейчас отдаёт пустой массив на живых хэштегах, `top` работает.
  // Идём по обоим: сначала топ, потом свежие — вдруг ветку починят.
  try {
    let items = [];
    for (const kind of ['top', 'recent']) {
      const d = await apiGet(`v1/hashtag/medias/${kind}?name=${encodeURIComponent(hashtag)}&amount=${AMOUNT}`)
        .catch(() => null);
      const got = collectMediaItems(d);
      if (got.length) { items = got; break; }
    }
    let added = 0;
    for (const item of items) if (addItem(item, false)) added++;
    return { total: items.length, matched: added };
  } catch (e) { return { error: e.message }; }
}

async function getUserId(username) {
  const d = await apiGet(`v1/user/by/username?username=${encodeURIComponent(username)}`);
  return d?.pk ?? d?.id ?? d?.user?.pk ?? null;
}

async function fetchUserMedia(username) {
  const uid = await getUserId(username);
  if (!uid) throw new Error('пользователь не найден');
  const [posts, clips] = await Promise.all([
    apiGet(`v1/user/medias?user_id=${uid}&amount=${AMOUNT}`).catch(() => null),
    apiGet(`v1/user/clips?user_id=${uid}&amount=${AMOUNT}`).catch(() => null),
  ]);
  return [...collectMediaItems(posts), ...collectMediaItems(clips)];
}

async function searchDonor(username) {
  try {
    const items = await fetchUserMedia(username);
    let added = 0;
    for (const item of items) if (addItem(item, true)) added++;
    return { total: items.length, matched: added };
  } catch (e) { return { error: e.message }; }
}

// ─── ПАРСИНГ КОНКРЕТНОГО АККАУНТА (без фильтра ключевых слов) ──────────────
async function parseAccount(username) {
  try {
    const items = await fetchUserMedia(username);
    let added = 0;
    for (const item of items) {
      const ts = takenAtSec(item);
      if (!ts || ts < CUTOFF_TS) continue;
      if ((item.comment_count ?? 0) < MIN_CMT) continue;
      if (!passesTypeFilter(item.media_type)) continue;
      if (!passesViewsFilter(item)) continue;
      const id = item.id ?? item.pk ?? item.code;
      if (!found.has(id)) { found.set(id, item); added++; }
    }
    return { total: items.length, matched: added };
  } catch (e) { return { error: e.message }; }
}

// ─── РЕЖИМ: глобальный поиск рилсов по фразе (v2/fbsearch/reels) ───────────
async function searchReelsQuery(query) {
  try {
    const d = await apiGet(`v2/fbsearch/reels?query=${encodeURIComponent(query)}`);
    const items = collectMediaItems(d);
    let added = 0;
    for (const item of items) if (addItem(item, true)) added++;
    return { total: items.length, matched: added };
  } catch (e) { return { error: e.message }; }
}

// ─── Main ──────────────────────────────────────────────────────────────────

const modeLabel = CAROUSELS_ONLY ? '  Режим: только карусели\n' :
                  REELS_ONLY     ? `  Режим: только рилсы${MIN_VIEWS ? ` (мин. ${fmtN(MIN_VIEWS)} просм.)` : ''}\n` :
                  '';

console.log(`\n  Instagram Viral Search — Hiker API`);
console.log(`  Период: последние ${DAYS_ARG} дней (с ${formatDate(CUTOFF_TS)})`);
console.log(`  Мин. комментариев: ${MIN_CMT}${MIN_VIEWS ? `  |  Мин. просмотров: ${fmtN(MIN_VIEWS)}` : ''}`);
if (modeLabel) process.stdout.write(modeLabel);
console.log();

if (!NO_HASHTAGS && !(ONLY_ACCOUNT && EXTRA_ACCOUNT)) {
  console.log('Хэштеги:');
  for (const ht of HASHTAGS) {
    process.stdout.write(`  #${ht}... `);
    const r = await searchHashtag(ht);
    console.log(r.error ? `❌ ${r.error.slice(0,60)}` : `${r.matched}/${r.total}`);
    await new Promise(res => setTimeout(res, 300));
  }
}

const donorList = ONLY_ACCOUNT && EXTRA_ACCOUNT
  ? [EXTRA_ACCOUNT]
  : (DONORS_LIMIT > 0 ? DONOR_ACCOUNTS.slice(0, DONORS_LIMIT) : DONOR_ACCOUNTS);
console.log(`\nАккаунты-доноры${DONORS_LIMIT ? ` (первые ${donorList.length})` : ''}:`);
for (const acc of donorList) {
  process.stdout.write(`  @${acc}... `);
  const r = EXTRA_ACCOUNT === acc ? await parseAccount(acc) : await searchDonor(acc);
  console.log(r.error ? `❌ ${r.error.slice(0,60)}` : `${r.matched}/${r.total}`);
  await new Promise(res => setTimeout(res, 500));
}

if (SEARCH_ON) {
  const queries = SEARCH_QUERIES_ARG.length ? SEARCH_QUERIES_ARG : SEARCH_QUERIES;
  console.log(`\nГлобальный поиск рилсов:`);
  for (const q of queries) {
    process.stdout.write(`  "${q}"... `);
    const r = await searchReelsQuery(q);
    console.log(r.error ? `❌ ${r.error.slice(0,60)}` : `${r.matched}/${r.total}`);
    await new Promise(res => setTimeout(res, 400));
  }
}

const results = Array.from(found.values())
  .sort((a, b) => (b.comment_count ?? 0) - (a.comment_count ?? 0))
  .slice(0, TOP_N);

// Ветка через if/else (не process.exit после fetch-цикла — на некоторых сборках
// Node форсированный process.exit() сразу после fetch() падает в libuv-ассерт
// на Windows). process.exitCode оставляем 0 по умолчанию в обеих ветках.
if (results.length === 0) {
  console.log(`\n  Ничего не найдено. Попробуй: --min-comments 500 или убери --min-views`);
} else {
  console.log(`\n  Найдено: ${found.size} уникальных → топ ${results.length}\n`);

  const W = { n:3, cmt:7, lk:7, views:8, type:9, date:11, acc:22, url:42 };
  const sep = '─'.repeat(Object.values(W).reduce((a,b)=>a+b,0) + 50);

  console.log(sep);
  console.log(
    '#'.padEnd(W.n) + 'Комм'.padEnd(W.cmt) + 'Лайки'.padEnd(W.lk) +
    'Просм'.padEnd(W.views) + 'Тип'.padEnd(W.type) + 'Дата'.padEnd(W.date) +
    'Аккаунт'.padEnd(W.acc) + 'Ссылка'.padEnd(W.url) + 'Подпись'
  );
  console.log(sep);

  for (let i = 0; i < results.length; i++) {
    const it = results[i];
    const url     = `https://www.instagram.com/p/${it.code}/`;
    const user    = (it.user?.username ?? 'unknown').slice(0, W.acc - 2);
    const ts      = takenAtSec(it);
    const date    = ts ? formatDate(ts) : '—';
    const type    = mediaTypeLabel(it.media_type);
    const views   = it.media_type === 2 ? fmtN(it.play_count ?? it.view_count ?? 0) : '—';
    const caption = getCaptionText(it).replace(/\n/g, ' ').slice(0, 55);

    console.log(
      String(i+1).padEnd(W.n) +
      fmtN(it.comment_count ?? 0).padEnd(W.cmt) +
      fmtN(it.like_count ?? 0).padEnd(W.lk) +
      views.padEnd(W.views) +
      type.padEnd(W.type) +
      date.padEnd(W.date) +
      user.padEnd(W.acc) +
      url.padEnd(W.url) +
      caption
    );
  }

  console.log(sep);

  if (JSON_OUT) {
    const { writeFileSync } = await import('fs');
    const dump = results.map(it => {
      const ts = takenAtSec(it);
      return {
        code: it.code,
        url: `https://www.instagram.com/p/${it.code}/`,
        user: it.user?.username ?? 'unknown',
        media_type: it.media_type,
        type: mediaTypeLabel(it.media_type),
        comments: it.comment_count ?? 0,
        likes: it.like_count ?? 0,
        views: it.media_type === 2 ? (it.play_count ?? it.view_count ?? 0) : null,
        date: ts ? formatDate(ts) : null,
        caption: getCaptionText(it).slice(0, 600),
        carousel_count: Array.isArray(it.resources) ? it.resources.length : null,
      };
    });
    writeFileSync(JSON_OUT, JSON.stringify(dump, null, 2));
    console.log(`\n  JSON: ${JSON_OUT} (${dump.length} записей)`);
  }

  const searchCount = SEARCH_ON ? (SEARCH_QUERIES_ARG.length || SEARCH_QUERIES.length) : 0;
  console.log(`\n  Охват: ${HASHTAGS.length} хэштегов + ${DONOR_ACCOUNTS.length} аккаунтов${searchCount ? ` + ${searchCount} поисковых фраз` : ''}`);
  console.log(`  Команда повтора: node scripts/search-instagram.mjs --days ${DAYS_ARG} --min-comments ${MIN_CMT}${MIN_VIEWS ? ` --min-views ${MIN_VIEWS}` : ''}${CAROUSELS_ONLY ? ' --carousels-only' : ''}${REELS_ONLY ? ' --reels-only' : ''} --top ${TOP_N}\n`);
}
