/**
 * storyboard-image.mjs — генерация КАРТИНКИ-сториборда (9:16, сетка панелей) через GPT Image (CDP 9222).
 * Вход: файл с промтом (текст целиком). Выход: PNG.
 * Запуск: node scripts/storyboard-image.mjs <prompt.txt> <out.png>
 * Chrome CDP поднять заранее (правило 6 CLAUDE.md).
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

const PROMPT = readFileSync(process.argv[2], 'utf8');
const OUT = resolve(process.argv[3]);
const ATTACH = process.argv.slice(4).map(f => resolve(f));
mkdirSync(dirname(OUT), { recursive: true });

const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = b.contexts()[0];
const page = await ctx.newPage();
await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const allBig = () => page.evaluate(() => Array.from(document.querySelectorAll('img'))
  .filter(i => i.naturalWidth > 500 && i.naturalHeight > 500 && !/avatar|profile/.test(i.src) && !i.src.startsWith('blob:'))
  .map(i => i.src));

const before = new Set(await allBig());
if (ATTACH.length) {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(ATTACH);
  await page.waitForTimeout(2500 + ATTACH.length * 1500);
}
await page.evaluate(() => { const el = document.querySelector('#prompt-textarea'); el && el.focus(); });
await page.keyboard.insertText(PROMPT);
await page.waitForTimeout(600);
const btn = page.locator('button[data-testid="send-button"], button[aria-label*="Send"]').first();
if (await btn.count()) await btn.click(); else await page.keyboard.press('Enter');
console.log('отправлено, жду картинку…');

let candidate = null, since = 0, src = null;
const t0 = Date.now();
while (Date.now() - t0 < 320000) {
  const fresh = (await allBig()).filter(s => !before.has(s));
  if (fresh.length >= ATTACH.length + 1 && Date.now() - t0 > 40000) {
    const last = fresh[fresh.length - 1];
    if (last === candidate) { if (Date.now() - since > 8000) { src = last; break; } }
    else { candidate = last; since = Date.now(); }
  }
  process.stdout.write('.');
  await page.waitForTimeout(5000);
}
if (!src) { console.log('\n❌ картинка не появилась'); process.exit(1); }
const arr = await page.evaluate(async (s) => { const r = await fetch(s); return Array.from(new Uint8Array(await r.arrayBuffer())); }, src);
writeFileSync(OUT, Buffer.from(arr));
console.log(`\n✅ ${OUT}`);
await page.close();
await b.close();
process.exit(0);
