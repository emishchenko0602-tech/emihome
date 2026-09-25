/**
 * omni-assemble.mjs — сборка ролика из кусков, смонтированных Omni.
 *
 * ЗВУК ПО УМОЛЧАНИЮ — ОТ OMNI. Прогнали через Omni — берём то, что он отдал,
 * вместе со звуком. Подмена дорожки на оригинал делается ТОЛЬКО по прямой просьбе
 * автора ролика, когда финал не понравился: флаг `--src-audio`.
 *
 * Что делает `--src-audio`: видео от Omni + аудио из исходной части. Тайминг совпадает,
 * потому что Omni монтировал ровно этот кусок — губы не разъезжаются. Цена в том, что
 * пропадает всё, что Omni сделал со звуком.
 *
 * Плюс: апскейл 720→1080 (Flow отдаёт 720×1280) и бейдж поверх вотермарка.
 *
 * Запуск:
 *   node scripts/omni-assemble.mjs <omniDir> <partsDir> <prefix> <out.mp4> [--no-badge] [--src-audio]
 * Пример:
 *   node scripts/omni-assemble.mjs workspace/reels/plagin-live/omni \
 *        workspace/reels/plagin-live/parts lv workspace/reels/plagin-live/final.mp4
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';

const FF = process.env.FFMPEG || 'D:/tools/ffmpeg/bin/ffmpeg';
const [omniDir, partsDir, prefix, outFile] = process.argv.slice(2);
const NO_BADGE = process.argv.includes('--no-badge');
const SRC_AUDIO = process.argv.includes('--src-audio');
if (!omniDir || !partsDir || !prefix || !outFile) {
  console.error('usage: node scripts/omni-assemble.mjs <omniDir> <partsDir> <prefix> <out.mp4> [--no-badge] [--src-audio]');
  process.exit(2);
}
const BADGE = resolve('workspace/reels/engine/badge.png');
const tmp = resolve(dirname(outFile), '_assemble');
mkdirSync(tmp, { recursive: true });

// какие части реально смонтированы
const nums = readdirSync(omniDir)
  .filter(f => new RegExp(`^${prefix}\\d+-omni\\.mp4$`).test(f))
  .map(f => Number(f.match(/(\d+)/)[1]))
  .sort((a, b) => a - b);

if (!nums.length) { console.error('нет смонтированных частей'); process.exit(1); }
console.log(`\n🎬 сборка ${prefix}: части ${nums.join(', ')}`);
console.log(SRC_AUDIO
  ? '   🔊 звук: ИЗ ИСХОДНИКА (--src-audio) — только по прямой просьбе'
  : '   🔊 звук: от Omni');

const missing = [];
for (let n = 1; n <= Math.max(...nums); n++) if (!nums.includes(n)) missing.push(n);
if (missing.length) console.log(`   ⚠️ пропущены части: ${missing.join(', ')} — ролик будет с дырой`);

const pieces = [];
for (const n of nums) {
  const v = resolve(join(omniDir, `${prefix}${n}-omni.mp4`));
  const a = resolve(join(partsDir, `${prefix}${n}-video.mp4`));
  if (SRC_AUDIO && !existsSync(a)) { console.log(`   ❌ нет исходной части ${n} для звука — пропуск`); continue; }
  const out = join(tmp, `${prefix}${n}-fix.mp4`);
  // апскейл до 1080 по ширине; звук — от Omni, либо из оригинала при --src-audio
  const input = SRC_AUDIO ? `-i "${v}" -i "${a}" -map 0:v:0 -map 1:a:0` : `-i "${v}" -map 0:v:0 -map 0:a:0?`;
  execSync(`"${FF}" -y ${input} ` +
    `-vf "scale=1080:1920:flags=lanczos" -c:v libx264 -preset medium -crf 19 ` +
    `-c:a aac -b:a 192k -shortest -loglevel error "${out}"`, { stdio: 'inherit' });
  pieces.push(out);
  console.log(`   ✅ часть ${n}: видео Omni + звук ${SRC_AUDIO ? 'оригинала' : 'Omni'}`);
}

const listFile = join(tmp, 'list.txt');
writeFileSync(listFile, pieces.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

const joined = join(tmp, 'joined.mp4');
execSync(`"${FF}" -y -f concat -safe 0 -i "${listFile}" -c copy -loglevel error "${joined}"`, { stdio: 'inherit' });

if (!NO_BADGE && existsSync(BADGE)) {
  execSync(`"${FF}" -y -i "${joined}" -i "${BADGE}" ` +
    `-filter_complex "[1]scale=260:-1[b];[0][b]overlay=785:1630" ` +
    `-c:v libx264 -preset medium -crf 19 -c:a copy -loglevel error "${resolve(outFile)}"`, { stdio: 'inherit' });
  console.log('   ✅ бейдж поверх вотермарка');
} else {
  execSync(`"${FF}" -y -i "${joined}" -c copy -loglevel error "${resolve(outFile)}"`, { stdio: 'inherit' });
}

rmSync(tmp, { recursive: true, force: true });
// Путь вида D:/tools/ffmpeg/bin/ffmpeg содержит «ffmpeg» дважды — простая замена
// портила каталог. Меняем только последнее вхождение, то есть имя самого файла.
const FFPROBE = FF.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'));
const dur = execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${resolve(outFile)}"`).toString().trim();
console.log(`\n🏁 ${outFile} — ${Number(dur).toFixed(1)} с, частей ${pieces.length}`);
console.log('   ⚠️ сверить звук расшифровкой: Omni иногда задваивает слова.');
console.log('   Подменять дорожку на оригинал (--src-audio) — только по прямой просьбе автора.');
