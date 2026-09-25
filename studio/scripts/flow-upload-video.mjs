#!/usr/bin/env node
/**
 * flow-upload-video.mjs — КАНОН заливки ВИДЕО в Google Flow через CDP 9222.
 *
 * ROOT CAUSE старых попыток:
 *   • На странице по умолчанию ОДИН <input type=file> и он accept=image/* (инпут картинок).
 *     setInputFiles видео туда → Flow молча отбрасывает («done, но видео не появляется»).
 *   • Настоящая точка загрузки — кнопка модалки СЛЕВА-ВНИЗУ "Upload media"
 *     (textContent = "uploadUpload media": иконка-лигатура 'upload' + подпись).
 *     Клик по ней ДИНАМИЧЕСКИ ИНЖЕКТИТ второй <input type=file> с
 *     accept="video/*,image/*,.heic,.heif" — вот куда должно уходить видео.
 *   • Старые скрипты: (а) матчили ^Upload media$ и мимо (лигатура ломает exact-match);
 *     (б) кликали "Uploads" в ЛЕВОМ САЙДБАРЕ ПРИЛОЖЕНИЯ (не в модалке) и попадали на
 *     верхний "+Add Media", который видео-инпут НЕ инжектит.
 *
 * FIX: открыть композер "+" → кликнуть модальный "Upload media" → setInputFiles на
 *      инпут с accept, содержащим video → дождаться появления новой плитки/asset-id.
 *
 * Ограничения: НИКОГДА не жмёт Generate/Send. hard process.exit(0), без browser.close().
 * Usage: node scripts/flow-upload-video.mjs "d:\\...\\sysv1.mp4"
 */
import { chromium } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const FILE = process.argv[2];
if (!FILE) { console.error('usage: node scripts/flow-upload-video.mjs "<abs path .mp4>"'); process.exit(2); }
const ABS = path.resolve(FILE);
if (!existsSync(ABS)) { console.error('файл не найден:', ABS); process.exit(2); }
const sizeMB = (statSync(ABS).size / 1048576).toFixed(2);
const BASE = path.basename(ABS);
const NOEXT = BASE.replace(/\.[^.]+$/, '');
const wait = ms => new Promise(r => setTimeout(r, ms));
const QA = 'd:/Claude-Projects/workspace/reels/leaked-prompt/qa';

const b = await chromium.connectOverCDP(process.env.FLOW_CDP || 'http://127.0.0.1:9222');
const p = b.contexts()[0].pages().find(x => /flow\/project/.test(x.url()));
if (!p) { console.error('НЕТ вкладки flow/project'); process.exit(9); }
await p.bringToFront();
console.log(`file: ${ABS} (${sizeMB} MB)`);

// ── сеть: отделяем настоящие upload-эндпоинты от телеметрии ─────────────────
const TELEMETRY = /batchLogFrontendEvents|fetchUserAcknowledgement|credits|clientstreamz|gstatic|fonts|\.css|\.js(\?|$)/i;
const UPLOADISH = /upload|scotty|resumable|blobstore|media\.(create|upload)|uploads\b/i;
const netUpload = [];
p.on('response', r => {
  const u = r.url();
  if (TELEMETRY.test(u)) return;
  if (UPLOADISH.test(u)) netUpload.push({ st: r.status(), m: r.request().method(), u: u.slice(0, 120) });
});

// safety net: если клик всё же вызовет filechooser — обслужим его
let chooserHandled = false;
p.on('filechooser', async fc => {
  try { await fc.setFiles(ABS); chooserHandled = true; console.log('filechooser -> setFiles OK'); }
  catch (e) { console.log('filechooser err:', e.message); }
});

// ── снапшот строк пикера (имя + Image/Video) для диффа ──────────────────────
async function pickerRows() {
  return p.evaluate(() => {
    const rows = [];
    for (const e of document.querySelectorAll('div,li')) {
      const r = e.getBoundingClientRect();
      if (r.width < 200 || r.width > 780 || r.height < 40 || r.height > 110) continue;
      if (r.x > innerWidth * 0.62) continue;
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/(Image|Video)$/.test(t)) continue;
      rows.push({ t: t.slice(0, 46), y: Math.round(r.y) });
    }
    const out = [];
    for (const row of rows.sort((a, b) => a.y - b.y)) if (!out.some(o => Math.abs(o.y - row.y) < 14)) out.push(row);
    return out.map(o => o.t);
  });
}
async function scrollListTop() { await p.mouse.move(790, 400); await p.mouse.wheel(0, -2500); await wait(400); }

await p.keyboard.press('Escape'); await wait(600);

