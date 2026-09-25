/**
 * omni-prompt.mjs — собирает промпт для Omni Flash из того же sb-spec.json,
 * по которому рисовались сториборды. Раньше посекундный промпт писался руками
 * отдельно от борда, и они расходились: борд про одно, промпт про другое.
 *
 * Структура промпта — канон Павла:
 *   1) вводная (дословно)
 *   2) по строке на каждую панель, с глаголами движения
 *   3) анти-протечка сториборда + финал (дословно)
 *
 * Тайминги идут СЛОВАМИ (поле timing), числовых таймкодов в тексте нет —
 * Omni рендерит цифры как текст прямо в кадр.
 *
 * Запуск:
 *   node scripts/omni-prompt.mjs workspace/reels/<slug>/sb-spec.json
 *   → пишет <outDir>/pN-omni.txt на каждую часть
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const specPath = process.argv[2];
if (!specPath) {
  console.error('Использование: node scripts/omni-prompt.mjs <sb-spec.json>');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const outDir = resolve(spec.outDir);
mkdirSync(outDir, { recursive: true });

// ⚠️ Длина решает: джоба на 2367 символов упала на 79% («Başarısız»). Рабочий потолок —
// около 1400 символов, поэтому по умолчанию собирается КОМПАКТНЫЙ промпт: вводная и финал
// урезаны, на панель одна фраза. Полная версия — флагом --long, для отладки.
const LONG = process.argv.includes('--long');

const INTRO = LONG
  ? `Edit this video following the attached storyboard reference exactly. Smooth elegant transitions throughout, no hard cuts, everything morphs fluidly. Something is ALWAYS moving inside every segment - nothing ever 'freezes' or holds static, and the very first second is already full of motion.`
  : `Edit this video following the attached storyboard exactly. Smooth fluid transitions, no hard cuts. Something is always moving; the first second is already in motion.`;

// Дело не в размере подписи, а в их КОЛИЧЕСТВЕ рядом. Одна подпись — Omni рисует честно,
// и так были сделаны все ролики, где ничего не плыло. Несколько мелких кусков текста разом
// он коверкает: «INPUT TOKENS» дважды, «96+» вместо 90+, «FIREWORKS» дважды, лог кашей.
// Поэтому запрещаем не мелкий текст, а СКОПЛЕНИЯ мелкого текста.
const NO_SMALL_TEXT = `Keep text sparse: ONE caption at a time, standing alone. A single small label is fine; many small pieces of text together are not. No lists of rows, no logs, no tables, no columns of numbers, no code, no file trees, no ticker rows, no chat threads. If a set of items must be shown, show one of them large or use plain shapes with one caption.`;

const OUTRO = LONG
  ? `Output ONE full-screen composition always: never show storyboard panels, numbers, grids or labels.
Only ONE headline on screen at a time: it fully disappears before the next appears, never overlapping.
${NO_SMALL_TEXT}
Do NOT re-voice, re-time or shorten the speech.

All transitions smooth and fluid. Camera drifts slow and gentle on first and last moment. All text animates in with overshot - never static. Premium cinematic motion. Keep my original audio exactly as it is.`
  : `Output ONE full-screen composition: never show storyboard panels, numbers or labels. ${NO_SMALL_TEXT} Only one headline on screen at a time. Keep my original audio exactly as it is.`;

// Из описания панели в компактном режиме берём только первое предложение —
// остальное уже нарисовано на борде, дублировать словами не нужно.
const short = (s) => {
  const first = s.split(/(?<=\.)\s/)[0] || s;
  return first.length > 190 ? first.slice(0, 187).trimEnd() + '.' : first;
};

// Каждому типу шота — своя формулировка движения, чтобы Omni не держал статику.
const MOTION = {
  'FULLSCREEN SPEAKER PUSH IN': 'the speaker fills the frame and the camera pushes in slowly',
  'FULLSCREEN SPEAKER PUSH IN WARM': 'the speaker fills the frame, camera drifting gently on a warm calm grade',
  'FULLSCREEN SPEAKER': 'the speaker returns full frame, talking straight to camera',
  'FULLSCREEN CONTENT NO SPEAKER': 'the speaker dissolves away and the graphic builds itself up',
  'CONTENT WITH CIRCLE': 'the speaker shrinks smoothly into a small rounded circle that flies to the corner while the graphic sweeps in',
  'TOP-SPLIT': 'the speaker shrinks upward into the top half and the bottom half reveals the card, its rows appearing one after another',
  'SPLIT-SCREEN L/R': 'the frame splits vertically, the speaker holding one side while the other side slides in',
  'TERMINAL INSERT': 'a terminal window wipes across the frame and its lines print themselves one by one',
  'DATA-COUNTER': 'the numbers roll up digit by digit while faint ticker rows scroll behind',
  'PHONE MOCKUP': 'a phone rises into frame and its content pops in with overshoot',
  'MATCH-CUT': 'the motion of the speaker carries straight into the graphic without a cut',
  'QUOTE-CARD': 'the card drifts in and its text settles with overshoot',
  'ZOOM-OUT REVEAL': 'the camera pulls back and the whole picture reveals itself',
};

let total = 0;
for (const part of spec.parts) {
  const lines = part.panels.map((p) => {
    const motion = MOTION[p.shot] || 'the shot changes fluidly';
    return LONG
      ? `At ${p.timing} - ${motion}. ${p.desc}`
      : `Then ${motion}. ${short(p.desc)}`;
  });
  const text = `${INTRO}\n\n${lines.join('\n')}\n\n${OUTRO}\n`;
  const f = join(outDir, `p${part.n}-omni.txt`);
  writeFileSync(f, text, 'utf8');
  const flag = text.length > 1500 ? ' ⚠️ длиннее рабочего потолка' : '';
  console.log(`  ✅ ${f} (${part.panels.length} панелей, ${text.length} симв.)${flag}`);
  total++;
}
console.log(`\n🏁 ${spec.slug}: промптов ${total}`);
