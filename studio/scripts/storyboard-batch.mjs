/**
 * storyboard-batch.mjs — пакетная генерация КАРТИНОК-сторибордов для Omni-монтажа.
 *
 * Раньше на каждую часть руками: вырезать 6 кадров ffmpeg → написать промпт целиком →
 * вызвать storyboard-image.mjs. На ролик из шести частей это 6 однотипных заходов,
 * и стиль между ними расползается. Здесь стиль задан ОДИН раз в спеке, а по частям
 * описываются только панели.
 *
 * Делает сам: режет кадры по таймкодам панелей, собирает промпт по канону Павла
 * (без шапки, 6 панелей, таймкод + тип шота под панелью), гонит GPT Image через CDP,
 * пропускает уже готовые борды.
 *
 * Запуск:
 *   node scripts/storyboard-batch.mjs workspace/reels/<slug>/sb-spec.json
 *   node scripts/storyboard-batch.mjs <spec> --only 2,3
 *
 * Формат спека:
 * {
 *   "slug": "plagin-live",
 *   "srcVideo": "workspace/reels/plagin-live/live-src.mp4",
 *   "outDir": "workspace/reels/plagin-live/storyboard",
 *   "framesDir": "workspace/reels/plagin-live/frames",
 *   "styleName": "терминал-pro",
 *   "style": "<описание визуального стиля оверлеев, английским, БЕЗ hex>",
 *   "parts": [
 *     { "n": 1, "panels": [ { "at": 0.5, "shot": "FULLSCREEN SPEAKER PUSH IN",
 *                             "timing": "zero point five seconds", "desc": "..." } ] }
 *   ]
 * }
 *
 * ⚠️ В `desc` и `style` НЕ писать hex-коды и числовые таймкоды — Omni потом рендерит их
 * как текст прямо в кадр. Цвет словами, тайминг словами (поле `timing`).
 * `at` — только для нарезки кадров, в промпт не попадает как «5.5s», а идёт через `timing`.
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

const FFMPEG = process.env.FFMPEG || 'D:/tools/ffmpeg/bin/ffmpeg';
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

const specPath = process.argv[2];
if (!specPath) {
  console.error('Использование: node scripts/storyboard-batch.mjs <sb-spec.json> [--only 1,2]');
  process.exit(1);
}
const rest = process.argv.slice(3);
const onlyIdx = rest.indexOf('--only');
const only = onlyIdx >= 0 ? (rest[onlyIdx + 1] || '').split(',').filter(Boolean).map(Number) : [];

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const outDir = resolve(spec.outDir);
const framesDir = resolve(spec.framesDir);
mkdirSync(outDir, { recursive: true });
mkdirSync(framesDir, { recursive: true });

const HEAD = (part, total) => `Create ONE vertical 9:16 storyboard sheet, 1080x1920, a grid of SIX phone-shaped panels in two columns and three rows. No title, no header, no watermark and no caption anywhere on the image: the six panels start right at the top edge.

Each panel contains the corresponding ATTACHED frame of the speaker as its base photo (attachment one goes into panel one, attachment two into panel two, and so on), with motion graphics drawn ON TOP of that frame. Keep the man exactly as he looks in the attachments: same face, hair, beard, clothes and pose. Do not redraw him, do not replace him with another person, do not beautify him.

VISUAL STYLE for all overlay graphics — ${spec.style}

HARD RULE ON TEXT, valid for every panel: text must be SPARSE and SINGLE. One caption per panel, standing on its own. A small label is fine when it is alone — a single chip, a single line under a graphic, a single word inside a card. What is forbidden is MANY small pieces of text at once: no lists of rows, no logs, no tables, no columns of numbers, no code, no diffs, no file trees, no ticker rows, no chat threads. Dense text is redrawn into gibberish, rows get duplicated and digits rewritten. If a panel needs to show a set of things, show ONE of them large, or replace the set with a diagram of plain shapes and one caption.

Do NOT write any label, timing or shot-type caption under or over the panels: no English service words such as FULLSCREEN CONTENT or NO SPEAKER anywhere on the sheet. Omni redraws such labels straight into the finished video, and they have been caught in frame. Thin arrows point from one panel to the next in reading order. This sheet is part ${part} of ${total} of the same video, so keep the visual language identical to the other parts.`;

const NUM = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX'];

function buildPrompt(part, total, panels) {
  const body = panels.map((p, i) =>
    `PANEL ${NUM[i]}. Shot type ${p.shot}. Timing ${p.timing}. ${p.desc}`).join('\n\n');
  return `${HEAD(part, total)}\n\n${body}\n\nAll Russian text must be spelled correctly and be fully legible. Keep captions short.\n`;
}

// ─── helpers CDP (те же, что в f2-from-ref.mjs) ──────────────────────────────
async function dismissModal(page) {
  try {
    const m = page.locator('[data-testid*="rate-limit"], [id*="rate-limit"]');
    for (let k = 0; k < 3 && (await m.count()); k++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.mouse.click(20, 20).catch(() => {});
      await page.waitForTimeout(1500);
    }
  } catch {}
}
// Шесть кадров разом ChatGPT переваривает долго: 45 секунд не хватало и борд падал
// с «кадры не долетели». Ждём дольше и принимаем частичную загрузку под конец.
async function attachFiles(page, paths) {
  await page.locator('input[type="file"]').first().setInputFiles(paths);
  const start = Date.now();
  let last = 0;
  while (Date.now() - start < 120000) {
    const n = await page.evaluate(() => document.querySelectorAll('img[src^="blob:"]').length);
    if (n >= paths.length) { await page.waitForTimeout(2500); return true; }
    if (n !== last) { last = n; process.stdout.write(`[${n}/${paths.length}]`); }
    await page.waitForTimeout(1500);
  }
  return false;
}
async function insertPrompt(page, text) {
  await page.waitForSelector('#prompt-textarea', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('#prompt-textarea')?.focus());
  await page.keyboard.insertText(text);
  await page.waitForTimeout(600);
  const v = await page.evaluate(() => document.querySelector('#prompt-textarea')?.innerText || '');
  if (v.trim().length < 12) throw new Error('insert failed');
}
async function send(page) {
  // новый UI ChatGPT (08.2026, переключатель Chat/Work): send-button может быть
  // скрыт/переименован — короткая попытка клика и фолбэк на Enter из композера
  const b = page.locator('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="тправ"]').first();
  try {
    if (await b.count()) { await b.click({ timeout: 8000 }); return; }
  } catch {}
  await page.evaluate(() => document.querySelector('#prompt-textarea')?.focus());
  await page.keyboard.press('Enter');
}
async function bigImgs(page) {
  return page.evaluate(() => [...document.querySelectorAll('img')]
    .filter(i => i.naturalWidth > 500 && i.naturalHeight > 500 && !/avatar|profile/.test(i.src) && !i.src.startsWith('blob:'))
    .map(i => i.src));
}
async function waitGenerated(page, before, nAttach, timeout = 360000) {
  const start = Date.now();
  let cand = null, since = 0;
  while (Date.now() - start < timeout) {
    const fresh = (await bigImgs(page)).filter(s => !before.has(s));
    if (fresh.length >= nAttach + 1 && Date.now() - start > 45000) {
      const last = fresh[fresh.length - 1];
      if (last === cand) { if (Date.now() - since > 8000) return last; }
      else { cand = last; since = Date.now(); }
    }
    process.stdout.write('.');
    await page.waitForTimeout(5000);
  }
  return null;
}
async function save(page, src, fpath) {
  const arr = await page.evaluate(async (s) => Array.from(new Uint8Array(await (await fetch(s)).arrayBuffer())), src);
  const buf = Buffer.from(arr);
  if (buf.length < 20000) throw new Error(`борд подозрительно мелкий (${buf.length} Б)`);
  writeFileSync(fpath, buf);
}

// ─── main ────────────────────────────────────────────────────────────────────
const total = spec.parts.length;
console.log(`\n🎬 Сториборды ${spec.slug} — стиль «${spec.styleName}», частей ${total}\n`);

const browser = await chromium.connectOverCDP(CDP_URL);
const ctx = browser.contexts()[0];
let done = 0, failed = 0;

for (const part of spec.parts) {
  if (only.length && !only.includes(part.n)) continue;
  const boardPath = join(outDir, `p${part.n}-board.png`);
  if (existsSync(boardPath)) { console.log(`  ⏭  часть ${part.n} (борд есть)`); continue; }

  // кадры под панели
  const framePaths = [];
  for (const [i, p] of part.panels.entries()) {
    const f = join(framesDir, `p${part.n}-${i + 1}.jpg`);
    if (!existsSync(f)) {
      execSync(`"${FFMPEG}" -y -ss ${p.at} -i "${resolve(spec.srcVideo)}" -frames:v 1 -q:v 2 -loglevel error "${f}"`);
    }
    framePaths.push(f);
  }

  const prompt = buildPrompt(part.n, total, part.panels);
  writeFileSync(join(outDir, `p${part.n}-prompt.txt`), prompt, 'utf8');

  console.log(`\n  🎬 часть ${part.n}/${total} — ${part.panels.length} панелей`);
  const page = await ctx.newPage();
  try {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await dismissModal(page);
    const before = new Set(await bigImgs(page));
    const ok = await attachFiles(page, framePaths);
    if (!ok) throw new Error('кадры не долетели до ChatGPT');
    await insertPrompt(page, prompt);
    await send(page);
    const src = await waitGenerated(page, before, framePaths.length);
    if (!src) throw new Error('картинки нет');
    await save(page, src, boardPath);
    done++;
    console.log(`\n  ✅ ${boardPath}`);
  } catch (e) {
    failed++;
    console.log(`\n  ❌ часть ${part.n}: ${String(e.message).slice(0, 90)}`);
  } finally {
    await page.close().catch(() => {});
  }
  await new Promise(r => setTimeout(r, 12000));
}

await browser.close();
console.log(`\n🏁 ${spec.slug}: готово ${done}, сбоев ${failed}`);
process.exit(failed && !done ? 1 : 0);
