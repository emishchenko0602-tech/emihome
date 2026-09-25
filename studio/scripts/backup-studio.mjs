#!/usr/bin/env node
// Бэкап студии в личный приватный репозиторий на GitHub.
//
// Зачем: движки и навыки восстанавливаются клоном нашего репозитория, а вот
// реестр тем, кодовые слова, гайды и точка останова не восстанавливаются ничем.
// Сервер может исчезнуть по любой причине, включая неоплату — вместе с бэкапами,
// которые лежали на нём же. Поэтому копия держится снаружи.
//
// Режимы:
//   node scripts/backup-studio.mjs --init [<url>]   подключить репозиторий (один раз)
//   node scripts/backup-studio.mjs                  собрать и запушить
//   node scripts/backup-studio.mjs --dry            показать что уедет, без пуша
//   node scripts/backup-studio.mjs --restore        наложить бэкап на эту студию
//
// План: plans/2026-08-11-bekap-agenta-na-github.md

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'scripts', '.backup-config.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODE = has('--init') ? 'init' : has('--restore') ? 'restore' : has('--dry') ? 'dry' : 'push';

// ─── что уезжает ────────────────────────────────────────────────────────────
// Правило: сюда попадает только то, что не восстанавливается ничем другим.
// Готовые слайды и ролики не бэкапим — они уже в телеграме, на сайте и в соцсетях.

const TEXT_EXTS = new Set(['.json', '.md', '.txt', '.srt', '.vtt']);
// Движки. Исходная сборка приходит вместе с паком, но дописанное здесь —
// обтравка, поиск дублей, субтитры карточками — не приходит ниоткуда.
const CODE_EXTS = new Set(['.py', '.mjs', '.js']);

const RULES = [
  { from: 'HANDOFF.md', kind: 'file' },
  { from: 'workspace/registry.json', kind: 'file' },
  { from: 'workspace/captions', kind: 'dir', exts: TEXT_EXTS },
  { from: 'plans', kind: 'dir', exts: TEXT_EXTS },
  { from: 'workspace/carousel', kind: 'dir', exts: TEXT_EXTS },
  { from: 'workspace/reels', kind: 'dir', exts: TEXT_EXTS },
  { from: 'workspace/guides', kind: 'dir', exts: TEXT_EXTS },
  // Тексты постов и разборы ниши. Появились позже остального и в список не
  // попали: бэкап молча уезжал без них, хотя восстановить их неоткуда.
  { from: 'workspace/scripts-katerina', kind: 'dir', exts: TEXT_EXTS },
  { from: 'workspace/strategy', kind: 'dir', exts: TEXT_EXTS },
  { from: 'workspace/trends', kind: 'dir', exts: TEXT_EXTS },
  { from: 'site', kind: 'dir' }, // исходники сайта-витрины: гайды живут только тут
  { from: 'scripts', kind: 'dir', exts: CODE_EXTS }, // движки, включая дописанные
  { from: '.claude/skills', kind: 'dir', exts: new Set([...TEXT_EXTS, ...CODE_EXTS]) },
  { from: 'scripts/.f2-brand.json', kind: 'file' }, // бренд и хэндл, ключей внутри нет
  { from: 'scripts/.niche.json', kind: 'file' },    // аккаунты и хэштеги ниши
];

// Исключения зашиты в код, а не в конфиг: их нельзя отключить по невнимательности.
const NEVER = [
  /(^|[\\/])auth([\\/]|$)/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
  /(^|[\\/])\.next([\\/]|$)/i,
  /(^|[\\/])\.vercel([\\/]|$)/i,
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])\.env/i,
  /\.hiker-config\.json$/i,
  /\.rapidapi-config\.json$/i,
  /\.telegram-config\.json$/i,
  /\.fish-config\.json$/i,
  /(^|[\\/])\.mcp\.json$/i,
  /\.flow-geo\.json$/i,
  /\.(key|pem|pfx|p12)$/i,
];

const MAX_FILE_MB = 25;

