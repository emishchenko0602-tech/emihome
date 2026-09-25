/**
 * f2-from-ref.mjs — УНИВЕРСАЛЬНЫЙ движок F2: «свой референс → своя карусель».
 *
 * Отличие от generate-batch-*-f2.mjs: там контент и рефы захардкожены в скрипте.
 * Здесь всё берётся из декларативного спека, поэтому человек кидает СВОЙ реф
 * (карусель или кадры рилса) и получает карусель в СВОЁМ стиле.
 *
 * Запуск:
 *   node scripts/f2-from-ref.mjs workspace/carousel/<slug>/f2-spec.json
 *   node scripts/f2-from-ref.mjs <spec.json> --only 1,3,7    # только эти слайды
 *   node scripts/f2-from-ref.mjs <spec.json> --redo 4        # перегенерить (снести готовый)
 *
 * Формат спека (f2-spec.json):
 * {
 *   "slug": "claude-5-plugins",
 *   "outDir": "workspace/carousel/claude-5-plugins/format2",
 *   "refDir": "workspace/pipeline-demo/refs/plugin/Dbn6ElTvw_W_01-frames",
 *   "brand": "Моя Студия · @my_studio",   // необязательно: по умолчанию из scripts/.f2-brand.json
 *   "facePhoto": "workspace/assets/photos/author/author.jpg", // опционально
 *   "designNote": "свободное описание дизайн-кода рефа (усиливает промпт)",
 *   "slides": [
 *     { "name": "cover", "ref": "frame-001.jpg", "face": true, "prompt": "…что на слайде…" }
 *   ]
 * }
 *
 * ref — имя файла внутри refDir. Если поля нет, слайд генерится без реф-картинки
 * (режим «наш стиль без рефа»).
 */
import { chromium } from '@playwright/test';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 12000);
const COOL_MS = Number(process.env.COOL_MS ?? 60000);

const [specPath, ...rest] = process.argv.slice(2);
if (!specPath) {
  console.error('Использование: node scripts/f2-from-ref.mjs <path/to/f2-spec.json> [--only 1,2] [--redo 3]');
  process.exit(1);
}
const argVal = (flag) => {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : null;
};
const onlyList = (argVal('--only') || '').split(',').filter(Boolean).map(Number);
const redoList = (argVal('--redo') || '').split(',').filter(Boolean).map(Number);

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const specDir = dirname(resolve(specPath));
const outDir = resolve(spec.outDir || join(specDir, 'format2'));
// Бренд: spec.brand → scripts/.f2-brand.json (создаёт мастер установки) → наш дефолт.
function brandFromConfig() {
  try {
    const b = JSON.parse(readFileSync(new URL('./.f2-brand.json', import.meta.url), 'utf8'));
    if (b.brand && b.handle) return `${b.brand} · ${b.handle}`;
    if (b.brand) return b.brand;
  } catch { /* конфига нет — работаем на дефолте */ }
  return null;
}
const brand = spec.brand || brandFromConfig() || 'Моя Студия';
const facePhoto = spec.facePhoto ? resolve(spec.facePhoto) : null;

// ⚠️ Грабля 06.08: если реф-кадр содержит крупный портрет чужого человека, GPT Image
// копирует ЕГО, а фото автора игнорирует. Запрет должен быть явным и стоять в промпте
// ПОСЛЕ описания сцены. Надёжнее всего — на слайдах с лицом вообще не давать ref-кадр.
const FACE_NOTE = `CRITICAL — WHOSE FACE: the LAST attached image is the real author of this account. The person in the generated slide MUST be THEM: same face, same hair, same beard, same eyes — photorealistic and seamlessly blended into the scene.
If the reference image shows any other person, that person is a LAYOUT reference ONLY and MUST NOT appear: do not copy their face, hair or build. Never substitute a different man. Do not beautify or restyle the author's face.`;

