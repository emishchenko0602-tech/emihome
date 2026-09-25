/**
 * flow-assets-check.mjs — проверяет, что ассеты реально долетели в проект Flow.
 *
 * Ищет каждое имя через поиск В ПИКЕРЕ КОМПОЗЕРА (то же место, откуда потом цепляются
 * чипы) — левая медиатека прячет поиск за иконку и селектором не ловится.
 *
 * Usage: node scripts/flow-assets-check.mjs lv1-board lv1-snd ...
 */
import { chromium } from '@playwright/test';

const names = process.argv.slice(2);
if (!names.length) { console.error('usage: node scripts/flow-assets-check.mjs <name...>'); process.exit(2); }
const b = await chromium.connectOverCDP(process.env.FLOW_CDP || 'http://127.0.0.1:9223');
const p = b.contexts()[0].pages().find(x => /flow\/project/.test(x.url()));
if (!p) { console.error('нет вкладки Flow'); process.exit(1); }
await p.bringToFront();
const wait = ms => new Promise(r => setTimeout(r, ms));

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

await openPicker();
const box = await p.evaluate(() => {
  const i = [...document.querySelectorAll('input')].find(x => /ara|search/i.test(x.placeholder || ''));
  if (!i) return null;
  const r = i.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (!box) { console.error('поле поиска в пикере не найдено'); process.exit(1); }

let missing = [];
for (const n of names) {
  await p.mouse.click(box.x, box.y); await wait(300);
  await p.keyboard.press('Control+A'); await p.keyboard.press('Delete');
  await p.keyboard.insertText(n); await wait(2400);
  const found = await p.evaluate((nx) => {
    const t = document.body.innerText;
    return t.includes(nx);
  }, n);
  console.log(`  ${found ? '✅' : '❌'} ${n}`);
  if (!found) missing.push(n);
}
await p.keyboard.press('Escape');
console.log(missing.length ? `\n⚠️ не долетело: ${missing.join(', ')}` : '\n🏁 все ассеты на месте');
process.exit(missing.length ? 1 : 0);
