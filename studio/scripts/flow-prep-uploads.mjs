/**
 * flow-prep-uploads.mjs — готовит части к заливке во Flow.
 *
 * ПРАВИЛО: во Flow части заливаются ТОЛЬКО СО ЗВУКОМ. Немых заливок нет —
 * на немом входе Omni сочиняет озвучку с нуля. Скрипт копирует части под уникальными
 * именами `<prefix>N-snd.mp4` и падает, если у части нет аудиодорожки.
 *
 * Запуск:
 *   node scripts/flow-prep-uploads.mjs <partsDir> <prefix> [outDir]
 * Пример:
 *   node scripts/flow-prep-uploads.mjs workspace/reels/plagin-live/parts lv
 */
import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const FF = process.env.FFMPEG || 'D:/tools/ffmpeg/bin/ffmpeg';
const FFPROBE = FF.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'));

const [partsDir, prefix, outDirArg] = process.argv.slice(2);
if (!partsDir || !prefix) {
  console.error('usage: node scripts/flow-prep-uploads.mjs <partsDir> <prefix> [outDir]');
  process.exit(2);
}
const outDir = resolve(outDirArg || 'workspace/reels/_flow-upload');
mkdirSync(outDir, { recursive: true });

const nums = readdirSync(partsDir)
  .filter(f => new RegExp(`^${prefix}\\d+-video\\.mp4$`).test(f))
  .map(f => Number(f.match(/(\d+)/)[1]))
  .sort((a, b) => a - b);
if (!nums.length) { console.error(`нет частей ${prefix}N-video.mp4 в ${partsDir}`); process.exit(1); }

let bad = 0;
for (const n of nums) {
  const src = resolve(join(partsDir, `${prefix}${n}-video.mp4`));
  const dst = join(outDir, `${prefix}${n}-snd.mp4`);
  const streams = execSync(`"${FFPROBE}" -v error -show_entries stream=codec_type -of csv=p=0 "${src}"`).toString();
  const hasAudio = /audio/.test(streams);
  if (!hasAudio) { console.log(`   ❌ часть ${n}: НЕТ звука — во Flow не заливаем`); bad++; continue; }
  copyFileSync(src, dst);
  const dur = execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${dst}"`).toString().trim();
  console.log(`   ✅ ${prefix}${n}-snd.mp4 — ${Number(dur).toFixed(1)} с, звук есть`);
}
console.log(`\n🏁 готово к заливке: ${nums.length - bad} из ${nums.length} → ${outDir}`);
if (bad) { console.log('   ⚠️ части без звука пропущены. Немыми во Flow не заливать (правило).'); process.exit(1); }
