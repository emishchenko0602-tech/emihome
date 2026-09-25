/**
 * reel-inbox.mjs — приёмник видео из Telegram-бота.
 * Long-poll getUpdates: видео/кружок/документ-видео от разрешённых chat_id →
 * скачивает в workspace/reels/_inbox/ и пишет в stdout строку "SAVED <путь>".
 * Лимит Bot API на скачивание — 20 МБ (файлы больше — просим переслать «как видео»).
 * Запуск: node scripts/reel-inbox.mjs
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { collectState } from './pipeline-status.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts', '.telegram-config.json'), 'utf8'));
const API = `https://api.telegram.org/bot${cfg.botToken}`;
const FILE_API = `https://api.telegram.org/file/bot${cfg.botToken}`;
const ALLOWED = new Set((cfg.chatIds ?? []).map(String));
const INBOX = join(ROOT, 'workspace', 'reels', '_inbox');
mkdirSync(INBOX, { recursive: true });

const OFFSET_FILE = join(INBOX, '.offset');
let offset = existsSync(OFFSET_FILE) ? Number(readFileSync(OFFSET_FILE, 'utf8')) : 0;

const reply = (chatId, text) =>
  fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});

// ─── команды конвейера (текстовые сообщения) ────────────────────────────────
// «беру N СЛОВО» — выбор из утреннего дайджеста → queue.json + скачивание рефа
// «задача: …»    — свободное задание в очередь конвейера
// «статус»       — сводка pipeline-status прямо в бот
const PIPE_DIR = join(ROOT, 'workspace', 'pipeline');
mkdirSync(PIPE_DIR, { recursive: true });
const QUEUE_FILE = join(PIPE_DIR, 'queue.json');
const DIGEST_FILE = join(PIPE_DIR, 'digest-latest.json');
const NEWS_FILE = join(PIPE_DIR, 'news-latest.json');
const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };

function pushQueue(item) {
  const q = readJson(QUEUE_FILE, []);
  const id = (q.at(-1)?.id ?? 0) + 1;
  q.push({ id, ...item, pickedAt: new Date().toISOString().slice(0, 16).replace('T', ' '), status: 'queued', source: 'bot' });
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
  return id;
}

// Пересланный пост из канала — запоминаем источник (id/@username/название).
// Без этого канал никак не найти: getChat требует идентификатор, а апдейт
// «бота сделали админом» приходит типом my_chat_member, который мы не слушаем.
const CHANNELS_FILE = join(PIPE_DIR, 'channels.json');
function noteForward(msg) {
  const o = msg.forward_origin;
  const src = (o?.type === 'channel' ? o.chat : null) ?? msg.sender_chat ?? null;
  if (!src || src.type !== 'channel') return null;
  const list = readJson(CHANNELS_FILE, []);
  const rec = {
    id: src.id,
    title: src.title ?? null,
    username: src.username ?? null,
    lastPostId: o?.message_id ?? null,
    seenAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
  };
  const i = list.findIndex((x) => x.id === rec.id);
  if (i >= 0) list[i] = { ...list[i], ...rec }; else list.push(rec);
  writeFileSync(CHANNELS_FILE, JSON.stringify(list, null, 2));
  console.log(`CHANNEL ${rec.id} «${rec.title ?? '-'}»${rec.username ? ' @' + rec.username : ''} post=${rec.lastPostId ?? '-'}`);
  return rec;
}

// Пост в канале, где бот админ, прилетает типом channel_post — копим ленту,
// чтобы был свой архив постов для анализа (Bot API историю читать не умеет).
const POSTS_FILE = join(PIPE_DIR, 'channel-posts.jsonl');
function noteChannelPost(post) {
  const chat = post.chat ?? {};
  if (chat.type !== 'channel') return;
  noteForward({ sender_chat: chat });
  const rec = {
    channelId: chat.id,
    messageId: post.message_id,
    date: new Date(post.date * 1000).toISOString(),
    text: post.text ?? post.caption ?? null,
    media: post.video ? 'video' : post.photo ? 'photo' : post.document ? 'document' : null,
    views: post.views ?? null,
  };
  appendFileSync(POSTS_FILE, JSON.stringify(rec) + '\n');
  console.log(`POST ${rec.channelId}/${rec.messageId}: ${(rec.text ?? rec.media ?? '').slice(0, 80)}`);
}

const HINT = `Не понял команду 🤔\nМожно так:\n«беру 2 ТОКЕН» — взять виралку №2 из дайджеста со словом ТОКЕН\n«новость 3» — сделать контент по новости №3 дня\n«слово 3 АГЕНТ» — задать слово задаче #3\n«задача: …» — свободное задание в очередь\n«статус» — сводка конвейера\n(голосом тоже можно — распознаю)\nВидео/фото — просто кидай, приму в _inbox.`;
const cleanKw = (s) => s ? s.replace(/[^A-Za-zА-Яа-яЁё0-9_]/g, '').toUpperCase() : null;

// Возвращает true, если распознал и выполнил команду; false — если это не команда.
async function handleText(chatId, raw) {
  const text = raw.trim();
  console.log(`TEXT from ${chatId}: ${text.slice(0, 120)}`);

  // «беру 2 ТОКЕН» / «возьми 2, слово ТОКЕН» / «бери 2» — глагол + номер (+ опц. слово)
  const pick = text.match(/(?:беру|бери|возьми|взять)\D{0,6}(\d+)[\s.,:;·—–-]*(?:слово\s+)?([A-Za-zА-Яа-яЁё0-9_]{2,})?/i);
  if (pick) {
    const digest = readJson(DIGEST_FILE, null);
    const item = digest?.items?.find((i) => i.n === Number(pick[1]));
    if (!item) { await reply(chatId, `❓ В дайджесте нет №${pick[1]} (последний: ${digest?.date ?? 'ещё не было'}). Пришли «статус» или дождись утреннего дайджеста.`); return true; }
    const keyword = cleanKw(pick[2]);
    const id = pushQueue({ type: 'viral', ref: item.url, code: item.code, account: item.user, mediaType: item.type, keyword });
    const args = ['scripts/download-social.mjs', item.url, '--out', `workspace/pipeline/refs/${item.code}/`];
    if (item.media_type === 8) args.splice(2, 0, '--all');
    try { spawn('node', args, { cwd: ROOT, detached: true, stdio: 'ignore' }).unref(); } catch {}
    console.log(`QUEUE #${id} viral ${item.code} kw=${keyword ?? '-'}`);
    await reply(chatId, `✅ #${id} в конвейере: @${item.user} · ${item.type}${keyword ? ` · слово «${keyword}»` : '\n➕ слово добавь: «слово ' + id + ' ХХХ»'}\n⬇ Реф качаю в фоне → refs/${item.code}/`);
    return true;
  }

  // «новость 3» / «новость 3 СЛОВО» — сделать контент по новости дня
  const news = text.match(/(?:новост[ьи]|news)\D{0,4}(\d+)[\s.,:;·—–-]*(?:слово\s+)?([A-Za-zА-Яа-яЁё0-9_]{2,})?/i);
  if (news) {
    const nd = readJson(NEWS_FILE, null);
    const item = nd?.items?.find((i) => i.n === Number(news[1]));
    if (!item) { await reply(chatId, `❓ В новостях дня нет №${news[1]} (последние: ${nd?.date ?? 'ещё не было'}).`); return true; }
    const keyword = cleanKw(news[2]);
    const id = pushQueue({ type: 'news', title: item.title, ref: item.url, topic: item.topic, points: item.points, keyword });
    console.log(`QUEUE #${id} news: ${item.title.slice(0, 70)}`);
    await reply(chatId, `📰 #${id} в конвейере — контент по новости:\n«${item.title.slice(0, 120)}»${keyword ? `\n🔑 слово «${keyword}»` : ''}\n${item.url}\nВозьму в начале сессии (решу формат: карусель / инфографика / рилс).`);
    return true;
  }

  // «слово 3 АГЕНТ» — задать кодовое слово записи в очереди
  const word = text.match(/(?:слово|кодовое)\D{0,3}(\d+)\s+([A-Za-zА-Яа-яЁё0-9_]{2,})/i);
  if (word) {
    const q = readJson(QUEUE_FILE, []);
    const it = q.find((x) => x.id === Number(word[1]));
    if (!it) { await reply(chatId, `❓ В очереди нет #${word[1]}`); return true; }
    it.keyword = cleanKw(word[2]);
    writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
    await reply(chatId, `🔑 #${it.id}: слово «${it.keyword}»`);
    return true;
  }

  // «задача: …» — свободное задание в очередь
  const task = text.match(/^задач[ауи][:\s]+([\s\S]+)/i);
  if (task) {
    const id = pushQueue({ type: 'task', text: task[1].trim().slice(0, 500) });
    console.log(`QUEUE #${id} task: ${task[1].trim().slice(0, 60)}`);
    await reply(chatId, `📋 Задача #${id} в очереди конвейера. Возьму её в начале сессии.`);
    return true;
  }

  // «статус» — сводка конвейера
  if (/^\/?(статус|status)\b/i.test(text)) {
    try {
      const st = collectState();
      const stuck = st.entries.filter((e) => !e.done);
      const q = readJson(QUEUE_FILE, []).filter((x) => x.status === 'queued');
      const top = stuck.slice().sort((a, b) => a.remaining.length - b.remaining.length).slice(0, 5)
        .map((e) => `· ${e.slug} — осталось: ${e.remaining.join(', ')}`).join('\n');
      await reply(chatId, `📦 Конвейер: всего ${st.entries.length}, готово ${st.entries.length - stuck.length}, в работе ${stuck.length}\n⬇ Очередь из бота: ${q.length}\n\nБлижайшие к финишу:\n${top || '—'}`);
    } catch (e) { await reply(chatId, `❌ статус: ${String(e.message).slice(0, 100)}`); }
    return true;
  }

  if (/^\/?(помощь|help|start|команды)\b/i.test(text)) { await reply(chatId, HINT); return true; }
  return false; // не команда
}

function pickMedia(msg) {
  if (msg.video) return { f: msg.video, kind: 'video', name: msg.video.file_name };
  if (msg.video_note) return { f: msg.video_note, kind: 'video_note', name: null };
  if (msg.document && /video|mp4|quicktime/i.test(msg.document.mime_type ?? ''))
    return { f: msg.document, kind: 'document', name: msg.document.file_name };
  if (msg.animation) return { f: msg.animation, kind: 'animation', name: msg.animation.file_name };
  if (msg.voice) return { f: msg.voice, kind: 'voice', name: null };            // голосовое (ogg/opus)
  if (msg.audio) return { f: msg.audio, kind: 'audio', name: msg.audio.file_name };
  if (msg.photo && msg.photo.length) return { f: msg.photo[msg.photo.length - 1], kind: 'photo', name: null }; // фото — крупнейший размер
  if (msg.document && /image|png|jpe?g|webp/i.test(msg.document.mime_type ?? ''))
    return { f: msg.document, kind: 'document', name: msg.document.file_name };  // картинка документом (без сжатия)
  return null;
}

console.log(`[inbox] слушаю бота, папка: ${INBOX}`);

while (true) {
  try {
    const r = await fetch(`${API}/getUpdates?timeout=50&offset=${offset + 1}&allowed_updates=["message","channel_post","edited_channel_post","my_chat_member"]`, { signal: AbortSignal.timeout(65000) });
    const j = await r.json();
    if (!j.ok) { console.error('[inbox] getUpdates:', j.description); await new Promise(s => setTimeout(s, 5000)); continue; }
    for (const u of j.result) {
      offset = Math.max(offset, u.update_id);
      writeFileSync(OFFSET_FILE, String(offset));
      if (u.channel_post || u.edited_channel_post) { noteChannelPost(u.channel_post ?? u.edited_channel_post); continue; }
      if (u.my_chat_member?.chat?.type === 'channel') {
        noteForward({ sender_chat: u.my_chat_member.chat });
        continue;
      }
      const msg = u.message;
      if (!msg) continue;
      const chatId = String(msg.chat?.id ?? '');
      if (!ALLOWED.has(chatId)) continue;
      const fwd = noteForward(msg);
      const media = pickMedia(msg);
      if (!media) {
        if (msg.text) {
          const ok = await handleText(chatId, msg.text.trim());
          if (!ok) {
            await reply(chatId, fwd
              ? `📡 Канал запомнил: «${fwd.title ?? fwd.id}»${fwd.username ? ' @' + fwd.username : ''} (id ${fwd.id}). Пост принял.`
              : HINT);
          }
        } else if (fwd) {
          await reply(chatId, `📡 Канал запомнил: «${fwd.title ?? fwd.id}»${fwd.username ? ' @' + fwd.username : ''} (id ${fwd.id}).`);
        }
        continue;
      }

      const sizeMb = (media.f.file_size ?? 0) / 1024 / 1024;
      if (sizeMb > 19.5) {
        await reply(chatId, `⚠️ Файл ${sizeMb.toFixed(1)} МБ — больше лимита бота (20 МБ). Пришли «как видео» (со сжатием) или кинь файл в Загрузки.`);
        console.log(`TOOBIG ${sizeMb.toFixed(1)}MB from ${chatId}`);
        continue;
      }
      try {
        const gf = await (await fetch(`${API}/getFile?file_id=${media.f.file_id}`)).json();
        if (!gf.ok) throw new Error(gf.description);
        const ext = (media.name?.match(/\.\w+$/)?.[0]) || (gf.result.file_path.match(/\.\w+$/)?.[0]) || '.mp4';
        const stamp = new Date(msg.date * 1000).toISOString().slice(0, 16).replace(/[T:]/g, '-');
        const base = (media.name ?? media.kind).replace(/\.\w+$/, '').replace(/[^\wа-яА-ЯёЁ-]+/g, '_').slice(0, 40);
        const out = join(INBOX, `${stamp}-${base}${ext}`);
        const buf = Buffer.from(await (await fetch(`${FILE_API}/${gf.result.file_path}`)).arrayBuffer());
        writeFileSync(out, buf);

        // Голос/аудио — сначала распознаём и пробуем как команду конвейера.
        if (media.kind === 'voice' || media.kind === 'audio') {
          const tr = spawnSync('python', [join(ROOT, 'scripts', 'pipeline', 'transcribe-voice.py'), out], { encoding: 'utf8', timeout: 120000 });
          const transcript = (tr.stdout || '').trim();
          console.log(`VOICE ${out} → «${transcript.slice(0, 120)}»`);
          if (transcript) {
            const isCmd = await handleText(chatId, transcript);
            if (isCmd) { try { rmSync(out); } catch {} continue; }        // была короткая команда — файл не нужен
            // свободная речь = задача в очередь (так ставятся задания голосом)
            const id = pushQueue({ type: 'task', text: transcript, voice: base + ext });
            console.log(`QUEUE #${id} voice-task: ${transcript.slice(0, 80)}`);
            await reply(chatId, `🎤 Расслышал и поставил задачу #${id} в очередь:\n«${transcript.slice(0, 300)}${transcript.length > 300 ? '…' : ''}»\nВозьму в начале сессии. (Голос сохранил в _inbox.)`);
          } else {
            await reply(chatId, `🎤 Голос принял, но не разобрал речь. Сохранил как контент.`);
          }
          continue;
        }

        await reply(chatId, `✅ Принял: ${base}${ext} (${sizeMb.toFixed(1)} МБ). Взял в работу.`);
        console.log(`SAVED ${out} (${sizeMb.toFixed(1)}MB)${msg.caption ? ' caption: ' + msg.caption.slice(0, 80) : ''}`);
      } catch (e) {
        await reply(chatId, `❌ Не смог скачать: ${String(e.message).slice(0, 100)}`);
        console.log(`ERROR ${String(e.message).slice(0, 120)}`);
      }
    }
  } catch (e) {
    if (!/timeout|aborted/i.test(String(e))) console.error('[inbox]', String(e).slice(0, 120));
    await new Promise(s => setTimeout(s, 3000));
  }
}
