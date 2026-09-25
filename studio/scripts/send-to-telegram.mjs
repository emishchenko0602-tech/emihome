/**
 * send-to-telegram.mjs
 * Отправляет готовые карусели + подписи в Telegram для ревью.
 * Все данные (подписи, форматы, пути, гайды) — из workspace/registry.json (единый реестр).
 *
 * Запуск:
 *   node scripts/send-to-telegram.mjs            # все карусели из реестра
 *   node scripts/send-to-telegram.mjs c1 c5      # выборочно по id
 *   node scripts/send-to-telegram.mjs --dry      # показать что уйдёт, без отправки
 *
 * После успешной отправки проставляет status.sentToTelegram в реестре.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts', '.telegram-config.json'), 'utf8'));
const BOT_TOKEN = cfg.botToken;
const CHAT_IDS  = cfg.chatIds;
const API       = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Подпись под сводкой — хэндл из бренда студии, а не захардкоженная строка.
let HANDLE = '';
try {
  HANDLE = JSON.parse(readFileSync(join(ROOT, 'scripts', '.f2-brand.json'), 'utf8')).handle || '';
} catch { /* бренда нет — сводка уйдёт без подписи */ }

const REGISTRY_PATH = join(ROOT, 'workspace', 'registry.json');
const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));

const ARGS = process.argv.slice(2).map(a => a.toLowerCase());
const DRY = ARGS.includes('--dry');
const ARG_FILTER = ARGS.filter(a => !a.startsWith('--'));

// ─── Telegram API (Node.js fetch + FormData) ─────────────────────────────────

async function tgRequest(method, formData) {
  const res = await fetch(`${API}/${method}`, { method: 'POST', body: formData });
  const json = await res.json();
  if (!json.ok) console.warn(`  ⚠️  [${method}]: ${json.description}`);
  return json;
}

async function sendText(chatId, text, html = true) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('text', text.slice(0, 4096));
  if (html) fd.append('parse_mode', 'HTML');
  return tgRequest('sendMessage', fd);
}

async function sendMediaGroup(chatId, files, caption = '') {
  if (files.length === 0) return;

  // Один файл — без группы
  if (files.length === 1) {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) fd.append('caption', caption.slice(0, 1024));
    const isVideo = files[0].endsWith('.mp4');
    fd.append(isVideo ? 'video' : 'photo',
      new Blob([readFileSync(files[0])], { type: isVideo ? 'video/mp4' : 'image/png' }),
      files[0].split(/[\\/]/).pop());
    return tgRequest(isVideo ? 'sendVideo' : 'sendPhoto', fd);
  }

  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  const media = [];

  for (let i = 0; i < files.length; i++) {
    if (!existsSync(files[i])) continue;
    const key = `file${i}`;
    const isVideo = files[i].endsWith('.mp4');
    fd.append(key,
      new Blob([readFileSync(files[i])], { type: isVideo ? 'video/mp4' : 'image/png' }),
      files[i].split(/[\\/]/).pop());
    media.push({
      type: isVideo ? 'video' : 'photo',
      media: `attach://${key}`,
      ...(i === 0 && caption ? { caption: caption.slice(0, 1024) } : {}),
    });
  }

  fd.append('media', JSON.stringify(media));
  return tgRequest('sendMediaGroup', fd);
}

// ─── Сбор файлов формата ─────────────────────────────────────────────────────

