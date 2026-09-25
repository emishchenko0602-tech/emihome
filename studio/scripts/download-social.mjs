/**
 * download-social.mjs (клиентская версия)
 * Instagram — через Hiker API (hikerapi.com). Всё остальное (Twitter/X, TikTok,
 * YouTube Shorts) — через RapidAPI "Social Download All In One".
 *
 * Запуск:
 *   node scripts/download-social.mjs <url>
 *   node scripts/download-social.mjs <url> --out workspace/carousel/<slug>/ref-clips/
 *   node scripts/download-social.mjs <url> --frames   (извлечь кадры через ffmpeg)
 *   node scripts/download-social.mjs <url> --all      (скачать все медиа из карусели)
 *
 * Примеры:
 *   node scripts/download-social.mjs https://www.instagram.com/p/ABC123/
 *   node scripts/download-social.mjs https://x.com/user/status/123 --out workspace/reels/src/
 *   node scripts/download-social.mjs https://www.tiktok.com/@user/video/123
 *
 * Конфиги (создаёт мастер /setup):
 *   scripts/.hiker-config.json    — { "hikerApiKey": "..." }   (Instagram)
 *   scripts/.rapidapi-config.json — { "rapidApiKey": "..." }   (Twitter/X, TikTok)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── Config ───────────────────────────────────────────────────────────────────
function loadKey(configName, keyField, exampleName) {
  const cfgPath = join(ROOT, 'scripts', configName);
  if (!existsSync(cfgPath)) {
    console.error(`❌ Нет scripts/${configName} — запусти /setup в Claude Code`);
    console.error(`   или создай по образцу scripts/${exampleName}`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  if (!cfg[keyField]) {
    console.error(`❌ scripts/${configName}: нет поля "${keyField}"`);
    process.exit(1);
  }
  return cfg[keyField];
}

// ── Args ─────────────────────────────────────────────────────────────────────
const url = process.argv[2];
if (!url || url.startsWith('--')) {
  console.error('Usage: node scripts/download-social.mjs <url> [--out <dir>] [--all] [--frames]');
  process.exit(1);
}

const argIdx  = (n) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : undefined; };
const hasFlag = (n) => process.argv.includes(n);

const OUT_DIR    = argIdx('--out') ?? 'workspace/downloads/';
const DOWNLOAD_ALL = hasFlag('--all');
const EXTRACT_FRAMES = hasFlag('--frames');

mkdirSync(OUT_DIR, { recursive: true });

const IS_INSTAGRAM = url.includes('instagram.com');

// ── Helpers ──────────────────────────────────────────────────────────────────
function slugFromUrl(url) {
  const m = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) // Instagram (post/reel/reels/tv)
    ?? url.match(/\/video\/(\d+)/)                  // TikTok
    ?? url.match(/\/status\/(\d+)/);                // Twitter
  return m ? m[1] : 'media_' + Date.now();
}

async function downloadFile(fileUrl, outPath) {
  const res = await fetch(fileUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Download ${res.status}: ${fileUrl.slice(0, 80)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outPath, buf);
  return buf.length;
}

function guessExt(fileUrl, mimeHint) {
  if (fileUrl.includes('.mp4') || mimeHint?.includes('video')) return '.mp4';
  if (fileUrl.includes('.jpg') || fileUrl.includes('.jpeg') || mimeHint?.includes('jpeg')) return '.jpg';
  if (fileUrl.includes('.png') || mimeHint?.includes('png')) return '.png';
  if (fileUrl.includes('.webp')) return '.webp';
  return mimeHint?.includes('image') ? '.jpg' : '.mp4'; // дефолт
}

// ── Instagram: Hiker API ─────────────────────────────────────────────────────
// Объект медиа в стиле instagrapi: media_type 1=фото, 2=видео, 8=карусель
// (у карусели свои медиа лежат в resources[], каждый со своим media_type/video_url/thumbnail_url).
function mediaItemToDownload(item) {
  if (item.media_type === 2 && item.video_url) return { url: item.video_url, type: 'video' };
  if (item.thumbnail_url) return { url: item.thumbnail_url, type: 'image' };
  return null;
}

async function fetchInstagram(mediaUrl) {
  const key = loadKey('.hiker-config.json', 'hikerApiKey', 'hiker-config.example.json');
  const res = await fetch(`https://api.hikerapi.com/v1/media/by/url?url=${encodeURIComponent(mediaUrl)}`, {
    headers: { 'x-access-key': key },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.state === false) {
    throw new Error(body?.error || `Hiker API ${res.status}`);
  }
  const post = body;
  let medias = [];
  if (post.media_type === 8 && Array.isArray(post.resources)) {
    medias = post.resources.map(mediaItemToDownload).filter(Boolean);
  } else {
    const m = mediaItemToDownload(post);
    if (m) medias.push(m);
  }
  return { medias, code: post.code };
}

// ── Не-Instagram: RapidAPI "Social Download All In One" ────────────────────
const DOWNLOAD_HOST = 'social-download-all-in-one.p.rapidapi.com';
const DOWNLOAD_BASE = 'https://social-download-all-in-one.p.rapidapi.com';

async function fetchAutolink(mediaUrl) {
  const key = loadKey('.rapidapi-config.json', 'rapidApiKey', 'rapidapi-config.example.json');
  const res = await fetch(`${DOWNLOAD_BASE}/v1/social/autolink`, {
    method: 'GET',
    headers: {
      'x-rapidapi-host': DOWNLOAD_HOST,
      'x-rapidapi-key':  key,
      'x-url':           mediaUrl,
    },
  });

  if (!res.ok) {
    // Fallback: try POST variant
    const res2 = await fetch(`${DOWNLOAD_BASE}/v1/social/autolink`, {
      method: 'POST',
      headers: {
        'x-rapidapi-host': DOWNLOAD_HOST,
        'x-rapidapi-key':  key,
        'Content-Type':    'application/json',
      },
      body: JSON.stringify({ url: mediaUrl }),
    });
    if (!res2.ok) {
      const body = await res2.text().catch(() => '');
      throw new Error(`API ${res2.status}: ${body.slice(0, 200)}`);
    }
    return validate(await res2.json());
  }
  return validate(await res.json());
}

function validate(j) {
  const medias = j?.medias ?? j?.data?.medias ?? [];
  if (j?.error || !medias.length) {
    throw new Error(j?.message || 'API: медиа не найдено (пустой ответ)');
  }
  return j;
}

// ── Main ─────────────────────────────────────────────────────────────────────
// Обёрнуто в функцию (вместо голого process.exit() после fetch()) — на некоторых
// сборках Node форсированный process.exit() сразу после fetch() падает в
// libuv-ассерт на Windows (UV_HANDLE_CLOSING). process.exitCode + естественное
// завершение это надёжно обходит.
async function main() {
  console.log(`\n📥 Social Download`);
  console.log(`   URL: ${url}`);
  console.log(`   Источник: ${IS_INSTAGRAM ? 'Hiker API (Instagram)' : 'RapidAPI (Social Download All In One)'}`);
  console.log(`   Папка: ${OUT_DIR}\n`);

  let medias, slug;
  try {
    process.stdout.write(`  Получаю ссылки через ${IS_INSTAGRAM ? 'Hiker API' : 'RapidAPI'}... `);
    if (IS_INSTAGRAM) {
      const r = await fetchInstagram(url);
      medias = r.medias;
      slug = r.code || slugFromUrl(url);
    } else {
      const data = await fetchAutolink(url);
      const raw = data?.medias ?? data?.data?.medias ?? [];
      medias = raw.map(m => ({ url: m.url ?? m.download_url ?? m.link, type: m.type ?? m.ext ?? '' }));
      slug = slugFromUrl(url);
    }
    console.log('✅');
  } catch (e) {
    console.log('❌');
    console.error(`  ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (!medias.length) {
    console.log('\n  Медиа не найдено в ответе API.');
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Найдено медиа: ${medias.length}`);

  const toDownload = DOWNLOAD_ALL ? medias : [medias[0]];
  const downloaded = [];

  for (let i = 0; i < toDownload.length; i++) {
    const m = toDownload[i];
    const fileUrl = m.url;
    if (!fileUrl) { console.log(`  [${i+1}] Нет URL, пропускаю`); continue; }

    const ext  = guessExt(fileUrl, m.type ?? '');
    const name = medias.length > 1 ? `${slug}_${String(i + 1).padStart(2, '0')}${ext}` : `${slug}${ext}`;
    const outPath = join(OUT_DIR, name);

    process.stdout.write(`  [${i+1}/${toDownload.length}] ${name} ... `);
    try {
      const bytes = await downloadFile(fileUrl, outPath);
      const mb    = (bytes / 1024 / 1024).toFixed(1);
      console.log(`✅ ${mb} MB`);
      downloaded.push(outPath);
    } catch (e) {
      console.log(`❌ ${e.message.slice(0, 80)}`);
    }
  }

  if (downloaded.length === 0) {
    console.error('\n❌ Ничего не скачано');
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ✅ Скачано: ${downloaded.length} файл(ов) → ${OUT_DIR}`);
  downloaded.forEach(p => console.log(`     ${p}`));

  // ── Frames (опционально) ────────────────────────────────────────────────────
  if (EXTRACT_FRAMES) {
    const videoFiles = downloaded.filter(p => p.endsWith('.mp4') || p.endsWith('.mov'));
    for (const videoPath of videoFiles) {
      const framesDir = videoPath.replace(/\.(mp4|mov)$/, '-frames');
      mkdirSync(framesDir, { recursive: true });
      console.log(`\n  🎞️  Извлекаю кадры из ${basename(videoPath)}...`);
      try {
        execSync(
          `ffmpeg -i "${videoPath}" -vf "fps=1" "${framesDir}/frame-%03d.jpg" -y -loglevel error`,
          { stdio: 'inherit' }
        );
        console.log(`  ✅ Кадры → ${framesDir}/`);
      } catch {
        console.log('  ⚠️  ffmpeg недоступен или ошибка');
      }
    }
  }

  console.log();
}

await main();