// Маски секретов — те же, что в сборщике клиентского пака.
const SECRET_PATTERNS = [
  /cpk_[a-zA-Z0-9]{16,}/,
  /sk-[a-zA-Z0-9_\-]{20,}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /AIza[0-9A-Za-z_\-]{30,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /Bearer\s+(?!\{\{|<)[A-Za-z0-9_\-.]{20,}/,
  /\b\d{9,10}:[A-Za-z0-9_-]{34,}\b/,
  /"(API_KEY|apiKey|rapidApiKey|hikerApiKey|token|botToken|fishApiKey)"\s*:\s*"(?!\{\{|ВСТАВЬ|1234|AA\.)[A-Za-z0-9_\-]{24,}"/,
];
const SCAN_EXTS = new Set(['.md', '.mjs', '.js', '.ts', '.tsx', '.json', '.txt', '.ps1', '.py', '.css', '.yml', '.yaml']);

// Какие ключи придётся ввести заново — значения не сохраняем, только адреса.
const KEYS_TODO = [
  ['scripts/.telegram-config.json', 'токен бота и chat_id', '@BotFather в телеграме'],
  ['scripts/.hiker-config.json', 'ключ Hiker API (поиск и скачивание Instagram)', 'hikerapi.com, личный кабинет'],
  ['scripts/.rapidapi-config.json', 'ключ RapidAPI (Twitter/X и TikTok)', 'rapidapi.com → Social Download All In One'],
  ['auth/fish.key', 'ключ Fish Audio (клон голоса)', 'fish.audio → API keys'],
  ['scripts/.fish-config.json', 'id вашего клонированного голоса', 'создастся сам при повторном клонировании'],
  ['.mcp.json', 'ChatPlace, 21st.dev, Gemini — если пользуетесь', 'личные кабинеты сервисов'],
  ['auth/chrome-auto-profile', 'логин ChatGPT', 'войти руками, профили не переносятся'],
  ['auth/chrome-flow-profile', 'логин Google Flow', 'войти руками; аккаунт заводить на этой машине'],
];

// ─── утилиты ────────────────────────────────────────────────────────────────

const log = (s = '') => console.log(s);
const die = (s) => { console.error(`\n[СТОП] ${s}\n`); process.exit(1); };

function git(cwd, args, { quiet = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !quiet) {
    die(`git ${args.join(' ')}\n${(r.stderr || r.stdout || '').trim()}`);
  }
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const isExcluded = (rel) => NEVER.some((re) => re.test(rel));

function walk(dir, base, out, exts) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (isExcluded(rel) || isExcluded(entry.name)) continue;
    if (entry.isDirectory()) walk(abs, base, out, exts);
    else if (entry.isFile()) {
      if (exts && !exts.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(rel);
    }
  }
}

function collect() {
  const files = [];
  const skippedBig = [];
  for (const rule of RULES) {
    const abs = path.join(ROOT, rule.from);
    if (!fs.existsSync(abs)) continue;
    const found = [];
    if (rule.kind === 'file') found.push(rule.from);
    else walk(abs, ROOT, found, rule.exts);
    for (const rel of found) {
      const size = fs.statSync(path.join(ROOT, rel)).size;
      if (size > MAX_FILE_MB * 1024 * 1024) { skippedBig.push({ rel, size }); continue; }
      files.push({ rel, size });
    }
  }
  return { files, skippedBig };
}

function scanSecrets(files) {
  const hits = [];
  for (const { rel, size } of files) {
    if (!SCAN_EXTS.has(path.extname(rel).toLowerCase())) continue;
    if (size > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const re of SECRET_PATTERNS) {
      const m = text.match(re);
      if (m) {
        hits.push({ rel, line: text.slice(0, m.index).split('\n').length });
        break;
      }
    }
  }
  return hits;
}

const readConfig = () =>
  fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null;

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

// ─── режим --init ───────────────────────────────────────────────────────────

if (MODE === 'init') {
  const existing = readConfig();
  if (existing) {
    log(`Бэкап уже подключён: ${existing.url}`);
    log(`Рабочая копия: ${existing.dir}`);
    log('Чтобы сменить репозиторий — удалите scripts/.backup-config.json и повторите.');
    process.exit(0);
  }

  // Адресом считается любой аргумент, который не флаг: ссылка, ssh или локальный путь
  // (последнее нужно для проверки движка без создания репозитория на GitHub).
  let url = argv.find((a) => !a.startsWith('--'));
  const dir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'studio-backup');

  if (!url) {
    const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
    if (gh.status !== 0) {
      die(
        'Нужен адрес репозитория.\n' +
        '  Вариант 1: создайте на github.com приватный репозиторий (например studio-backup)\n' +
        '             и запустите: node scripts/backup-studio.mjs --init <ссылка .git>\n' +
        '  Вариант 2: авторизуйтесь в GitHub CLI (gh auth login) и повторите — репозиторий\n' +
        '             создастся сам.'
      );
    }
    log('Создаю приватный репозиторий studio-backup через gh…');
    const created = spawnSync('gh', ['repo', 'create', 'studio-backup', '--private', '--clone=false'], { encoding: 'utf8' });
    if (created.status !== 0) die(`gh repo create: ${(created.stderr || created.stdout).trim()}`);
    const who = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' });
    url = `https://github.com/${who.stdout.trim()}/studio-backup.git`;
  }

  if (fs.existsSync(path.join(dir, '.git'))) {
    log(`Рабочая копия уже есть: ${dir}`);
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const cl = spawnSync('git', ['clone', url, dir], { encoding: 'utf8' });
    if (cl.status !== 0) {
      // Пустой репозиторий клонируется с предупреждением — это нормально.
      if (!fs.existsSync(path.join(dir, '.git'))) die(`git clone: ${(cl.stderr || cl.stdout).trim()}`);
    }
    git(dir, ['checkout', '-B', 'main'], { quiet: true });
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ url, dir }, null, 2) + '\n', 'utf8');
  log('');
  log('Бэкап подключён.');
  log(`  репозиторий: ${url}`);
  log(`  рабочая копия: ${dir}`);
  log('Дальше — «сделай бэкап» в чате или node scripts/backup-studio.mjs');
  process.exit(0);
}