// 1) открыть композер "+"
const plus = await p.evaluate(() => {
  const e = [...document.querySelectorAll('button,[role="button"]')].find(x => /add_2|^add$/i.test((x.textContent || '').trim()) && x.getBoundingClientRect().y > innerHeight * 0.8);
  if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (!plus) { console.error('нет composer +'); process.exit(3); }
await p.mouse.click(plus.x, plus.y); await wait(1800);
await scrollListTop();
const before = await pickerRows();
console.log('picker rows before:', before.length);

// 2) кнопка модалки "Upload media" (contains, самая маленькая; лигатура в тексте — ищем contains)
async function findUploadMedia() {
  return p.evaluate(() => {
    const c = [...document.querySelectorAll('button,[role="button"]')].map(e => {
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim(); const r = e.getBoundingClientRect();
      return { t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width, h: r.height };
    }).filter(o => o.w > 0 && o.h > 0 && /Upload media|Medya yükle/i.test(o.t) && o.t.length < 30);
    c.sort((a, b) => a.w * a.h - b.w * b.h);
    return c[0] || null;
  });
}
let umBtn = await findUploadMedia();
console.log('Upload media btn:', JSON.stringify(umBtn));
if (!umBtn) { await p.screenshot({ path: QA + '/upvid-noumbtn.png' }); console.error('НЕ найдена кнопка Upload media модалки'); process.exit(4); }
await p.mouse.click(umBtn.x, umBtn.y);
await wait(2000); // дать инжектнуться видео-инпуту

// 3) найти инпут с accept, содержащим video, и залить файл напрямую
let method = '';
if (!chooserHandled) {
  const loc = p.locator('input[type=file]');
  const n = await loc.count();
  const accepts = [];
  let vidIdx = -1;
  for (let i = 0; i < n; i++) { const a = (await loc.nth(i).getAttribute('accept')) || ''; accepts.push(a); if (vidIdx < 0 && /video/i.test(a)) vidIdx = i; }
  console.log('file inputs accept =', JSON.stringify(accepts));
  if (vidIdx < 0) {
    // повторный клик — иногда инпут инжектится не с первого раза
    await p.mouse.click(umBtn.x, umBtn.y); await wait(2000);
    const n2 = await loc.count();
    for (let i = accepts.length; i < n2; i++) { const a = (await loc.nth(i).getAttribute('accept')) || ''; accepts.push(a); if (vidIdx < 0 && /video/i.test(a)) vidIdx = i; }
  }
  if (vidIdx < 0) {
    await p.screenshot({ path: QA + '/upvid-novideoinput.png' });
    console.error('ВИДЕО-инпут (accept~video) не инжектнулся. accepts=', JSON.stringify(accepts));
    process.exit(5);
  }
  await loc.nth(vidIdx).setInputFiles(ABS);
  method = `setInputFiles input#${vidIdx} (accept=${accepts[vidIdx]})`;
  console.log('->', method);
} else {
  method = 'filechooser';
}
await wait(1500);
await p.screenshot({ path: QA + '/upvid-after-set.png' });

// 4) ждём обработку/транскод; поллим появление новой строки в пикере (Recent → сверху)
let newRows = [], ok = false, nameSeen = false;
for (let t = 0; t < 30 && !ok; t++) {
  await wait(4000);
  await scrollListTop();
  const now = await pickerRows();
  newRows = now.filter(s => !before.includes(s));
  nameSeen = await p.evaluate(nx => (document.body.innerText || '').includes(nx), NOEXT).catch(() => false);
  const up2xx = netUpload.filter(x => x.st >= 200 && x.st < 300 && /POST|PUT/.test(x.m));
  process.stdout.write(`  poll ${String(t).padStart(2)}: newRows=${newRows.length} name(${NOEXT})=${nameSeen} netUpload=${netUpload.length} 2xx-POST/PUT=${up2xx.length}\n`);
  if (newRows.length > 0 || nameSeen || up2xx.length > 0) ok = true;
}

await p.screenshot({ path: QA + '/upvid-final.png' });
console.log('\n──────── RESULT ────────');
console.log('method      :', method);
console.log('new rows    :', newRows.length, newRows.slice(0, 8));
console.log('name seen   :', nameSeen, `(${NOEXT})`);
console.log('net uploads :', netUpload.length);
netUpload.slice(-10).forEach(x => console.log(`   [${x.st}] ${x.m} ${x.u}`));
console.log('VERDICT     :', ok ? 'UPLOAD CONFIRMED ✅' : 'NOT CONFIRMED ❌ (см. qa/upvid-*.png)');
process.exit(0);
