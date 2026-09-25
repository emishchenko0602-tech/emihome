/**
 * flow-omni-queue.mjs — прогоняет очередь Omni-джоб последовательно, с ожиданием
 * завершения каждой. Flow не умеет в параллель: вторая отправка затирает первую.
 *
 * Запуск:
 *   node scripts/flow-omni-queue.mjs <prefix> <dirWithPrompts> <from> <to>
 * Пример:
 *   node scripts/flow-omni-queue.mjs lv workspace/reels/plagin-live/storyboard 2 6
 *
 * Для каждой части N: борд «<prefix>N-board» + видео «<prefix>N-snd» + промпт pN-omni.txt.
 * Суффикс борда меняется флагом `--board-suffix` (пример: `-board2` для переснятых бордов).
 * Видео заливается СО ЗВУКОМ — немой вход Omni озвучивает сам, выдумывая текст и голос.
 * Суффикс видео меняется флагом `--video-suffix`, но по умолчанию только `-snd`.
 * Результаты не скачивает — это отдельный шаг (опознавать по содержимому, не по порядку).
 */
import { chromium } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const [prefix, dir, fromS, toS] = process.argv.slice(2);
if (!prefix || !dir) {
  console.error('usage: node scripts/flow-omni-queue.mjs <prefix> <promptDir> <from> <to>');
  process.exit(2);
}
const from = Number(fromS || 1), to = Number(toS || 6);
const vsIdx = process.argv.indexOf('--video-suffix');
const VIDEO_SUFFIX = vsIdx >= 0 ? process.argv[vsIdx + 1] : '-snd';
const bsIdx = process.argv.indexOf('--board-suffix');
const BOARD_SUFFIX = bsIdx >= 0 ? process.argv[bsIdx + 1] : '-board';
const CDP = process.env.FLOW_CDP || 'http://127.0.0.1:9223';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const b = await chromium.connectOverCDP(CDP);
const p = b.contexts()[0].pages().find(x => /flow\/project/.test(x.url()));
if (!p) { console.error('НЕТ вкладки с проектом Flow'); process.exit(1); }
await p.bringToFront();

const chips = () => p.evaluate(() =>
  [...document.querySelectorAll('button')]
    .filter(x => (x.textContent || '').trim().startsWith('cancel')
      && x.getBoundingClientRect().y > innerHeight * 0.35).length);

