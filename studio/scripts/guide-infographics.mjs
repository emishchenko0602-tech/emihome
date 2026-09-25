/**
 * guide-infographics.mjs — УНИВЕРСАЛЬНЫЙ генератор инфографик-«учебных баннеров» для гайдов aicube.
 *
 * Отличие от generate-<slug>-infographics.mjs: там slug и содержимое зашиты в файл,
 * и на каждый новый гайд копировался весь скрипт. Здесь берётся из JSON-спека.
 *
 * Стиль (столп №4 канона гайдов) внутри и НЕ меняется: тёплая кремовая бумага,
 * терракота, серифный заголовок, нумерованные карточки, полоса-итог, вотермарк бренда
 * (берётся из spec.wordmark или scripts/.f2-brand.json).
 * Горизонталь 1536×1024, весь текст русский.
 *
 * Запуск:
 *   node scripts/guide-infographics.mjs workspace/guides/<slug>/infographics.json
 *
 * Формат спека:
 * {
 *   "slug": "claude-code-5-plaginov",
 *   "outDir": "D:/Projects/claude-guide-site-new/claude-guide-site/public/guides/claude-code-5-plaginov",
 *   "items": [
 *     { "file": "info-1.png", "title": "…", "subtitle": "…", "intro": "…",
 *       "cards": ["1 ЗАГОЛОВОК — пояснение | example chip: «…»"],
 *       "takeaway": "…" }
 *   ]
 * }
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const specPath = process.argv[2];
if (!specPath) {
  console.error('Использование: node scripts/guide-infographics.mjs <path/to/infographics.json>');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const DIR = resolve(spec.outDir);

// Вотермарк — из бренда студии: spec.wordmark → scripts/.f2-brand.json → наш дефолт.
function brandWordmark() {
  if (spec.wordmark) return spec.wordmark;
  try {
    const b = JSON.parse(readFileSync(new URL('./.f2-brand.json', import.meta.url), 'utf8'));
    if (b.wordmark) return b.wordmark;
    if (b.brand) return String(b.brand).toUpperCase();
  } catch { /* конфига нет — работаем на дефолте */ }
  return 'МОЯ СТУДИЯ';
}
const WORDMARK = brandWordmark();

const STYLE = `A DETAILED EDUCATIONAL TEACHING BANNER / classroom-poster infographic, LANDSCAPE orientation 1536x1024 (3:2). Think of a richly-labelled textbook diagram that explains a concept step by step. WARM CREAM PAPER background #F7F2E8 with a very subtle paper texture — premium editorial magazine look, NOT a white tech UI. Use an elegant high-contrast SERIF display font (like Playfair Display) for the big TITLE, and a clean readable sans for labels. ALL TEXT IN RUSSIAN, correct spelling, NO gibberish, real legible words.
Layout as a full one-page teaching poster:
- TOP: bold serif TITLE + a short subtitle + ONE intro sentence that frames the lesson.
- MIDDLE: large numbered cards on warm off-white #FCF9F2 with thin warm borders #E4DAC7 and soft shadow, arranged to fill the wide frame (single horizontal row of steps, or a balanced grid). Each card is detailed: a TERRACOTTA #BE4A24 rounded number badge + a simple thin line ICON + a bold heading (dark warm ink #1E1A16) + ONE short line of explanation #6E655A + a tiny MONOSPACE example chip in a darker pill (like a real example/command).
- thin terracotta connector ARROWS left-to-right showing flow.
- BOTTOM: a highlighted TAKEAWAY strip with soft terracotta tint and a bold one-line rule to remember.
Small "${WORDMARK}" wordmark bottom-right in terracotta. Calm, warm, premium, well-spaced but information-rich like a study sheet. Accent terracotta #BE4A24, secondary warm gold #C98A3C.`;

const buildPrompt = (it) => `${STYLE}
TITLE: "${it.title}". Subtitle: "${it.subtitle}".
Intro sentence under the title: "${it.intro}"
${it.cards.length} large detailed numbered cards (1..${it.cards.length}), left-to-right:
${it.cards.join('\n')}
Bottom takeaway strip (bold): "${it.takeaway}"`;

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
async function submitPrompt(page, text) {
  await dismissModal(page);
  // Ждём композер явно — иначе на медленной загрузке падает «composer not found».
  await page.waitForSelector('#prompt-textarea', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const ta = page.locator('div#prompt-textarea, div[contenteditable="true"]').first();
  await ta.click();
  await page.keyboard.insertText(text);
  await page.waitForTimeout(400);
  if ((await ta.innerText().catch(() => '')).trim().length < 10) await ta.pressSequentially(text, { delay: 3 });
  const b = page.locator('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="тправ"]').first();
  if (await b.count()) await b.click(); else await page.keyboard.press('Enter');
}
async function lastBig(page) {
  return page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 500 && i.naturalHeight > 500 && !/avatar|profile/.test(i.src));
    return imgs.length ? imgs[imgs.length - 1].src : null;
  });
}
async function waitNew(page, prev, timeout = 260000) {
  const s = Date.now();
  while (Date.now() - s < timeout) {
    const src = await lastBig(page);
    if (src && src !== prev) { await page.waitForTimeout(2500); return (await lastBig(page)) || src; }
    process.stdout.write('.');
    await page.waitForTimeout(5000);
  }
  return null;
}
async function save(page, src, fpath) {
  const arr = await page.evaluate(async (s) => Array.from(new Uint8Array(await (await fetch(s)).arrayBuffer())), src);
  const buf = Buffer.from(arr);
  if (buf.length < 10000) throw new Error(`картинка подозрительно мелкая (${buf.length} Б)`);
  writeFileSync(fpath, buf);
}

const browser = await chromium.connectOverCDP(CDP_URL);
const ctx = browser.contexts()[0];
mkdirSync(DIR, { recursive: true });
const page = await ctx.newPage();
await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await dismissModal(page);

console.log(`\n🖼  Инфографики гайда ${spec.slug} → ${DIR}\n`);
let done = 0, failed = 0;
for (const it of spec.items) {
  const fpath = join(DIR, it.file);
  if (existsSync(fpath)) { console.log(`  ⏭  ${it.file}`); continue; }
  console.log(`\n  🎨 ${it.file} — ${it.title}`);
  try {
    await dismissModal(page);
    const prev = await lastBig(page);
    await submitPrompt(page, `Using GPT Image, generate:\n\n${buildPrompt(it)}`);
    console.log('     жду...');
    const src = await waitNew(page, prev, 260000);
    if (!src) { failed++; console.log('\n  ⚠️ нет картинки — кулдаун 90с'); await dismissModal(page); await new Promise(r => setTimeout(r, 90000)); continue; }
    await save(page, src, fpath);
    done++;
    console.log(`\n  ✅ ${fpath}`);
    await new Promise(r => setTimeout(r, 20000));
  } catch (e) {
    failed++;
    console.log(`\n  ❌ ${String(e.message).slice(0, 90)} — кулдаун 90с`);
    await dismissModal(page).catch(() => {});
    await new Promise(r => setTimeout(r, 90000));
  }
}
await page.close();
await browser.close();
console.log(`\n✅ ${spec.slug}: готово ${done}, сбоев ${failed}.`);
process.exit(0);
