#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-dubles.py — ищет переписанные дубли в живой записи.

Зачем: автор начинает фразу, сбивается, начинает заново, и так два-три раза
подряд. При монтаже это надо вырезать, но на слух такие места ищутся долго, а
на глаз не видны вовсе.

Главная ловушка, из-за которой скрипт и написан: расшифровка склеивает
повторы в одно длинное слово. Три захода на «Лучшее решение» whisper выдал
одним словом «решение» длиной 3,2 секунды. Поэтому кроме повторов скрипт
отдельно помечает подозрительно длинные слова: почти всегда за ними прячется
склейка, и туда надо посмотреть глазами.

На выходе список мест с таймкодами и готовая строка --keeps для reel-takes.py,
оставляющая последний дубль из каждой группы.

Запуск:
  python scripts/reel-dubles.py <видео>
  python scripts/reel-dubles.py <видео> --model medium --min-words 3 --window 40
"""

import argparse
import importlib.util
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_tighten():
    path = os.path.join(ROOT, "scripts", "reel-tighten.py")
    spec = importlib.util.spec_from_file_location("reel_tighten", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def norm(w):
    return re.sub(r"[^\w]", "", w.lower())


def find_repeats(words, min_words, window):
    """Группы повторов: одна и та же цепочка слов, начатая заново неподалёку.

    Сравниваются только начала цепочек: сбившийся дубль обрывается на середине,
    и хвост у него не совпадает, а начало совпадает всегда.
    """
    toks = [norm(w["w"]) for w in words]
    groups, used = [], set()
    for i in range(len(toks) - min_words):
        if i in used:
            continue
        key = tuple(toks[i:i + min_words])
        if not all(key):
            continue
        hits = [i]
        j = i + min_words
        while j < len(toks) - min_words:
            if words[j]["s"] - words[i]["s"] > window:
                break
            if tuple(toks[j:j + min_words]) == key:
                hits.append(j)
                j += min_words
            else:
                j += 1
        if len(hits) > 1:
            for h in hits:
                for k in range(h, h + min_words):
                    used.add(k)
            groups.append({"phrase": " ".join(words[i + k]["w"].strip()
                                              for k in range(min_words)),
                           "at": [words[h]["s"] for h in hits],
                           "idx": hits})
    return groups


def long_words(words, limit):
    return [w for w in words if (w["e"] - w["s"]) > limit]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("--min-words", type=int, default=3,
                   help="сколько слов подряд должно совпасть, чтобы счесть повтором")
    p.add_argument("--window", type=float, default=40.0,
                   help="искать повтор не дальше этого, сек")
    p.add_argument("--long-word", type=float, default=1.2,
                   help="слово длиннее этого помечается как подозрительное, сек")
    p.add_argument("--json", default=None, help="куда сложить разбор")
    a = p.parse_args()

    if not os.path.exists(a.src):
        sys.exit(f"ОШИБКА: нет файла {a.src}")

    rt = load_tighten()
    dur = rt.probe_duration(a.src)
    words = rt.words_of(a.src)
    if not words:
        sys.exit("ОШИБКА: речь не распознана")
    print(f"длительность {dur:.1f} сек, слов {len(words)}")

    groups = find_repeats(words, a.min_words, a.window)
    longs = long_words(words, a.long_word)

    out = []
    if groups:
        out.append("\nПОВТОРЫ: фраза начата заново")
        for g in groups:
            times = ", ".join(f"{t:.2f}" for t in g["at"])
            out.append(f"  {len(g['at'])}x «{g['phrase']}...» на {times}")
            out.append(f"     оставить последний, вырезать {g['at'][0]:.2f}–{g['at'][-1]:.2f}")
    else:
        out.append("\nПОВТОРОВ не нашёл")

    if longs:
        out.append("\nПОДОЗРИТЕЛЬНО ДЛИННЫЕ СЛОВА: скорее всего за ними склеенные дубли")
        for w in longs:
            out.append(f"  {w['e'] - w['s']:.2f} сек на «{w['w'].strip()}» "
                       f"в {w['s']:.2f}  ← послушать это место")
    else:
        out.append("\nДлинных слов нет")

    # Черновой --keeps: выкидываем всё от первого захода до последнего.
    cuts = sorted((g["at"][0], g["at"][-1]) for g in groups)
    merged = []
    for s, e in cuts:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    keeps, pos = [], max(0.0, words[0]["s"] - 0.2)
    for s, e in merged:
        if s - pos > 0.3:
            keeps.append((pos, s))
        pos = e
    keeps.append((pos, min(dur, words[-1]["e"] + 0.3)))
    line = ",".join(f"{s:.2f}-{e:.2f}" for s, e in keeps)
    out.append("\nЧЕРНОВИК ДЛЯ reel-takes.py, проверить ушами перед сборкой:")
    out.append(f"  --keeps {line}")
    out.append("\nВНИМАНИЕ: границы кусков обязаны попадать внутрь паузы, а не на")
    out.append("границу слова. Иначе перекрытие смажет соседние звуки в третий,")
    out.append("несуществующий: так на стыке получилось слышимое «ресторану ранее».")

    sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))

    if a.json:
        json.dump({"src": a.src, "duration": dur, "groups": groups,
                   "long_words": longs, "keeps_draft": line},
                  io.open(a.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"разбор: {a.json}")


if __name__ == "__main__":
    main()
