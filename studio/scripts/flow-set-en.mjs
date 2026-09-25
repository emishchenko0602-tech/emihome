/**
 * flow-set-en.mjs — переводит Flow на английский интерфейс.
 *
 * Локаль сидит в URL (`/fx/tr/…` vs `/fx/en/…`), но простой переход на /fx/en/ Google
 * разворачивает обратно: язык берётся из настроек Google-аккаунта. Поэтому пробуем
 * по очереди: `?hl=en` → `/fx/en/` → смена языка аккаунта на myaccount.google.com/language.
 *
 * Запуск: node scripts/flow-set-en.mjs
 */
import { chromium } from '@playwright/test';

const CDP = process.env.FLOW_CDP || 'http://127.0.0.1:9223';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const b = await chromium.connectOverCDP(CDP);
const ctx = b.contexts()[0];
const p = ctx.pages().find(x => /flow\/project/.test(x.url()));
if (!p) { console.error('НЕТ вкладки с проектом Flow'); process.exit(1); }
await p.bringToFront();

const probe = () => p.evaluate(() => {
  const t = document.body.innerText;
  return {
    tr: /Oluştur|Malzemeler|İsteme ekle|Medya ekle|Ayarları/.test(t),
    en: /Generate|Ingredients|Add to Prompt|Add media|Show settings/.test(t),
  };
});

const base = p.url().split('?')[0];
console.log('было:', p.url());

for (const target of [`${base}?hl=en`, base.replace(/\/fx\/[a-z]{2}\//, '/fx/en/')]) {
  await p.goto(target, { waitUntil: 'domcontentloaded' });
  await wait(7000);
  const s = await probe();
  console.log(`  ${target.slice(0, 70)}… → TR:${s.tr} EN:${s.en}`);
  if (s.en && !s.tr) { console.log('✅ английский интерфейс'); process.exit(0); }
}

console.log('⚠️ URL-ом не переключилось — язык берётся из аккаунта.');
console.log('   Меняю язык Google-аккаунта на English…');
const lang = await ctx.newPage();
await lang.goto('https://myaccount.google.com/language?hl=en', { waitUntil: 'domcontentloaded' });
await wait(6000);
console.log('   открыта страница языка аккаунта — дальше руками или следующим шагом');
process.exit(0);
