/**
 * omni-cut-repeats.mjs — вырезает из части куски со задвоенными словами.
 *
 * Omni иногда повторяет слово-другое в дорожке. Правило: такое НЕ перегенерируем —
 * вырезаем кусок с повтором (видео и звук вместе), остальное остаётся нетронутым.
 * Перегенерация только если дорожка расходится с оригиналом по смыслу.
 *
 * Запуск:
 *   node scripts/omni-cut-repeats.mjs <in.mp4> <out.mp4> <от-до> [<от-до> ...]
 * Пример (вырезать 2.10–2.65 и 5.00–5.40):
 *   node scripts/omni-cut-repeats.mjs lv3-omni.mp4 lv3-fix.mp4 2.10-2.65 5.00-5.40
 *
 * Диапазоны в секундах, порядок любой, пересечения схлопываются.
 */
import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

const FF = process.env.FFMPEG || 'D:/tools/ffmpeg/bin/ffmpeg';
const FFPROBE = FF.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'));

const [inFile, outFile, ...ranges] = process.argv.slice(2);
if (!inFile || !outFile || !ranges.length) {
  console.error('usage: node scripts/omni-cut-repeats.mjs <in.mp4> <out.mp4> <от-до> [...]');
  process.exit(2);
}
const IN = resolve(inFile), OUT = resolve(outFile);
const dur = Number(execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${IN}"`).toString().trim());

// разбор и склейка пересекающихся диапазонов
const cuts = ranges.map(r => {
  const m = r.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/);
  if (!m) { console.error(`не разобрал диапазон «${r}»`); process.exit(2); }
  return [Number(m[1]), Number(m[2])];
}).sort((a, b) => a[0] - b[0]);
const merged = [];
for (const c of cuts) {
  const last = merged[merged.length - 1];
  if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
  else merged.push([...c]);
}

// оставшиеся куски = всё, что между вырезами
const keep = [];
let cur = 0;
for (const [a, b] of merged) {
  if (a > cur) keep.push([cur, a]);
  cur = b;
}
if (cur < dur) keep.push([cur, dur]);
if (!keep.length) { console.error('вырезать нечего — останется пусто'); process.exit(1); }

const cutSec = merged.reduce((s, [a, b]) => s + (b - a), 0);
console.log(`\n✂ ${inFile}: ${dur.toFixed(2)} с → вырезаем ${cutSec.toFixed(2)} с в ${merged.length} мест.`);
merged.forEach(([a, b]) => console.log(`   − ${a.toFixed(2)}–${b.toFixed(2)}`));

// каждый кусок режем отдельно с перекодировкой (склейка встык, без рассинхрона),
// потом собираем concat-фильтром за один проход
const inputs = keep.map(([a, b]) => `-ss ${a.toFixed(3)} -to ${b.toFixed(3)} -i "${IN}"`).join(' ');
const maps = keep.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
mkdirSync(dirname(OUT), { recursive: true });
execSync(`"${FF}" -y ${inputs} -filter_complex "${maps}concat=n=${keep.length}:v=1:a=1[v][a]" ` +
  `-map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 19 -c:a aac -b:a 192k -loglevel error "${OUT}"`,
  { stdio: 'inherit' });

const newDur = execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${OUT}"`).toString().trim();
console.log(`🏁 ${outFile} — ${Number(newDur).toFixed(2)} с (было ${dur.toFixed(2)})`);
console.log('   Проверить расшифровкой, что повтор ушёл, а слово рядом не срезано.');
