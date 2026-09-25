#!/usr/bin/env node
/**
 * brand-stamp.mjs — ставит логотип и хэндл на готовые слайды.
 *
 * Зачем отдельным шагом: нейросеть не воспроизводит конкретный логотип, она рисует
 * похожую загогулину, и на каждом слайде разную. Поэтому слайды генерятся чистыми,
 * с пустой полосой внизу, а знак накладывается здесь — пиксель в пиксель и одинаково.
 * Поменять брендинг потом можно не перегенерируя слайды.
 *
 * Запуск (из корня студии):
 *   node scripts/brand-stamp.mjs workspace/carousel/<slug>/format2
 *   node scripts/brand-stamp.mjs <папка> --dry        показать, что будет сделано
 *   node scripts/brand-stamp.mjs <папка> --white      белый знак (для тёмных слайдов)
 *
 * Оригиналы не трогаются: результат кладётся в <папка>/branded/.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const ROOT = resolve(process.cwd());
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const WHITE = argv.includes('--white');
const dirArg = argv.find(a => !a.startsWith('--'));

function die(msg) {
  console.error(`ОШИБКА: ${msg}`);
  process.exit(1);
}

if (!dirArg) die('укажите папку со слайдами: node scripts/brand-stamp.mjs workspace/carousel/<slug>/format2');

const SRC = resolve(ROOT, dirArg);
if (!existsSync(SRC)) die(`не найдена папка: ${SRC}`);

const LOGO = join(ROOT, 'workspace', 'assets', 'photos', 'brand',
  WHITE ? 'logo-white.png' : 'logo-trim.png');
if (!existsSync(LOGO)) die(`не найден логотип: ${LOGO}`);

// Хэндл берём из брендбука, а не из аргумента: одна точка правды.
let handle = '';
try {
  handle = JSON.parse(readFileSync(join(ROOT, 'scripts', '.f2-brand.json'), 'utf8')).handle || '';
} catch { /* бренда нет — поставим только знак */ }

const OUT = join(SRC, 'branded');

const files = readdirSync(SRC)
  .filter(f => /\.png$/i.test(f) && !f.startsWith('_'))
  .sort();

if (files.length === 0) die(`в папке нет PNG: ${SRC}`);

console.log(`знак:   ${basename(LOGO)}`);
console.log(`хэндл:  ${handle || '(нет)'}`);
console.log(`слайдов: ${files.length}`);
console.log(`выход:  ${OUT}\n`);

if (DRY) {
  for (const f of files) console.log(`  ${f}`);
  console.log('\nРежим --dry: ничего не записано.');
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });

// Знак — 3,5% высоты кадра, отступы — 7% слева и 4,5% снизу. Размер считаем в
// пикселях по каждому слайду, а не выражениями внутри фильтра: так предсказуемее.
let ok = 0, fail = 0;
for (const f of files) {
  const src = join(SRC, f);
  const dst = join(OUT, f);

  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x', src,
  ], { encoding: 'utf8', shell: process.platform === 'win32' });

  if (probe.status !== 0) { console.log(`  ❌ ${f}: не читается`); fail++; continue; }
  const [W, H] = probe.stdout.trim().split('x').map(Number);
  if (!W || !H) { console.log(`  ❌ ${f}: не определился размер`); fail++; continue; }

  const logoH = Math.round(H * 0.035);
  const marginX = Math.round(W * 0.07);
  const marginY = Math.round(H * 0.045);
  const fontSize = Math.round(H * 0.019);

  const fc =
    `[1:v]scale=-1:${logoH}[lg];` +
    `[0:v][lg]overlay=${marginX}:H-${logoH}-${marginY}` +
    (handle
      ? `[b];[b]drawtext=text='${handle}':fontcolor=0x6B6058:fontsize=${fontSize}` +
        `:x=W-tw-${marginX}:y=H-${marginY}-${Math.round(logoH * 0.62)}`
      : '');

  const run = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', src, '-i', LOGO,
    '-filter_complex', fc, '-frames:v', '1', dst,
  ], { encoding: 'utf8', shell: process.platform === 'win32' });

  if (run.status === 0 && existsSync(dst)) { console.log(`  ✅ ${f}`); ok++; }
  else { console.log(`  ❌ ${f}: ${(run.stderr || '').trim().split('\n')[0]}`); fail++; }
}

console.log(`\nготово: ${ok}, с ошибкой: ${fail}`);
console.log(`оригиналы не тронуты, фирменные слайды — в ${OUT}`);
process.exitCode = fail > 0 ? 1 : 0;
