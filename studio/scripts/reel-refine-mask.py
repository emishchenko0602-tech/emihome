#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-refine-mask.py — подгоняет край маски по самой картинке.

Зачем: нейросеть рисует маску по смыслу, а не по пикселям, и край у неё
ступенчатый: волосы, пальцы и край одежды обрезаются по прямой. Направляющий
фильтр тянет границу маски к ближайшей границе света и тени на кадре, и
ступенька превращается в настоящий контур.

Пересчитывать модель не нужно: это отдельный быстрый проход поверх готовой
маски.

Фильтр реализован здесь, а не взят из opencv-contrib: contrib не встаёт в
этот питон, а весь алгоритм умещается в десяток строк на боксфильтрах.

Запуск:
  python scripts/reel-refine-mask.py <видео> --mask <маска.mp4> --out <точнее.mp4>
  python scripts/reel-refine-mask.py ... --radius 8 --eps 0.0005 --gamma 1.15
"""

import argparse
import os
import subprocess
import sys

import numpy as np

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


def probe(path):
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-show_entries", "format=duration", "-of", "default=nw=1:nk=0", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    d = {}
    for line in r.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            d[k] = v.strip()
    return d


def guided(I, p, r, eps, cv2):
    """Направляющий фильтр He et al.: p подтягивается к краям I."""
    k = (2 * r + 1, 2 * r + 1)
    box = lambda x: cv2.boxFilter(x, -1, k, normalize=True, borderType=cv2.BORDER_REFLECT)
    mI, mp = box(I), box(p)
    a = (box(I * p) - mI * mp) / (box(I * I) - mI * mI + eps)
    b = mp - a * mI
    return box(a) * I + box(b)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("--mask", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--radius", type=int, default=8)
    p.add_argument("--eps", type=float, default=5e-4)
    # После фильтра край становится мягче. Гамма больше единицы поджимает
    # полупрозрачную кайму, чтобы фон не просвечивал сквозь плечи.
    p.add_argument("--gamma", type=float, default=1.15)
    a = p.parse_args()

    for f in (a.src, a.mask):
        if not os.path.exists(f):
            sys.exit(f"ОШИБКА: нет файла {f}")

    import cv2

    vi, mi = probe(a.src), probe(a.mask)
    W, H = int(vi["width"]), int(vi["height"])
    if (int(mi["width"]), int(mi["height"])) != (W, H):
        sys.exit("ОШИБКА: маска и видео разного размера")
    num, den = (vi.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den or 1)
    total = int(round(float(vi.get("duration") or 0) * fps))
    print(f"{W}x{H}, {fps:.0f} к/с, ~{total} кадров")

    def reader(path, pix, bpp):
        return subprocess.Popen(
            [FFMPEG, "-v", "error", "-i", path, "-pix_fmt", pix, "-f", "rawvideo", "-"],
            stdout=subprocess.PIPE, bufsize=10 ** 8), W * H * bpp

    rv, vsize = reader(a.src, "gray", 1)
    rm, msize = reader(a.mask, "gray", 1)
    wr = subprocess.Popen(
        [FFMPEG, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", f"{W}x{H}", "-r", f"{fps:.6f}", "-i", "-", "-an",
         "-c:v", "libx264", "-preset", "veryfast", "-qp", "0",
         "-pix_fmt", "yuv420p", a.out],
        stdin=subprocess.PIPE)

    i = 0
    try:
        while True:
            bv = rv.stdout.read(vsize)
            bm = rm.stdout.read(msize)
            if len(bv) < vsize or len(bm) < msize:
                break
            I = np.frombuffer(bv, np.uint8).reshape(H, W).astype(np.float32) / 255.0
            P = np.frombuffer(bm, np.uint8).reshape(H, W).astype(np.float32) / 255.0
            q = guided(I, P, a.radius, a.eps, cv2)
            q = np.clip(q, 0, 1) ** a.gamma
            wr.stdin.write((q * 255).astype(np.uint8).tobytes())
            i += 1
            if i % 200 == 0:
                print(f"  {i}/{total or '?'}", flush=True)
    finally:
        for h in (rv.stdout, rm.stdout):
            h.close()
        wr.stdin.close()
        rv.wait(); rm.wait(); wr.wait()

    if not os.path.exists(a.out):
        sys.exit("ОШИБКА: уточнённая маска не собралась")
    print(f"готово: {a.out} ({i} кадров)")
    if total and abs(i - total) > max(3, total * 0.02):
        sys.exit(f"ОШИБКА: {i} кадров вместо {total}, маска разойдётся с картинкой")


if __name__ == "__main__":
    main()
