#!/usr/bin/env node
/**
 * site-deploy.mjs — деплой сайта-витрины.
 *
 * Провайдер берётся из site/site.config.json, поле "provider":
 *   "layero" — хостинг с серверами в России (npx layero@latest deploy);
 *   "vercel" — Vercel (значение по умолчанию, если поля нет).
 *
 * Vercel всегда требует ДВЕ команды: сборку (`vercel deploy --prod`) и перевод
 * домена на неё (`vercel alias set`). Без второго шага домен остаётся на прошлой
 * сборке — страница отдаёт 200, но старую, и это выглядит как «деплой не сработал».
 * У Layero тот же смысл несёт флаг --promote: он двигает production-указатель
 * на свежий деплой.
 *
 * Запуск (из корня студии):
 *   node scripts/site-deploy.mjs              # деплой + продакшен + проверка 200
 *   node scripts/site-deploy.mjs --check      # только проверить, что домен живой
 *   node scripts/site-deploy.mjs --no-alias   # деплой без перевода домена (превью)
 *
 * Домен берётся из site/site.config.json (поле domain). Если он пуст — скрипт
 * подставит домен первого деплоя и запишет его туда сам.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const SITE = join(ROOT, 'site');
const CONFIG = join(SITE, 'site.config.json');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const NO_ALIAS = argv.includes('--no-alias');

function die(msg) {
  console.error(`ОШИБКА: ${msg}`);
  process.exit(1);
}

if (!existsSync(SITE)) die(`не найдена папка сайта: ${SITE}`);
if (!existsSync(CONFIG)) die(`не найден ${CONFIG}`);

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const PROVIDER = (config.provider || 'vercel').toLowerCase();

if (!['layero', 'vercel'].includes(PROVIDER)) {
  die(`неизвестный provider в site.config.json: ${config.provider} (ожидается "layero" или "vercel")`);
}

// Имя проекта у провайдера — оно же адрес сайта при первом деплое.
const PROJECT = (config.projectName || config.brand || 'studio')
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/^-+|-+$/g, '');

function run(cmd, args, opts = {}) {
  console.log(`$ npx ${cmd} ${args.join(' ')}`);
  const res = spawnSync('npx', ['--yes', cmd, ...args], {
    cwd: SITE,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (res.error) die(`не удалось запустить ${cmd}: ${res.error.message}`);
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (out) console.log(out);
  if (res.status !== 0) {
    if (/not authenticated|credentials|log ?in|not logged in/i.test(out)) {
      die(PROVIDER === 'layero'
        ? 'вход в Layero не выполнен — запустите `npx layero@latest login` и повторите'
        : 'вход в Vercel не выполнен — запустите `npx vercel login` (кнопка «Continue with GitHub») и повторите');
    }
    die(`${cmd} завершился с кодом ${res.status}`);
  }
  return out;
}

async function check(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    return res.status;
  } catch (e) {
    return `нет ответа (${e.message})`;
  }
}

function saveDomain(target) {
  config.domain = target;
  writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`домен записан в site/site.config.json: ${target}`);
}

// Сразу после деплоя домен какое-то время отдаёт 404: у Layero контейнер
// поднимается по запросу, edge прогревается не мгновенно. Один запрос здесь
// врёт — поэтому повторяем, прежде чем объявлять деплой неудачным.
async function verify(target, attempts = 10, pauseMs = 6000) {
  const url = `https://${target}`;
  let status;
  for (let i = 1; i <= attempts; i++) {
    status = await check(url);
    if (status === 200) {
      console.log(`\nпроверка: ${url} → 200`);
      return;
    }
    if (i < attempts) {
      console.log(`проверка ${i}/${attempts}: ${url} → ${status}, ждём прогрева…`);
      await new Promise(r => setTimeout(r, pauseMs));
    }
  }
  console.log(`\nпроверка: ${url} → ${status}`);
  console.error('домен не отдаёт 200 — не публикуйте воронку на этот адрес, пока не разберётесь');
  process.exitCode = 1;
}

// ─── Layero ───────────────────────────────────────────────────────────────────

async function deployLayero(domain) {
  const args = ['deploy', '--yes', '--json'];
  if (!NO_ALIAS) args.push('--prod', '--promote');
  // --name действует только на первом деплое; дальше проект берётся из .layero/project.json
  if (!existsSync(join(SITE, '.layero', 'project.json'))) args.push('--name', PROJECT);

  const out = run('layero@latest', args);

  // Вывод — JSON-lines; адрес живого сайта лежит в поле url последнего события,
  // где оно есть. dashboard_url — это панель управления, а не сайт.
  let url = '';
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const ev = JSON.parse(s);
      if (ev.url) url = ev.url;
      if (ev.event === 'error' || ev.error) die(`Layero: ${ev.error || ev.message || s}`);
    } catch { /* не JSON — пропускаем */ }
  }
  if (!url) die('не удалось выцепить URL сборки из вывода layero');

  const target = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  console.log(`\nсборка: https://${target}`);

  if (NO_ALIAS) return;
  if (!domain) saveDomain(target);
  await verify(domain || target);
}

// ─── Vercel ───────────────────────────────────────────────────────────────────

async function deployVercel(domain) {
  const out = run('vercel', ['deploy', '--prod', '--yes']);
  const match = out.match(/https:\/\/[^\s]+\.vercel\.app/g);
  if (!match) die('не удалось выцепить URL сборки из вывода vercel');
  const deployUrl = match[match.length - 1];
  console.log(`\nсборка: ${deployUrl}`);

  let target = domain;
  if (!target) {
    // Первый деплой: постоянный домен проекта = <проект>.vercel.app.
    target = deployUrl.replace(/^https:\/\//, '').replace(/-[a-z0-9]+-[a-z0-9-]+\.vercel\.app$/, '.vercel.app');
    console.log(`домен в конфиге пуст — беру ${target}`);
  }

  if (NO_ALIAS) return;
  run('vercel', ['alias', 'set', deployUrl, target]);
  if (!domain) saveDomain(target);
  await verify(target);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const domain = config.domain?.trim();

if (CHECK_ONLY) {
  if (!domain) die('домен ещё не задан в site/site.config.json — сначала выполните деплой');
  const status = await check(`https://${domain}`);
  console.log(`https://${domain} → ${status}`);
  process.exitCode = status === 200 ? 0 : 1;
} else {
  console.log(`провайдер: ${PROVIDER}`);
  if (PROVIDER === 'layero') await deployLayero(domain);
  else await deployVercel(domain);
}