const head = (hasRef) => [
  `You are generating ONE Instagram carousel slide, 1080x1350 px, 4:5 vertical, full bleed, no borders, no margins.`,
  hasRef
    ? `The FIRST attached image is a REFERENCE for DESIGN LANGUAGE ONLY — copy its background treatment, colour palette, typographic character, layout logic, decorative details, mood and proportions so our slide reads as part of the same premium series. It is NOT a pixel clone and its content is NOT our content.`
    : `There is no reference image — build the slide in the design language described below.`,
  spec.designNote ? `DESIGN CODE OF THE SERIES: ${spec.designNote}` : '',
  `Render ALL text in clean, correctly spelled Russian Cyrillic — no gibberish, no invented words, no doubled letters. Product and brand names (Claude, Claude Code, GitHub, MCP, OmniRoute, claude-mem, Headroom, Anthropic, Task Observer) stay in Latin exactly as written.`,
  `Replace any handle or watermark from the reference with "${brand}".`,
].filter(Boolean).join('\n');

// ─── helpers (проверенные на generate-batch-0708-f2.mjs) ─────────────────────
async function dismissModal(page) {
  try {
    const modal = page.locator('[data-testid*="rate-limit"], [id*="rate-limit"]');
    for (let k = 0; k < 3 && (await modal.count()); k++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.mouse.click(20, 20).catch(() => {});
      await page.waitForTimeout(1500);
    }
  } catch {}
}
async function attachFiles(page, absPaths) {
  if (!absPaths.length) return true;
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(absPaths);
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const ok = await page.evaluate(() => !!document.querySelector('img[src^="blob:"], [data-testid*="attachment"], button[aria-label*="emove"]'));
    if (ok) { await page.waitForTimeout(2000); return true; }
    await page.waitForTimeout(1000);
  }
  return false;
}
// Грабля 06.08: у слайда БЕЗ вложений между goto и вводом промпта нет паузы на загрузку
// файла, и composer ещё не отрисован → «composer not found». Ждём его явно.
async function waitComposer(page, timeout = 60000) {
  await page.waitForSelector('#prompt-textarea', { timeout }).catch(() => {});
  await page.waitForTimeout(1200);
}
async function insertPrompt(page, text) {
  await waitComposer(page);
  const focused = await page.evaluate(() => {
    const el = document.querySelector('#prompt-textarea');
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  });
  if (!focused) throw new Error('composer not found');
  await page.waitForTimeout(250);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(600);
  let v = await page.evaluate(() => { const el = document.querySelector('#prompt-textarea'); return el ? el.innerText : ''; });
  if (v.trim().length < 12) {
    await page.evaluate((t) => { const el = document.querySelector('#prompt-textarea'); if (el) { el.focus(); document.execCommand('insertText', false, t); } }, text);
    await page.waitForTimeout(600);
    v = await page.evaluate(() => { const el = document.querySelector('#prompt-textarea'); return el ? el.innerText : ''; });
  }
  if (v.trim().length < 12) throw new Error('insert failed');
}
async function send(page) {
  const btn = page.locator('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="тправ"]').first();
  if (await btn.count()) await btn.click(); else await page.keyboard.press('Enter');
}
async function allBigImgSrcs(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('img'))
    .filter(i => i.naturalWidth > 500 && i.naturalHeight > 500 && !/avatar|profile/.test(i.src) && !i.src.startsWith('blob:'))
    .map(i => i.src));
}
async function waitForGenerated(page, beforeSet, nAttach, timeout = 340000, minElapsed = 45000) {
  const start = Date.now();
  let candidate = null, candidateSince = 0;
  while (Date.now() - start < timeout) {
    const srcs = await allBigImgSrcs(page);
    const fresh = srcs.filter(s => !beforeSet.has(s));
    if (fresh.length >= nAttach + 1 && Date.now() - start > minElapsed) {
      const last = fresh[fresh.length - 1];
      if (last === candidate) {
        if (Date.now() - candidateSince > 8000) return last;
      } else { candidate = last; candidateSince = Date.now(); }
    }
    process.stdout.write('.');
    await page.waitForTimeout(5000);
  }
  return null;
}
async function saveImg(page, src, fpath) {
  const arr = await page.evaluate(async (s) => {
    const r = await fetch(s);
    return Array.from(new Uint8Array(await r.arrayBuffer()));
  }, src);
  const buf = Buffer.from(arr);
  if (buf.length < 10000) throw new Error(`картинка подозрительно мелкая (${buf.length} Б)`);
  writeFileSync(fpath, buf);
}

