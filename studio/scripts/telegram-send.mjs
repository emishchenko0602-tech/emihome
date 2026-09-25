#!/usr/bin/env node
/**
 * telegram-send.mjs — ответ в Telegram-бот.
 *
 * Пара к telegram-listen.mjs: тот приносит сообщения, этот отправляет ответ.
 *
 * Запуск:
 *   node scripts/telegram-send.mjs "текст ответа"
 *   node scripts/telegram-send.mjs --file путь/к/файлу.png "подпись"
 *   echo "текст" | node scripts/telegram-send.mjs      (читает stdin)
 *
 * Адресат — chatIds из scripts/.telegram-config.json.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts', '.telegram-config.json'), 'utf8'));
const API = `https://api.telegram.org/bot${cfg.botToken}`;
const CHATS = (cfg.chatIds ?? []).map(String);

const argv = process.argv.slice(2);
const fileIdx = argv.indexOf('--file');
const filePath = fileIdx >= 0 ? argv[fileIdx + 1] : null;
// Важно: при отсутствии --file fileIdx равен -1, и fileIdx+1 указал бы на 0,
// то есть съел бы первый аргумент с текстом. Исключаем только когда флаг реально есть.
const skip = fileIdx >= 0 ? new Set([fileIdx, fileIdx + 1]) : new Set();
const asFile = argv.includes('--as-file');
const textArgs = argv.filter((a, i) => !skip.has(i) && !a.startsWith('--'));

let text = textArgs.join(' ').trim();
if (!text && !process.stdin.isTTY) {
  text = readFileSync(0, 'utf8').trim();
}

if (!text && !filePath) {
  console.error('нечего отправлять: укажите текст или --file');
  process.exit(1);
}
if (CHATS.length === 0) {
  console.error('в .telegram-config.json нет chatIds');
  process.exit(1);
}

// Telegram режет сообщения длиннее 4096 символов, поэтому бьём сами по абзацам:
// иначе хвост ответа молча пропадёт.
function chunks(s, max = 4000) {
  const out = [];
  let cur = '';
  for (const para of s.split('\n\n')) {
    if ((cur + '\n\n' + para).length > max && cur) { out.push(cur); cur = para; }
    else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) out.push(cur);
  return out.length ? out : [s.slice(0, max)];
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4' };

let failed = 0;

for (const chat of CHATS) {
  if (filePath) {
    if (!existsSync(filePath)) { console.error(`нет файла: ${filePath}`); process.exit(1); }
    const ext = extname(filePath).toLowerCase();
    // Телеграм пережимает всё, что отправлено как видео или фото. Для приёмки
    // это выдаёт чужой брак за наш: человек видит мыло и думает, что так собрано.
    // --as-file отправляет документом, файл доходит байт в байт.
    const isVideo = ext === '.mp4' && !asFile;
    const method = asFile ? 'sendDocument' : isVideo ? 'sendVideo' : MIME[ext] ? 'sendPhoto' : 'sendDocument';
    const field = asFile ? 'document' : isVideo ? 'video' : MIME[ext] ? 'photo' : 'document';

    const fd = new FormData();
    fd.append('chat_id', chat);
    if (text) fd.append('caption', text.slice(0, 1024));
    fd.append(field, new Blob([readFileSync(filePath)], { type: MIME[ext] || 'application/octet-stream' }), basename(filePath));

    const j = await (await fetch(`${API}/${method}`, { method: 'POST', body: fd })).json();
    console.log(j.ok ? `отправлено (${field}) в ${chat}` : `ошибка: ${j.description}`);
    if (!j.ok) failed++;
    continue;
  }

  for (const part of chunks(text)) {
    const j = await (await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: part }),
    })).json();
    console.log(j.ok ? `отправлено в ${chat} (${part.length} симв.)` : `ошибка: ${j.description}`);
    if (!j.ok) failed++;
  }
}

process.exitCode = failed ? 1 : 0;
