#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
broll-rank.py — сортирует перебивки по тому, много ли в кадре человека.

Зачем: в рилсе автор вырезан по контуру и стоит поверх фона. Если на фоне
крупным планом стоит он же, в кадре оказываются два одинаковых человека, и
зритель спотыкается. Интерьеры, детали и дальние планы для фона безопаснее.

Считает долю кадра, занятую людьми, по нескольким кадрам каждого ролика.
Не отличает автора от официанта: человек вдали занимает мало места и
остаётся в списке, человек на весь кадр уходит вниз.

Запуск:
  python scripts/broll-rank.py <папка> --out workspace/reels/broll-rank.json
  python scripts/broll-rank.py <папка> --probes 3 --top 30
"""

import argparse
import glob
import json
import os
import subprocess
import sys

import numpy as np

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
VID_EXT = {".mp4", ".mov", ".m4v"}
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def run(args):
    return subprocess.run(args, capture_output=True)


def duration(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nk=1:nw=1", path],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def grab(path, t, w=320, h=568):
    """Один кадр в сыром виде: писать во временный файл ради пикселей незачем."""
    r = run([FFMPEG, "-v", "error", "-ss", f"{t:.2f}", "-i", path,
             "-frames:v", "1", "-vf", f"scale={w}:{h}", "-pix_fmt", "rgb24",
             "-f", "rawvideo", "-"])
    if len(r.stdout) < w * h * 3:
        return None
    return np.frombuffer(r.stdout[:w * h * 3], np.uint8).reshape(h, w, 3)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src", nargs="+")
    p.add_argument("--out", default="workspace/reels/broll-rank.json")
    p.add_argument("--probes", type=int, default=3, help="кадров на ролик")
    p.add_argument("--top", type=int, default=0, help="напечатать первые N путей")
    a = p.parse_args()

    files = []
    for s in a.src:
        if os.path.isdir(s):
            files += sorted(glob.glob(os.path.join(s, "*")))
        else:
            files += sorted(glob.glob(s))
    files = [f for f in files if os.path.splitext(f)[1].lower() in VID_EXT | IMG_EXT]
    if not files:
        sys.exit("ОШИБКА: не нашёл ни одного файла")

    from PIL import Image
    from rembg import new_session
    session = new_session("u2net_human_seg")

    rows = []
    for n, f in enumerate(files, 1):
        d = duration(f)
        ts = [d * k / (a.probes + 1) for k in range(1, a.probes + 1)] if d else [0.0]
        cover = []
        for t in ts:
            fr = grab(f, t)
            if fr is None:
                continue
            m = np.asarray(session.predict(Image.fromarray(fr))[0].convert("L"))
            cover.append(float((m > 128).mean()))
        if not cover:
            print(f"  ! {os.path.basename(f)}: кадр не читается, пропускаю")
            continue
        rows.append({"file": f.replace("\\", "/"),
                     "human": round(max(cover), 4),
                     "human_avg": round(sum(cover) / len(cover), 4)})
        print(f"  {n}/{len(files)} {os.path.basename(f):<18} человек в кадре: "
              f"{rows[-1]['human'] * 100:.0f}%", flush=True)

    rows.sort(key=lambda r: r["human"])
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    json.dump(rows, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    clean = [r for r in rows if r["human"] < 0.12]
    print(f"\nвсего {len(rows)}, из них без крупного человека {len(clean)}")
    print(f"список: {a.out}")
    if a.top:
        for r in rows[:a.top]:
            print(r["file"])


if __name__ == "__main__":
    main()
