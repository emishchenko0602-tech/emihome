#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-cutout.py — обтравка говорящего по контуру: считает маску человека.

Зачем: в рилсах студии автор стоит прямо на видеоряде, без рамки и без окна
в углу. Для этого нужен не кроп, а маска: где человек, где фон.

На выходе чёрно-белое видео той же длины и частоты, что исходник. Белое —
человек. Дальше оно скармливается alphamerge при сборке.

Сегментация работает на уменьшенном кадре: модель внутри всё равно сжимает
вход до 320x320, поэтому подавать полный кадр бессмысленно, а времени уходит
втрое больше.

Запуск:
  python scripts/reel-cutout.py <видео> --out <маска.mp4>
  python scripts/reel-cutout.py <видео> --out маска.mp4 --smooth 0.7 --feather 5
"""

import argparse
import os
import subprocess
import sys

import numpy as np

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

# Разрешение, на котором считается маска по умолчанию. Для u2net выше смысла
# нет: он ужимает вход до 320x320. isnet и birefnet работают с 1024x1024 и
# на более крупном кадре дают заметно точнее край.
MW, MH = 540, 960


def probe(path):
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,nb_frames,r_frame_rate",
         "-show_entries", "format=duration", "-of", "default=nw=1:nk=0", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    d = {}
    for line in r.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            d[k] = v.strip()
    return d


def largest_blob(mask, cv2):
    """Оставляет самую большую связную область.

    Модель иногда цепляет отражение в зеркале или тёмный угол мебели.
    В кадре человек один, и всё, что не примыкает к нему, — мусор.
    """
    n, lab, stats, _ = cv2.connectedComponentsWithStats((mask > 96).astype(np.uint8), 8)
    if n <= 1:
        return mask
    # stats[0] — фон, его пропускаем
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return np.where(lab == big, mask, 0).astype(np.uint8)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("--out", required=True)
    p.add_argument("--model", default="u2net_human_seg")
    p.add_argument("--smooth", type=float, default=0.65,
                   help="сглаживание маски по времени, 0 — выкл, ближе к 1 — сильнее")
    p.add_argument("--feather", type=int, default=5,
                   help="размытие края маски в пикселях, нечётное")
    p.add_argument("--no-blob", action="store_true",
                   help="не отбрасывать мелкие области")
    p.add_argument("--mask-width", type=int, default=MW,
                   help="ширина кадра для расчёта маски, высота считается по 9:16")
    a = p.parse_args()

    if not os.path.exists(a.src):
        sys.exit(f"ОШИБКА: нет файла {a.src}")

    import cv2
    from PIL import Image
    from rembg import new_session

    info = probe(a.src)
    W, H = int(info["width"]), int(info["height"])
    dur = float(info.get("duration") or 0)
    num, den = (info.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den or 1)
    total = int(round(dur * fps)) if dur else 0
    print(f"исходник: {W}x{H}, {fps:.0f} к/с, ~{total} кадров")

    feather = a.feather if a.feather % 2 else a.feather + 1
    mw = a.mask_width // 2 * 2
    mh = int(mw * 16 / 9) // 2 * 2
    if (mw, mh) != (MW, MH):
        print(f"маска считается на {mw}x{mh}")

    print(f"модель: {a.model}")
    session = new_session(a.model)

    rd = subprocess.Popen(
        [FFMPEG, "-v", "error", "-i", a.src, "-vf", f"scale={mw}:{mh}",
         "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, bufsize=10 ** 8)

    wr = subprocess.Popen(
        [FFMPEG, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", f"{mw}x{mh}", "-r", f"{fps:.6f}", "-i", "-",
         "-vf", f"scale={W}:{H},setsar=1", "-an",
         # Маска обязана быть точной: на lossy-сжатии края появляется кайма.
         "-c:v", "libx264", "-preset", "veryfast", "-qp", "0",
         "-pix_fmt", "yuv420p", a.out],
        stdin=subprocess.PIPE)

    fsize = mw * mh * 3
    prev = None
    i = 0
    try:
        while True:
            buf = rd.stdout.read(fsize)
            if len(buf) < fsize:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(mh, mw, 3)
            m = session.predict(Image.fromarray(frame))[0]
            m = np.asarray(m.convert("L"), dtype=np.uint8)

            if not a.no_blob:
                m = largest_blob(m, cv2)

            # Сглаживание по времени: без него край дрожит покадрово и
            # человек на фоне выглядит мерцающим.
            if prev is not None and a.smooth > 0:
                m = (a.smooth * prev.astype(np.float32)
                     + (1 - a.smooth) * m.astype(np.float32)).astype(np.uint8)
            prev = m

            if feather > 1:
                m = cv2.GaussianBlur(m, (feather, feather), 0)

            wr.stdin.write(m.tobytes())
            i += 1
            if i % 150 == 0:
                print(f"  {i}/{total or '?'} кадров", flush=True)
    finally:
        rd.stdout.close()
        wr.stdin.close()
        rd.wait()
        wr.wait()

    if not os.path.exists(a.out):
        sys.exit("ОШИБКА: маска не собралась")

    got = probe(a.out)
    print(f"маска: {a.out} ({i} кадров, {got.get('width')}x{got.get('height')})")

    if total and abs(i - total) > max(3, total * 0.02):
        sys.exit(f"ОШИБКА: в маске {i} кадров вместо {total}. "
                 f"Склейка с картинкой разойдётся, пересоберите.")


if __name__ == "__main__":
    main()