// ─── main ────────────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
console.log(`\n🎨 F2 из рефа — ${spec.slug} (${spec.slides.length} слайдов)`);
console.log(`   реф:   ${spec.refDir || '— (без рефа)'}`);
console.log(`   выход: ${outDir}\n`);

const browser = await chromium.connectOverCDP(CDP_URL);
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await dismissModal(page);

let done = 0, failed = 0, skipped = 0;
for (let i = 0; i < spec.slides.length; i++) {
  const n = i + 1;
  const s = spec.slides[i];
  if (onlyList.length && !onlyList.includes(n)) continue;
  const fname = `slide-${String(n).padStart(2, '0')}-${s.name}.png`;
  const fpath = join(outDir, fname);
  if (redoList.includes(n) && existsSync(fpath)) unlinkSync(fpath);
  if (existsSync(fpath)) { console.log(`  ⏭  ${fname} (уже есть)`); skipped++; continue; }

  const attachments = [];
  if (s.ref && spec.refDir) {
    const refAbs = resolve(join(spec.refDir, s.ref));
    if (!existsSync(refAbs)) { console.log(`  ⚠️  нет реф-кадра ${refAbs} — генерю без рефа`); }
    else attachments.push(refAbs);
  }
  const wantFace = !!s.face && facePhoto && existsSync(facePhoto);
  if (wantFace) attachments.push(facePhoto);

  const prompt = [
    head(attachments.length > 0 && !!s.ref),
    wantFace ? FACE_NOTE : '',
    ``,
    `WHAT THIS SLIDE SHOWS:`,
    s.prompt,
    ``,
    `Render it as ONE finished 1080x1350 slide. Every Russian word must be spelled correctly.`,
  ].filter(Boolean).join('\n');

  console.log(`\n  🎨 ${n}/${spec.slides.length}: ${s.name}${wantFace ? ' (+лицо)' : ''}${s.ref ? ` [реф ${s.ref}]` : ''}`);
  try {
    await dismissModal(page);
    const before = new Set(await allBigImgSrcs(page));
    const attached = await attachFiles(page, attachments);
    if (!attached) console.log('     ⚠️ вложение не подтвердилось, пробую дальше');
    await insertPrompt(page, prompt);
    await send(page);
    console.log('     отправлено, жду картинку...');
    const src = await waitForGenerated(page, before, attachments.length);
    if (!src) {
      failed++;
      console.log(`\n  ⚠️ картинки нет — кулдаун ${COOL_MS / 1000}с`);
      await dismissModal(page);
      await new Promise(r => setTimeout(r, COOL_MS));
      continue;
    }
    await saveImg(page, src, fpath);
    done++;
    console.log(`\n  ✅ ${fpath}`);
    await new Promise(r => setTimeout(r, PAUSE_MS));
  } catch (e) {
    failed++;
    console.log(`\n  ❌ ${s.name}: ${String(e.message).slice(0, 100)} — кулдаун ${COOL_MS / 1000}с`);
    await dismissModal(page).catch(() => {});
    await new Promise(r => setTimeout(r, COOL_MS));
  }
}
await page.close();
await browser.close();
console.log(`\n🏁 ${spec.slug}: готово ${done}, пропущено ${skipped}, сбоев ${failed}`);
process.exit(failed && !done ? 1 : 0);
