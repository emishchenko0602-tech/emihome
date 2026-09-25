#!/usr/bin/env node
// flow-launch.mjs
// Поднимает Chrome с ОТДЕЛЬНЫМ профилем под Google Flow (labs.google/fx/tools/flow)
// на порту CDP 9223. Логинишься в Google ОДИН раз в открывшемся окне — дальше
// профиль хранит сессию, и flow-generate.mjs подключается к этому же Chrome.
//
// Запуск:  node scripts/flow-launch.mjs
// Окно НЕ закрывать — генератор ходит в этот же браузер.

import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = 'd:\\Claude-Projects\\auth\\chrome-flow-profile';
const PORT = 9223;
const URL = 'https://labs.google/fx/tools/flow';

// Гео-настройка (файл необязательный, лежит вне git):
//   scripts/.flow-geo.json → { "proxy": "socks5://host:port", "requireCountry": "US" }
// proxy: если задан, подставляется флагом --proxy-server ТОЛЬКО этому экземпляру Chrome.
//        Профиль ChatGPT на 9222 он не задевает.
// requireCountry: жёстко потребовать конкретную страну. Обычно НЕ нужно.
//
// По умолчанию работает не белый список, а чёрный: подходящих стран у Flow около
// двух сотен (США, Бразилия, Турция, Казахстан, ОАЭ, Япония и так далее), и требовать
// именно США неправильно. Запрещены три группы:
//   1. ЕЭЗ, Швейцария, Британия — Flow там открывается и генерирует, но НЕ даёт
//      редактировать ЗАГРУЖЕННОЕ видео, а на этом стоят наши конвейеры монтажа.
//      Худший случай: конвейер уходит заливать ролик и встаёт без ошибки.
//   2. Россия и Беларусь — Flow недоступен вовсе.
//   3. Страны под санкциями, где сервис тоже закрыт.
const GEO_PATH = 'scripts/.flow-geo.json';
// BOM режем сами: файл часто создают руками через PowerShell, а Out-File -Encoding utf8
// пишет его с BOM, и JSON.parse падает на первом символе.
function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')); }
  catch (e) { console.error(`[flow-launch] ${p} не читается как JSON: ${e.message}`); process.exit(1); }
}
const geo = existsSync(GEO_PATH) ? readJsonSafe(GEO_PATH) : {};
const SKIP_GEO = process.argv.includes('--skip-geo');

// ЕЭЗ = ЕС + Исландия, Лихтенштейн, Норвегия.
const EEA = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO'];
const NO_UPLOAD_EDIT = [...EEA, 'CH', 'GB'];
const NO_FLOW_AT_ALL = ['RU', 'BY', 'CN', 'IR', 'KP', 'SY', 'CU', 'AF'];
const BLOCKED = new Set([...NO_UPLOAD_EDIT, ...NO_FLOW_AT_ALL, ...(geo.blockCountries ?? [])]);

function log(...a) { console.log('[flow-launch]', ...a); }

async function main() {
  if (!existsSync(CHROME)) { console.error('Chrome не найден:', CHROME); process.exit(1); }

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
  ];
  if (geo.proxy) {
    args.push(`--proxy-server=${geo.proxy}`);
    log('Прокси из .flow-geo.json подставлен этому окну Chrome');
  }
  args.push(URL);

  const chrome = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  chrome.unref();

  log('Chrome поднят на порту', PORT, '— профиль:', PROFILE);

  // Ждём CDP
  let browser = null;
  for (let i = 0; i < 30 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://localhost:${PORT}`); }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  if (!browser) { console.error('Не удалось подключиться к CDP на', PORT); process.exit(1); }

  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  // --- предполётная проверка страны ---
  // Смотрим адрес ИМЕННО из этого профиля: расширение-VPN или --proxy-server
  // действуют только здесь, и системный ipconfig о них ничего не знает.
  if (!SKIP_GEO) {
    const probe = await ctx.newPage();
    let seen = null;
    try {
      await probe.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 30000 });
      const info = JSON.parse(await probe.evaluate(() => document.body.innerText));
      seen = info.country;
      log(`Адрес выхода: ${info.country} · ${info.city ?? '?'} · ${info.org ?? '?'}`);
    } catch (e) {
      log('Не удалось проверить адрес:', e.message.split('\n')[0]);
    }
    await probe.close().catch(() => {});

    const want = geo.requireCountry ?? null;
    const bad =
      (want && seen !== want) ? `нужна страна ${want}, а выход ${seen ?? 'неизвестен'}` :
      (!seen) ? 'страну выхода определить не удалось' :
      BLOCKED.has(seen) ? `страна выхода ${seen} для Flow не годится` : null;

    if (bad) {
      console.error('');
      console.error(`[СТОП] ${bad}.`);
      if (seen && NO_UPLOAD_EDIT.includes(seen)) {
        console.error('  Это ЕЭЗ, Швейцария или Британия: Flow там откроется и даже сгенерирует,');
        console.error('  но НЕ даст редактировать загруженное видео. Конвейер уйдёт заливать ролик');
        console.error('  и встанет на середине без единой ошибки в чате.');
      } else if (seen && NO_FLOW_AT_ALL.includes(seen)) {
        console.error('  В этой стране Flow недоступен вовсе.');
      }
      console.error('');
      console.error('  Что сделать: включить VPN в открывшемся окне Chrome. Многие расширения');
      console.error('  после перезапуска браузера стартуют ВЫКЛЮЧЕННЫМИ, а скрипты перезапускают');
      console.error('  Chrome постоянно — это и есть самая частая причина.');
      console.error(`  Надёжнее прописать прокси в ${GEO_PATH}:`);
      console.error('    { "proxy": "socks5://хост:порт" }');
      console.error('  Он подставится флагом запуска и выключиться сам не может.');
      console.error('');
      console.error('  Окно Chrome оставлено открытым. Проверка снимается флагом --skip-geo.');
      await browser.close().catch(() => {});
      process.exit(1);
    }
    if (seen && seen !== 'US') {
      log(`Страна ${seen} в списке Flow есть и под ограничение заливки не попадает. Работаем.`);
    }
  }

  log('URL страницы:', page.url());
  const loggedIn = !/accounts\.google\.com|\/signin/.test(page.url());
  if (loggedIn) {
    log('Похоже, уже залогинен. Flow готов.');
  } else {
    log('Нужен логин в Google — войди в открывшемся окне. Окно НЕ закрывай.');
  }

  await browser.close().catch(() => {}); // отключаем CDP-клиента, сам Chrome остаётся жить
  log('Готово. Окно Chrome оставь открытым для flow-generate.mjs.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
