#!/usr/bin/env node
/**
 * telegram-peek.mjs — забирает накопившееся из Telegram-бота.
 *
 * Зачем: бот односторонний, слушателя у него нет. Сообщения клиента лежат в
 * очереди Telegram и пропадают примерно через сутки. Этот скрипт их вычитывает,
 * медиа кладёт на диск, а текст печатает сводкой — так ничего не теряется,
 * даже если сессию не открывали.
 *
 * Запуск:
 *   node scripts/telegram-peek.mjs            сводка по новым сообщениям
 *   node scripts/telegram-peek.mjs --quiet    молчит, когда пусто (для хука)
 *   node scripts/telegram-peek.mjs --peek     не сдвигать offset (только посмотреть)
 *   node scripts/telegram-peek.mjs --hook     то же, но выводом в формате SessionStart-хука
 *
 * Медиа падает в workspace/inbox/. Лимит Bot API на скачивание — 20 МБ.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = join(ROOT, 'scripts', '.telegram-config.json');

const argv = process.argv.slice(2);
// --hook подразумевает --quiet: на старте сессии пустой бот не повод шуметь.
const HOOK = argv.includes('--hook');
const QUIET = argv.includes('--quiet') || HOOK;
const PEEK = argv.includes('--peek');

// В режиме хука копим строки и отдаём одним JSON, который Claude Code кладёт
// в контекст. Иначе печатаем как есть.
const buf = [];
const out = (line) => (HOOK ? buf.push(line) : console.log(line));
function flush() {
  if (!HOOK || buf.length === 0) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: buf.join('\n'),
    },
  }));
}

if (!existsSync(CFG)) {
  if (!QUIET) console.error('нет scripts/.telegram-config.json — запустите /setup');
  process.exit(QUIET ? 0 : 1);
}

const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const API = `https://api.telegram.org/bot${cfg.botToken}`;
const FILE_API = `https://api.telegram.org/file/bot${cfg.botToken}`;
const ALLOWED = new Set((cfg.chatIds ?? []).map(String));

const INBOX = join(ROOT, 'workspace', 'inbox');
mkdirSync(INBOX, { recursive: true });
const OFFSET_FILE = join(INBOX, '.offset');
const offset = existsSync(OFFSET_FILE) ? Number(readFileSync(OFFSET_FILE, 'utf8')) || 0 : 0;

// Файл берём самый крупный из доступных: у фото это последний размер в массиве.
function pickFile(m) {
  if (m.photo?.length) return { id: m.photo[m.photo.length - 1].file_id, kind: 'фото', ext: 'jpg' };
  if (m.video) return { id: m.video.file_id, kind: `видео ${m.video.duration ?? '?'}с`, ext: 'mp4' };
  if (m.video_note) return { id: m.video_note.file_id, kind: 'кружок', ext: 'mp4' };
  if (m.voice) return { id: m.voice.file_id, kind: 'голосовое', ext: 'ogg' };
  if (m.audio) return { id: m.audio.file_id, kind: 'аудио', ext: 'mp3' };
  if (m.document) {
    const name = m.document.file_name || 'file';
    return { id: m.document.file_id, kind: `файл ${name}`, ext: (name.split('.').pop() || 'bin') };
  }
  return null;
}

async function download(fileId, dest) {
  const info = await (await fetch(`${API}/getFile?file_id=${fileId}`)).json();
  if (!info.ok) return { ok: false, why: info.description || 'getFile отказал' };
  const res = await fetch(`${FILE_API}/${info.result.file_path}`);
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return { ok: true, bytes: info.result.file_size ?? 0 };
}

const j = await (await fetch(`${API}/getUpdates?limit=100${offset ? `&offset=${offset}` : ''}`)).json();
if (!j.ok) {
  if (!QUIET) console.error(`Telegram отказал: ${j.description}`);
  process.exit(QUIET ? 0 : 1);
}

const msgs = j.result
  .map(u => u.message || u.edited_message)
  .filter(m => m && (ALLOWED.size === 0 || ALLOWED.has(String(m.chat?.id))));

if (msgs.length === 0) {
  if (!QUIET) console.log('в боте пусто');
  process.exit(0);
}

out(`НОВОЕ В БОТЕ: ${msgs.length} сообщ.`);

for (const m of msgs) {
  const when = new Date(m.date * 1000).toLocaleString('ru-RU');
  const who = m.from?.first_name || m.from?.username || '?';
  const file = pickFile(m);

  if (file) {
    const name = `${m.date}-${m.message_id}.${file.ext}`;
    const dest = join(INBOX, name);
    const r = await download(file.id, dest);
    const size = r.ok ? ` (${(r.bytes / 1048576).toFixed(1)} МБ)` : '';
    out(`  [${when}] ${who}: ${file.kind}${size}`);
    out(r.ok
      ? `      сохранено: workspace/inbox/${name}`
      : `      скачать не вышло: ${r.why}. Файлы больше 20 МБ Bot API не отдаёт`);
    if (m.caption) out(`      подпись: ${m.caption}`);
  } else if (m.text) {
    out(`  [${when}] ${who}: ${m.text}`);
  } else {
    out(`  [${when}] ${who}: (сообщение без текста и вложений)`);
  }
}

// Сдвигаем offset только после того, как всё скачано: упадём на середине —
// в следующий раз заберём заново, а не потеряем.
if (!PEEK && j.result.length) {
  writeFileSync(OFFSET_FILE, String(j.result[j.result.length - 1].update_id + 1));
}

flush();