// ─── режим --restore ────────────────────────────────────────────────────────

if (MODE === 'restore') {
  const cfg = readConfig();
  if (!cfg) die('Бэкап не подключён. Сначала: node scripts/backup-studio.mjs --init <ссылка>');
  if (!fs.existsSync(path.join(cfg.dir, '.git'))) {
    fs.mkdirSync(path.dirname(cfg.dir), { recursive: true });
    const cl = spawnSync('git', ['clone', cfg.url, cfg.dir], { encoding: 'utf8' });
    if (cl.status !== 0) die(`git clone: ${(cl.stderr || cl.stdout).trim()}`);
  } else {
    git(cfg.dir, ['pull', '--ff-only', 'origin', 'main'], { quiet: true });
  }

  const payload = path.join(cfg.dir, 'studio');
  if (!fs.existsSync(payload)) die(`В бэкапе нет папки studio/ — похоже, пуш ещё ни разу не проходил (${cfg.dir})`);

  const restored = [];
  const stack = [payload];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(abs); continue; }
      const rel = path.relative(payload, abs);
      const dest = path.join(ROOT, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
      restored.push(rel.split(path.sep).join('/'));
    }
  }

  log(`Восстановлено файлов: ${restored.length}`);
  for (const rel of restored.slice(0, 20)) log(`  ${rel}`);
  if (restored.length > 20) log(`  … и ещё ${restored.length - 20}`);
  log('');
  log('Ключи и логины бэкап не хранит — что ввести заново, написано в KEYS-TODO.md');
  log(`  ${path.join(cfg.dir, 'KEYS-TODO.md')}`);
  process.exit(0);
}

// ─── режимы push и dry ──────────────────────────────────────────────────────

const cfg = readConfig();
if (!cfg && MODE === 'push') {
  die(
    'Бэкап не подключён.\n' +
    '  node scripts/backup-studio.mjs --init <ссылка на приватный репозиторий>\n' +
    '  или просто --init, если авторизован GitHub CLI (gh auth login).'
  );
}

const { files, skippedBig } = collect();
if (files.length === 0) die('Нечего бэкапить: ни один файл из списка не найден. Вы точно в корне студии?');

const total = files.reduce((s, f) => s + f.size, 0);
log(`Собрано файлов: ${files.length}, объём ${mb(total)} МБ`);
for (const { rel, size } of skippedBig) {
  log(`  ПРОПУЩЕН (больше ${MAX_FILE_MB} МБ, ${mb(size)}): ${rel}`);
}

