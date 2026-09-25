#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-compose.py — собирает рилс: видеоряд фоном, автор поверх него по контуру.

Отличие от reel-broll.py: там автор сидит во врезке в углу, здесь он вырезан
по контуру и стоит прямо на кадре. Маску считает reel-cutout.py.

Порядок: фон нарезается кусками из папки с исходниками, автор накладывается
через alphamerge, сверху вшиваются субтитры.

Фон приглушается: поверх светлого кадра белые субтитры и светлая рубашка
сливаются, и автор перестаёт читаться как отдельный слой.

Запуск:
  python scripts/reel-compose.py <говорящее.mp4> --mask <маска.mp4> \
      --broll <папка> --subs <.ass> --out <итог.mp4>
  python scripts/reel-compose.py ... --seg 2.5 --dim 0.18 --fontsdir workspace/reels/fonts
"""

import argparse
import importlib.util
import os
import random
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
W, H = 1080, 1920


def load_broll():
    path = os.path.join(ROOT, "scripts", "reel-broll.py")
    spec = importlib.util.spec_from_file_location("reel_broll", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(args):
    return subprocess.run(args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def duration(path):
    r = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nk=1:nw=1", path])
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def build_bg(broll, need, seg, tmpdir, rb, seed):
    """Фон нужной длины: куски по seg секунд, источники не повторяются подряд."""
    files = rb.collect(broll)
    if not files:
        sys.exit("ОШИБКА: в указанных папках нет ни одного файла для фона")
    rnd = random.Random(seed)
    order = files[:]
    rnd.shuffle(order)

    n = int(need / seg) + 2
    segs, i = [], 0
    while len(segs) < n:
        src = order[i % len(order)]
        if i and i % len(order) == 0:
            rnd.shuffle(order)
        bias = (0.35, 0.5, 0.65)[len(segs) % 3]
        out = rb.make_segment(src, len(segs), seg, tmpdir, bias, zoom=True)
        if out:
            segs.append(out)
        i += 1
        if i > len(order) * 3:
            break
    if not segs:
        sys.exit("ОШИБКА: ни один кусок фона не собрался")
    print(f"  кусков фона: {len(segs)} по {seg} сек")

    lst = os.path.join(tmpdir, "bg.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for s in segs:
            f.write("file '%s'\n" % s.replace("\\", "/"))

    bg = os.path.join(tmpdir, "bg.mp4")
    # Пересжатие, а не -c copy: куски приходят с разными таймбазами, и при
    # копировании склейка молча теряет часть кадров.
    r = run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", lst, "-t", f"{need:.3f}", "-an",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
             "-pix_fmt", "yuv420p", "-r", "30", bg])
    if r.returncode != 0:
        sys.exit("ОШИБКА ffmpeg на фоне:\n" + (r.stderr or "")[:2000])

    got = duration(bg)
    if abs(got - need) > max(1.0, need * 0.05):
        sys.exit(f"ОШИБКА: фон собрался длиной {got:.1f} сек вместо {need:.1f}")
    return bg


def main():
    p = argparse.ArgumentParser()
    p.add_argument("talking")
    p.add_argument("--mask", required=True)
    p.add_argument("--broll", nargs="+", required=True)
    p.add_argument("--subs", default=None)
    p.add_argument("--fontsdir", default=None, help="папка с .ttf для субтитров")
    p.add_argument("--out", required=True)
    p.add_argument("--seg", type=float, default=2.5, help="длина куска фона, сек")
    p.add_argument("--dim", type=float, default=0.18, help="насколько приглушить фон, 0..1")
    p.add_argument("--seed", type=int, default=7)
    # 1.0 — автор во весь кадр. В рилсах студии он стоит внизу и занимает
    # чуть меньше половины высоты, чтобы видеоряд читался над ним.
    p.add_argument("--scale", type=float, default=0.45,
                   help="высота автора, доля кадра")
    p.add_argument("--bottom", type=int, default=0,
                   help="отступ автора от нижнего края, точек")
    # Когда в исходнике человек срезан краем кадра, обтравка даёт прямой
    # вертикальный обрез. У края кадра он читается как кадрирование, в центре —
    # как отрезанный бок. Поэтому слой прижимается к той стороне, где обрез.
    p.add_argument("--align", choices=("center", "left", "right"), default="center",
                   help="к какому краю прижать автора")
    p.add_argument("--dx", type=int, default=0, help="сдвиг автора по горизонтали, точек")
    p.add_argument("--red", type=float, default=0.0,
                   help="убрать красноту с автора, 0..0.3")
    p.add_argument("--cool", type=float, default=0.0,
                   help="убрать рыжину с фона, 0..0.2")
    p.add_argument("--clean-audio", action="store_true",
                   help="убрать гул комнаты и выровнять громкость по фразам")
    a = p.parse_args()

    for f in (a.talking, a.mask):
        if not os.path.exists(f):
            sys.exit(f"ОШИБКА: нет файла {f}")
    if a.subs and not os.path.exists(a.subs):
        sys.exit(f"ОШИБКА: нет субтитров {a.subs}")

    need = duration(a.talking)
    mdur = duration(a.mask)
    print(f"говорящее: {need:.1f} сек | маска: {mdur:.1f} сек")
    # Разошедшаяся маска сдвигает обтравку на полкадра и дальше по всему ролику:
    # ловим здесь, а не глазами в готовом файле.
    if abs(mdur - need) > 0.2:
        sys.exit("ОШИБКА: маска и видео разной длины. Пересчитайте маску.")

    rb = load_broll()
    tmp = tempfile.mkdtemp(prefix="compose-")
    try:
        bg = build_bg(a.broll, need, a.seg, tmp, rb, a.seed)

        bgf = f"eq=brightness=-{a.dim:.3f}:saturation=0.92"
        if a.cool > 0:
            # Половина ресторанных съёмок снята в тёплом свете, и фон уходит
            # в рыжину. Правим баланс, а не насыщенность: насыщенность убила
            # бы и зелень растений, ради которой кадр и брали.
            bgf += f",colorbalance=rm=-{a.cool:.3f}:rh=-{a.cool * 0.5:.3f}:bm={a.cool * 0.5:.3f}"
        chain = [f"[0:v]{bgf},setsar=1[bg]"]

        # Цвет правим до alphamerge: после склейки с маской фильтр цвета
        # тронул бы и прозрачность, и по краю пошла бы кайма.
        if a.red > 0:
            chain.append(f"[1:v]colorbalance=rm=-{a.red:.3f}:rh=-{a.red * 0.6:.3f}"
                         f":bm={a.red * 0.3:.3f},eq=saturation=0.94[tone]")
            src_v = "[tone]"
        else:
            src_v = "[1:v]"
        chain.append(f"{src_v}[2:v]alphamerge[fg]")

        if abs(a.scale - 1.0) < 0.001 and a.align == "center" and not a.dx:
            chain.append("[bg][fg]overlay=0:0:format=auto[v]")
        else:
            # Слой автора масштабируется целиком: в исходном кадре он уже
            # прижат к нижнему краю, поэтому уменьшенный слой встаёт на пол
            # сам, без подгонки по росту.
            fw = int(W * a.scale) // 2 * 2
            fh = int(H * a.scale) // 2 * 2
            x = {"center": (W - fw) // 2, "left": 0, "right": W - fw}[a.align] + a.dx
            y = H - fh - a.bottom
            chain.append(f"[fg]scale={fw}:{fh}:flags=lanczos[fgs]")
            chain.append(f"[bg][fgs]overlay={x}:{y}:format=auto[v]")
            print(f"  автор: {fw}x{fh} в точке {x},{y}")
        last = "[v]"
        if a.subs:
            esc = a.subs.replace("\\", "/").replace(":", "\\:")
            opt = f"subtitles='{esc}'"
            if a.fontsdir:
                fd = a.fontsdir.replace("\\", "/").replace(":", "\\:")
                opt += f":fontsdir='{fd}'"
            chain.append(f"{last}{opt}[vout]")
            last = "[vout]"
        else:
            chain.append(f"{last}copy[vout]")
            last = "[vout]"

        # Порядок важен: сначала срезаем низ, потом давим шум, потом жмём,
        # и только в конце выравниваем громкость. Наоборот компрессор поднял
        # бы вместе с голосом уже нормализованный гул.
        af = ["-af", "highpass=f=90,afftdn=nf=-26:nt=w,"
                     "acompressor=threshold=-20dB:ratio=3:attack=8:release=180,"
                     "loudnorm=I=-14:TP=-1.5:LRA=9"] if a.clean_audio else []
        print("собираю...")
        r = run([FFMPEG, "-y", "-loglevel", "error",
                 "-i", bg, "-i", a.talking, "-i", a.mask,
                 "-filter_complex", ";".join(chain),
                 "-map", last, "-map", "1:a",
                 "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                 "-pix_fmt", "yuv420p", "-r", "30",
                 "-c:a", "aac", "-b:a", "192k"] + af + ["-shortest", a.out])
        if r.returncode != 0:
            sys.exit("ОШИБКА ffmpeg на сборке:\n" + (r.stderr or "")[:2000])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    got = duration(a.out)
    print(f"готово: {a.out} ({got:.1f} сек)")
    if abs(got - need) > 0.5:
        sys.exit(f"ОШИБКА: итог {got:.1f} сек вместо {need:.1f}")


if __name__ == "__main__":
    main()