function formatFiles(fmt) {
  const dir = join(ROOT, fmt.dir);
  if (!existsSync(dir)) return { dir, files: [], missing: true };
  const files = readdirSync(dir)
    .filter(f => f.endsWith(`.${fmt.ext}`) && !f.startsWith('_') && !f.startsWith('debug'))
    .sort()
    .map(f => join(dir, f));
  return { dir, files, missing: false };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Реестр исторически хранит записи в "carousels"; свежий пак создаётся с "items".
const entries = registry.carousels ?? registry.items ?? [];

// Записи реестра заводят разные скиллы, и форма полей разошлась: /тренды пишет
// "title" и "formats": {}, а этот скрипт исторически ждёт "name" и массив
// форматов. Приводим к одному виду здесь, чтобы связка не падала на полпути.
function normalize(c) {
  const fmts = Array.isArray(c.formats)
    ? c.formats
    : Object.entries(c.formats ?? {}).map(([label, v]) =>
        typeof v === 'string' ? { label, dir: v, ext: 'png' } : { label, ext: 'png', ...v });
  return {
    ...c,
    id: c.id ?? c.slug,
    name: c.name ?? c.title ?? c.slug,
    formats: fmts.filter(f => f && f.dir),
  };
}
for (let i = 0; i < entries.length; i++) entries[i] = normalize(entries[i]);

const filtered = ARG_FILTER.length > 0
  ? entries.filter(c => ARG_FILTER.includes(c.id))
  : entries;

if (filtered.length === 0) {
  if (entries.length === 0) {
    console.log('📒 Реестр пуст — отправлять пока нечего.');
    console.log(`   Конфиг прочитан, chat_id: ${CHAT_IDS.join(', ')}`);
    process.exit(0);
  }
  console.error(`⚠️  Ничего не найдено по фильтру: ${ARG_FILTER.join(', ')}`);
  console.error(`   Доступные id: ${entries.map(c => c.id).join(', ')}`);
  process.exit(1);
}

console.log(`\n🚀 ${DRY ? '[DRY RUN] ' : ''}Отправка в Telegram (${filtered.length} карусел${filtered.length === 1 ? 'ь' : 'и'})`);
console.log(`   Chat IDs: ${CHAT_IDS.join(', ')}\n`);

if (DRY) {
  for (const c of filtered) {
    console.log(`\n  ${c.name} (kw: ${c.keyword || '—'})`);
    for (const fmt of c.formats) {
      const { files, missing } = formatFiles(fmt);
      console.log(`    ${missing ? '❌ нет папки' : files.length === 0 ? '⚠️  пусто' : `✅ ${files.length} файлов`} — ${fmt.label} (${fmt.dir})`);
    }
    console.log(`    ${c.guideUrl ? `🔗 ${c.guideUrl}` : '⏭  гайд не собран'}`);
  }
  console.log('\n✅ Dry run завершён, ничего не отправлено.');
  process.exit(0);
}

const sentIds = new Set();

for (const chatId of CHAT_IDS) {
  console.log(`\n📬 Чат ${chatId}:`);

  // Вводное сообщение
  await sendText(chatId,
    `<b>🚀 MassMedia Studio — готовые материалы</b>\n` +
    `${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}\n\n` +
    filtered.map(c => `${c.name}`).join('\n'));
  await new Promise(r => setTimeout(r, 1000));

  for (const c of filtered) {
    console.log(`\n  ${c.name}`);

    // Подпись поста
    await sendText(chatId, `${c.name}\n\n<b>📝 Подпись Instagram:</b>\n\n${c.caption || ''}`);
    await new Promise(r => setTimeout(r, 1000));

    // Каждый формат
    for (const fmt of c.formats) {
      const { files, missing } = formatFiles(fmt);
      if (missing) {
        console.log(`    ⚠️  Папка не найдена: ${fmt.dir}`);
        continue;
      }
      if (files.length === 0) {
        console.log(`    ⚠️  Нет файлов: ${fmt.dir}`);
        continue;
      }

      console.log(`    📤 ${fmt.label}: ${files.length} файлов`);

      // Батчи по 10
      for (let i = 0; i < files.length; i += 10) {
        const batch = files.slice(i, i + 10);
        const albumCaption = i === 0 ? `${c.name} · ${fmt.label}` : '';
        await sendMediaGroup(chatId, batch, albumCaption);
        await new Promise(r => setTimeout(r, 3000));
        console.log(`    ✅ ${Math.min(i + 10, files.length)}/${files.length} отправлено`);
      }
      sentIds.add(c.id);
    }

    // Ссылка на гайд на сайте (пропускаем если гайд ещё не собран)
    if (c.guideUrl) {
      await sendText(chatId, `📖 <b>Полный гайд на сайте:</b>\n${c.guideUrl}`);
      console.log(`    🔗 Ссылка на гайд отправлена`);
    } else {
      console.log(`    ⏭  Гайд ещё не собран — ссылку не шлю`);
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  // Итог: список воронок генерится из реестра (kw → слаг), не хардкод
  const funnelLines = filtered
    .filter(c => c.keyword)
    .map(c => `• ${c.keyword} → ${c.slug}`);
  await sendText(chatId,
    `✅ <b>Отправлено: ${filtered.map(c => c.id.toUpperCase()).join(', ')}</b>\n\n` +
    (funnelLines.length ? `Код-слова воронок:\n${funnelLines.join('\n')}\n\n` : '') +
    HANDLE);
}

// Отметить дату отправки в реестре
if (sentIds.size > 0) {
  const today = new Date().toISOString().slice(0, 10);
  for (const c of entries) {
    if (sentIds.has(c.id)) c.status.sentToTelegram = today;
  }
  registry.updated = today;
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
  console.log(`\n📒 Реестр обновлён: sentToTelegram=${today} для ${[...sentIds].join(', ')}`);
}

console.log('\n✅ Всё отправлено в Telegram!');