// Потолок на объём. Разбухает обычно site/public — картинки гайдов копятся годами.
// В нашем же проекте public/ однажды дорос до 113 МБ незаметно, поэтому не молчим.
const totalMb = total / 1024 / 1024;
if (totalMb > 500) {
  const byDir = new Map();
  for (const { rel, size } of files) {
    const top = rel.split('/').slice(0, 2).join('/');
    byDir.set(top, (byDir.get(top) || 0) + size);
  }
  const heavy = [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.error('');
  console.error(`[СТОП] Бэкап вырос до ${mb(total)} МБ — это уже не бэкап состояния, а файлохранилище.`);
  console.error('Самое тяжёлое:');
  for (const [dir, size] of heavy) console.error(`  ${mb(size)} МБ  ${dir}`);
  console.error('');
  console.error('Скорее всего это картинки и видео в site/public. Пережмите их в webp,');
  console.error('уберите неиспользуемые — и повторите. Готовые ролики бэкапить не надо:');
  console.error('они уже в телеграм-боте, на сайте и в соцсетях.');
  process.exit(1);
}
if (totalMb > 150) {
  log(`ВНИМАНИЕ: объём ${mb(total)} МБ и растёт. Загляните в site/public — обычно тяжелеет он.`);
}

const hits = scanSecrets(files);
if (hits.length) {
  console.error('');
  console.error('[СТОП] Секрет-скан: в бэкап попало похожее на ключ. Пуш отменён.');
  for (const h of hits) console.error(`  ${h.rel}:${h.line}`);
  console.error('');
  console.error('Уберите ключ из файла (или файл из студии) и повторите.');
  process.exit(1);
}
log('Секрет-скан: чисто.');

if (MODE === 'dry') {
  log('');
  log('Режим --dry: ничего не отправлено. Состав:');
  for (const { rel } of files.slice(0, 40)) log(`  ${rel}`);
  if (files.length > 40) log(`  … и ещё ${files.length - 40}`);
  process.exit(0);
}

if (!fs.existsSync(path.join(cfg.dir, '.git'))) {
  die(`Рабочая копия бэкапа пропала: ${cfg.dir}\n  Повторите: node scripts/backup-studio.mjs --init ${cfg.url}`);
}

// Зеркалим: сначала чистим studio/, чтобы удалённые у нас файлы удалились и там.
const payload = path.join(cfg.dir, 'studio');
fs.rmSync(payload, { recursive: true, force: true });
for (const { rel } of files) {
  const dest = path.join(payload, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dest);
}

// Памятка по ключам — без значений, только где брать.
const keysMd = [
  '# Что ввести заново после восстановления',
  '',
  'Ключи и логины бэкап не хранит и хранить не будет: приватный репозиторий —',
  'это всё равно чужой сервер, а профили Chrome в `auth/` это живые сессии.',
  'Ниже — что понадобится и где это взять.',
  '',
  '| Файл | Что внутри | Где взять |',
  '|---|---|---|',
  ...KEYS_TODO.map(([f, what, where]) => `| \`${f}\` | ${what} | ${where} |`),
  '',
  'Список общий для всех сборок — строки про то, чем вы не пользуетесь, пропустите.',
  'Всё это создаёт мастер `/setup`: запустите его на новой машине и отвечайте на вопросы.',
  '',
].join('\n');
fs.writeFileSync(path.join(cfg.dir, 'KEYS-TODO.md'), keysMd, 'utf8');

fs.writeFileSync(
  path.join(cfg.dir, 'README.md'),
  [
    '# Бэкап студии',
    '',
    'Копия рабочего состояния контент-студии: реестр тем и кодовых слов, точка останова,',
    'исходники сайта-витрины, спеки каруселей и роликов, планы.',
    '',
    'Движки и навыки сюда не входят — они восстанавливаются клоном студии.',
    'Ключи и логины не входят тоже, см. `KEYS-TODO.md`.',
    '',
    '## Восстановление на новой машине',
    '',
    '```powershell',
    'git clone <ссылка-на-студию> C:\\studio',
    'cd C:\\studio',
    'claude',
    '```',
    '',
    'дальше в чате: `/setup`, затем «восстанови студию из бэкапа».',
    '',
  ].join('\n'),
  'utf8'
);

// Подпись коммита. На свежей машине глобальный git.user может быть не настроен —
// тогда коммит падает, а клиент видит стену английского текста вместо бэкапа.
// Берём подпись из самой студии, а если и там пусто — ставим служебную локально.
for (const [key, fallback] of [['user.name', 'studio backup'], ['user.email', 'backup@studio.local']]) {
  const has = git(cfg.dir, ['config', key], { quiet: true });
  if (has.ok && has.out) continue;
  const fromStudio = git(ROOT, ['config', key], { quiet: true });
  git(cfg.dir, ['config', key, fromStudio.ok && fromStudio.out ? fromStudio.out : fallback]);
}

git(cfg.dir, ['add', '-A']);
const status = git(cfg.dir, ['status', '--porcelain'], { quiet: true });
if (!status.out) {
  log('Изменений нет — бэкап уже актуален.');
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
const changed = status.out.split('\n').length;
git(cfg.dir, ['commit', '-m', `бэкап ${stamp} — файлов ${files.length}, изменений ${changed}`]);

const push = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: cfg.dir, encoding: 'utf8' });
if (push.status !== 0) {
  die(
    `Пуш не прошёл: ${(push.stderr || push.stdout).trim()}\n` +
    '  Коммит сохранён локально, данные не потеряны. Проверьте доступ к GitHub\n' +
    `  и повторите: git -C "${cfg.dir}" push -u origin main`
  );
}

log('');
log(`Бэкап уехал: ${cfg.url}`);
log(`  файлов ${files.length}, изменений в этот раз ${changed}, объём ${mb(total)} МБ`);
