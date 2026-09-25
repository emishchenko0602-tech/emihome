#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-subs.py — субтитры короткими карточками по два-три слова.

Зачем: в рилсах студии на экране висит не строка, а два-три слова, и они
меняются в такт речи. Длинная строка читается дольше, чем звучит, и зритель
перестаёт слушать и начинает читать.

Карточка держится ровно столько, сколько звучат её слова, поэтому текст и
голос не расходятся даже после вырезанных пауз.

Правки расшифровки берутся из файла: распознавание стабильно путает одни и
те же слова, и держать их списком дешевле, чем каждый раз чинить .ass руками.

Запуск:
  python scripts/reel-subs.py <видео> --out <.ass>
  python scripts/reel-subs.py <видео> --out <.ass> --fix workspace/reels/fixes.json
  python scripts/reel-subs.py ... --words 3 --size 78 --top 300
"""

import argparse
import importlib.util
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HEAD = """[Script Info]
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Reel,{font},{size},&H00FFFFFF,&H00201B16,&H64000000,0,0,0,0,100,100,0,0,1,{outline},{shadow},8,70,70,{top},204

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def load_tighten():
    path = os.path.join(ROOT, "scripts", "reel-tighten.py")
    spec = importlib.util.spec_from_file_location("reel_tighten", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def ass_time(t):
    t = max(0.0, t)
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def apply_fixes(words, fixes):
    """Замены по одному слову и по паре подряд идущих.

    Пара нужна там, где распознавание слепило два слова в одно: «они» вместо
    «и ему» починить пословно нельзя, не сдвинув тайминги соседей.
    """
    one = {k.lower(): v for k, v in fixes.get("слово", {}).items()}
    pair = {k.lower(): v for k, v in fixes.get("пара", {}).items()}
    out, i, n = [], 0, 0
    while i < len(words):
        w = dict(words[i])
        if i + 1 < len(words):
            key = (w["w"].strip() + " " + words[i + 1]["w"].strip()).lower()
            if key in pair:
                out.append({"s": w["s"], "e": words[i + 1]["e"], "w": pair[key]})
                i += 2
                n += 1
                continue
        bare = w["w"].strip().lower().strip(".,!?:;")
        if bare in one:
            tail = w["w"].strip()[len(w["w"].strip().rstrip(".,!?:;")):]
            w["w"] = one[bare] + tail
            n += 1
        out.append(w)
        i += 1
    return out, n


# Карточка, оканчивающаяся предлогом или союзом, обрывает фразу на полуслове:
# глаз дочитывает «режут зал по» и ждёт продолжения вместо того, чтобы слушать.
HANGING = {
    "в", "и", "а", "на", "по", "с", "со", "к", "у", "из", "для", "не", "от",
    "до", "за", "об", "о", "что", "чтобы", "как", "или", "но", "то", "же",
    "бы", "ли", "при", "под", "над", "про", "без", "их", "его", "её", "это",
}


def chunks(words, per, max_gap):
    """Режем на карточки: по числу слов, но пауза и конец фразы рвут раньше."""
    out, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        bare = w["w"].strip().lower().strip(".,!?:;—-")
        closing = w["w"].strip().endswith((".", "!", "?", ":"))
        gap = (words[i + 1]["s"] - w["e"]) if i + 1 < len(words) else 99
        full = len(cur) >= per
        # Перед паузой и точкой висящий предлог всё равно приходится оставить:
        # переносить его через паузу хуже, чем дочитать на месте.
        if full and not closing and gap <= max_gap and bare in HANGING and len(cur) > 1:
            continue
        if full or closing or gap > max_gap:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("--out", required=True)
    p.add_argument("--fix", default=None, help="json с правками расшифровки")
    p.add_argument("--words", type=int, default=3, help="слов на карточке")
    p.add_argument("--max-gap", type=float, default=0.45,
                   help="пауза длиннее этой всегда рвёт карточку, сек")
    p.add_argument("--font", default="Manrope ExtraBold")
    p.add_argument("--size", type=int, default=78)
    p.add_argument("--top", type=int, default=300, help="отступ сверху, точек")
    # Без обводки белый текст пропадает на светлом кадре: окно, потолок,
    # скатерть. Тонкая тёмная обводка это чинит и не читается как рамка.
    p.add_argument("--outline", type=int, default=3)
    p.add_argument("--shadow", type=int, default=2)
    p.add_argument("--anim", action="store_true", help="карточки выскакивают с подскоком")
    p.add_argument("--no-dots", action="store_true",
                   help="убрать точки и запятые в конце карточек")
    a = p.parse_args()

    if not os.path.exists(a.src):
        sys.exit(f"ОШИБКА: нет файла {a.src}")

    rt = load_tighten()
    words = rt.words_of(a.src)
    if not words:
        sys.exit("ОШИБКА: в записи не распознано ни одного слова")
    print(f"слов: {len(words)}")

    if a.fix:
        if not os.path.exists(a.fix):
            sys.exit(f"ОШИБКА: нет файла правок {a.fix}")
        fixes = json.load(io.open(a.fix, encoding="utf-8"))
        words, n = apply_fixes(words, fixes)
        print(f"правок применено: {n}")

    cards = chunks(words, a.words, a.max_gap)
    lines = []
    for i, c in enumerate(cards):
        start = c[0]["s"]
        # Карточка висит до следующей, но не дольше полусекунды после своих слов:
        # иначе последнее слово фразы застывает на экране в тишине.
        nxt = cards[i + 1][0]["s"] if i + 1 < len(cards) else c[-1]["e"] + 0.4
        end = min(nxt, c[-1]["e"] + 0.5)
        text = " ".join(w["w"].strip() for w in c).replace("\n", " ")
        # Точка в конце карточки читается как конец мысли, хотя фраза
        # продолжается на следующей. Снимаем её после разбивки: до разбивки
        # она нужна, именно по ней карточка и рвётся.
        if a.no_dots:
            text = text.rstrip(".,:;")
        # Карточка выскакивает чуть увеличенной и садится на место за долю
        # секунды. Движение держит внимание там, где статичный текст его теряет.
        if a.anim:
            text = (r"{\fad(40,40)\fscx88\fscy88\t(0,120,\fscx100\fscy100)}") + text
        lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Reel,,0,0,0,,{text}")

    head = HEAD.format(font=a.font, size=a.size, top=a.top,
                       outline=a.outline, shadow=a.shadow)
    io.open(a.out, "w", encoding="utf-8").write(head + "\n".join(lines) + "\n")
    longest = max(len(l.split(",,0,0,0,,")[-1]) for l in lines)
    print(f"карточек: {len(cards)} | самая длинная: {longest} знаков")
    print(f"субтитры: {a.out}")


if __name__ == "__main__":
    main()
