#!/usr/bin/env node
/**
 * telegram-listen.mjs — живой слушатель Telegram-бота.
 *
 * Держит длинный опрос (long polling) и печатает КАЖДОЕ новое сообщение одной
 * строкой в stdout. Строка — это событие: её подхватывает Monitor и будит агента,
 * поэтому переписка идёт почти без задержки, а не раз в час.
 *
 * Запуск (обычно через Monitor, не руками):
 *   node scripts/telegram-listen.mjs
 *
 * Медиа скачивается в workspace/inbox/ (лимит Bot API — 20 МБ).
 * Offset общий с telegram-peek.mjs: два процесса разом запускать нельзя,
 * они начнут отбирать обновления друг у друга.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts', '.telegram-config.json'), 'utf8'));
const API = `https://api.telegram.org/bot${cfg.botToken}`;
const FILE_API = `https://api.telegram.org/file/bot${cfg.botToken}`;
const ALLOWED = new Set((cfg.chatIds ?? []).map(String));

const INBOX = join(ROOT, 'workspace', 'inbox');
mkdirSync(INBOX, { recursive: true });
const OFFSET_FILE = join(INBOX, '.offset');
let offset = existsSync(OFFSET_FILE) ? Number(readFileSync(OFFSET_FILE, 'utf8')) || 0 : 0;

function say(line) {
  process.stdout.write(line + '\n');
}

function pickFile(m) {
  if (m.photo?.length) return { id: m.photo[m.photo.length - 1].file_id, kind: 'фото', ext: 'jpg' };
  if (m.video) return { id: m.video.file_id, kind: `видео ${m.video.duration ?? '?'}с`, ext: 'mp4' };
  if (m.video_note) return { id: m.video_note.file_id, kind: 'кружок', ext: 'mp4' };
  if (m.voice) return { id: m.voice.file_id, kind: 'голосовое', ext: 'ogg' };
  if (m.audio) return { id: m.audio.file_id, kind: 'аудио', ext: 'mp3' };
  if (m.document) {
    const name = m.document.file_name || 'file';
    return { id: m.document.file_id, kind: `файл ${name}`, ext: name.split('.').pop() || 'bin' };
  }
  return null;
}

async function download(fileId, dest) {
  try {
    const info = await (await fetch(`${API}/getFile?file_id=${fileId}`)).json();
    if (!info.ok) return { ok: false, why: info.description || 'getFile отказал' };
    const res = await fetch(`${FILE_API}/${info.result.file_path}`);
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

say('СЛУШАТЕЛЬ ЗАПУЩЕН: жду сообщений в боте');

// Сбои сети не должны ронять слушателя: пауза растёт до минуты, потом держится.
let backoff = 2000;

for (;;) {
  try {
    const r = await fetch(`${API}/getUpdates?timeout=50&limit=20${offset ? `&offset=${offset}` : ''}`);
    const j = await r.json();

    if (!j.ok) {
      say(`ОШИБКА TELEGRAM: ${j.description}`);
      await new Promise(s => setTimeout(s, backoff));
      backoff = Math.min(backoff * 2, 60000);
      continue;
    }
    backoff = 2000;

    for (const u of j.result) {
      offset = u.update_id + 1;
      const m = u.message || u.edited_message;
      if (!m) continue;
      if (ALLOWED.size && !ALLOWED.has(String(m.chat?.id))) continue;

      const who = m.from?.first_name || m.from?.username || '?';
      const file = pickFile(m);

      if (file) {
        const name = `${m.date}-${m.message_id}.${file.ext}`;
        const res = await download(file.id, join(INBOX, name));
        say(res.ok
          ? `СООБЩЕНИЕ от ${who}: ${file.kind} -> workspace/inbox/${name}${m.caption ? ` | подпись: ${m.caption}` : ''}`
          : `СООБЩЕНИЕ от ${who}: ${file.kind}, скачать не вышло (${res.why})`);
      } else if (m.text) {
        say(`СООБЩЕНИЕ от ${who}: ${m.text}`);
      } else {
        say(`СООБЩЕНИЕ от ${who}: (без текста и вложений)`);
      }
    }

    if (j.result.length) writeFileSync(OFFSET_FILE, String(offset));
  } catch (e) {
    say(`ОБРЫВ СВЯЗИ: ${e.message}`);
    await new Promise(s => setTimeout(s, backoff));
    backoff = Math.min(backoff * 2, 60000);
  }
}
