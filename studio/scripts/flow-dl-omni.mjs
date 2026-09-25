/**
 * flow-dl-omni.mjs — качает результаты Omni-монтажа из проекта Flow по API проекта.
 *
 * Проект берётся из URL открытой вкладки, а не из константы. Результаты опознаются
 * по времени создания: `--after <ISO>` (по умолчанию — последние 30 минут). Порядок
 * в гриде плавает и там же лежат исходники, поэтому берём именно свежие генерации
 * с заголовком «Edit this video…» и статусом SUCCESSFUL.
 *
 * Запуск:
 *   node scripts/flow-dl-omni.mjs <out.mp4> [--after <ISO>] [--skip N] [--list]
 *   --list   — только показать свежие генерации, ничего не качать
 *   --skip N — пропустить N самых свежих (когда за раз сделано несколько)
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const LIST = process.argv.includes('--list');
const SKIP = Number(arg('--skip', 0));
const AFTER = arg('--after', new Date(Date.now() - 30 * 60000).toISOString());
if (!OUT && !LIST) { console.error('usage: node scripts/flow-dl-omni.mjs <out.mp4> [--after ISO] [--skip N] [--list]'); process.exit(2); }

const wait = ms => new Promise(r => setTimeout(r, ms));
const b = await chromium.connectOverCDP(process.env.FLOW_CDP || 'http://127.0.0.1:9223');
const p = b.contexts()[0].pages().find(x => /flow\/project/.test(x.url()));
if (!p) { console.error('нет вкладки Flow'); process.exit(1); }
const PID = p.url().match(/project\/([0-9a-f-]+)/)?.[1];
if (!PID) { console.error('не разобрал projectId из URL'); process.exit(1); }
console.log('проект:', PID, '| свежее чем', AFTER);

async function getMedia() {
  const u = `https://labs.google/fx/api/trpc/flow.projectInitialData?input=${encodeURIComponent(JSON.stringify({ json: { projectId: PID } }))}`;
  try {
    const resp = await p.request.get(u);
    if (!resp.ok()) return null;
    const j = await resp.json();
    return j?.result?.data?.json?.projectContents?.media || null;
  } catch { return null; }
}

for (let i = 0; i < 30; i++) {
  const media = await getMedia();
  if (!media) { console.log(`  poll ${i}: данные проекта не пришли`); await wait(15000); continue; }
  const fresh = media
    .filter(m => (m.mediaMetadata?.mediaTitle || '').startsWith('Edit this video'))
    .filter(m => (m.mediaMetadata?.createTime || '') > AFTER)
    .sort((a, c) => (c.mediaMetadata.createTime).localeCompare(a.mediaMetadata.createTime));

  if (LIST) {
    fresh.forEach((m, k) => console.log(`  [${k}] ${m.mediaMetadata.createTime} ${m.mediaMetadata?.mediaStatus?.mediaGenerationStatus} ${m.name}`));
    console.log(`всего свежих: ${fresh.length}`);
    process.exit(0);
  }

  const m = fresh[SKIP];
  if (!m) { console.log(`  poll ${i}: свежих генераций пока нет`); await wait(15000); continue; }
  const st = m.mediaMetadata?.mediaStatus?.mediaGenerationStatus || '?';
  console.log(`  poll ${i}: ${st} ${m.mediaMetadata.createTime}`);
  if (st === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
    const resp = await p.request.get(`https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${m.name}`);
    const body = await resp.body();
    if (body.length < 100000) { console.log(`  тело ${body.length} байт — мало, повтор`); await wait(12000); continue; }
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, body);
    console.log(`✅ ${OUT} — ${(body.length / 1e6).toFixed(2)} МБ`);
    process.exit(0);
  }
  if (/FAILED|ERROR/.test(st)) { console.log('❌ генерация провалилась:', st); process.exit(2); }
  await wait(15000);
}
console.log('⏱ вышло время ожидания');
process.exit(3);