async function clearChips() {
  for (let i = 0; i < 8; i++) {
    const c = await p.evaluate(() => {
      const e = [...document.querySelectorAll('button')]
        .find(x => (x.textContent || '').trim().startsWith('cancel') && x.getBoundingClientRect().y > innerHeight * 0.35);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!c) break;
    await p.mouse.click(c.x, c.y);
    await wait(800);
  }
  await p.keyboard.press('Escape');
}

// Режим композера сбрасывается на «Frames» сам по себе, и в этом режиме Omni отдаёт
// КОПИЮ ИСХОДНИКА без единого элемента монтажа, отчитавшись успехом. Поэтому перед
// каждой отправкой жмём «Ingredients» — клик идемпотентный, лишним не будет.
async function ensureIngredients() {
  await p.keyboard.press('Escape'); await wait(400);
  const chip = await p.evaluate(() => {
    const e = [...document.querySelectorAll('button,[role="button"]')]
      .find(x => /Video\s*[·•]/.test(x.textContent || '') && x.getBoundingClientRect().y > innerHeight * 0.75);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!chip) { console.log('   ⚠️ чип настроек не найден — режим не проверен'); return; }
  await p.mouse.click(chip.x, chip.y); await wait(1600);
  const hit = await p.evaluate(() => {
    const e = [...document.querySelectorAll('button,[role="button"]')]
      .find(x => /^(chrome_extension)?Ingredients$|Malzemeler/.test((x.textContent || '').trim()));
    if (!e) return false;
    const r = e.getBoundingClientRect();
    e.click(); return true;
  });
  await wait(800);
  await p.keyboard.press('Escape'); await wait(500);
  console.log(hit ? '   ⚙️ режим Ingredients' : '   ⚠️ кнопка Ingredients не найдена');
}

async function openPicker() {
  await p.keyboard.press('Escape'); await wait(400);
  const plus = await p.evaluate(() => {
    const e = [...document.querySelectorAll('button')]
      .find(x => /add_2/i.test(x.textContent || '') && x.getBoundingClientRect().y > innerHeight * 0.7);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!plus) throw new Error('кнопка композера не найдена');
  await p.mouse.click(plus.x, plus.y);
  await wait(1800);
}

async function attach(name) {
  await openPicker();
  const box = await p.evaluate(() => {
    const i = [...document.querySelectorAll('input')].find(x => /ara|search/i.test(x.placeholder || ''));
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!box) throw new Error('поле поиска не найдено');
  await p.mouse.click(box.x, box.y); await wait(300);
  await p.keyboard.insertText(name); await wait(2400);
  const before = await chips();
  const btn = await p.evaluate(() => {
    const e = [...document.querySelectorAll('button')]
      .find(x => /İsteme ekle|Add to Prompt/i.test((x.textContent || '').trim()));
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!btn) throw new Error(`ассет «${name}» не найден`);
  await p.mouse.click(btn.x, btn.y); await wait(2500);
  const after = await chips();
  if (after <= before) throw new Error(`чип «${name}» не прицепился`);
}

async function typePrompt(text) {
  await p.keyboard.press('Escape'); await wait(500);
  const ok = await p.evaluate(() => {
    const d = [...document.querySelectorAll('div[contenteditable="true"], textarea')]
      .filter(e => e.getBoundingClientRect().width > 200);
    if (!d.length) return false;
    d[d.length - 1].focus();
    return true;
  });
  if (!ok) throw new Error('поле промпта не найдено');
  await wait(300);
  await p.keyboard.press('Control+A');
  await p.keyboard.press('Delete');
  await wait(300);
  await p.keyboard.insertText(text);
  await wait(1000);
  const got = await p.evaluate(() => {
    const d = [...document.querySelectorAll('div[contenteditable="true"], textarea')]
      .filter(e => e.getBoundingClientRect().width > 200);
    return d.length ? Math.max(...d.map(e => (e.innerText || e.value || '').length)) : 0;
  });
  if (got > text.length * 1.2) throw new Error(`промпт задвоился (${got}/${text.length})`);
  if (got < text.length * 0.5) throw new Error(`промпт вставился частично (${got}/${text.length})`);
}

async function send() {
  const go = await p.evaluate(() => {
    const e = [...document.querySelectorAll('button')]
      .find(x => /arrow_forward/i.test(x.textContent || '') && !x.disabled);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!go) throw new Error('кнопка отправки неактивна');
  await p.mouse.click(go.x, go.y);
  await wait(4000);
}

async function waitDone(maxMin = 10) {
  const deadline = Date.now() + maxMin * 60000;
  await wait(8000);
  while (Date.now() < deadline) {
    // подписи бывают турецкие и английские — ловим оба языка
    const busy = await p.evaluate(() => {
      const t = document.body.innerText;
      return /Oluşturuluyor|oluşturuluyor|Generating|generating/.test(t) || /\d{1,3}%/.test(t);
    });
    if (!busy) return true;
    await wait(12000);
  }
  return false;
}

// Policy-фильтр Flow срабатывает уже ПОСЛЕ отправки: генерация отваливается с текстом
// про нарушение правил. При заливке со звуком триггером бывает сама речь — ловим отдельно,
// чтобы не принять пустой результат за успех.
const policyHit = () => p.evaluate(() => {
  const t = document.body.innerText;
  return /violate our policies|may violate|ihlal ed|politika/i.test(t);
});

let ok = 0, bad = 0, policy = 0;
for (let n = from; n <= to; n++) {
  const promptFile = join(dir, `p${n}-omni.txt`);
  if (!existsSync(promptFile)) { console.log(`  ⏭  часть ${n}: нет промпта`); continue; }
  const text = readFileSync(promptFile, 'utf8').replace(/\r?\n+/g, ' ').trim();
  console.log(`\n▶ ${prefix}${n}: борд + видео + промпт ${text.length} симв.`);
  try {
    await clearChips();
    await ensureIngredients();
    await attach(`${prefix}${n}${BOARD_SUFFIX}`);
    await attach(`${prefix}${n}${VIDEO_SUFFIX}`);
    await typePrompt(text);
    await send();
    console.log('   🚀 отправлено, жду...');
    const done = await waitDone();
    if (await policyHit()) {
      policy++;
      console.log('   🚫 policy: генерацию завернули. Со звуком триггером бывает сама речь —');
      console.log('      переписать реплику, НЕ глушить дорожку (правило).');
    } else {
      console.log(done ? '   ✅ генерация завершена' : '   ⏱ вышло время ожидания');
      ok++;
    }
  } catch (e) {
    bad++;
    console.log(`   ❌ ${String(e.message).slice(0, 90)}`);
    await clearChips().catch(() => {});
  }
  await wait(5000);
}
console.log(`\n🏁 очередь ${prefix}: отправлено ${ok}, сбоев ${bad}, policy ${policy}`);
process.exit(0);
