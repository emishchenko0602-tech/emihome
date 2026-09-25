#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-broll.py — двухслойный рилс: видеоряд фоном, говорящий врезкой в углу.

Собирает то, что в референсах называют «говорящая голова поверх би-ролла»:
снизу слева живая запись автора, за ней меняется фон из фотографий и коротких
клипов, сверху крупные субтитры.

Фон нарезается кусками по 2 секунды — так же часто, как в референсе. Фото
оживляются медленным наездом, иначе статика в кадре выдаёт слайдшоу.

Запуск:
  python scripts/reel-broll.py <говорящее.mp4> --broll <папка|файлы> --subs <.ass> --out <итог.mp4>
  python scripts/reel-broll.py ... --seg 2.0 --inset 0.48
"""

import argparse
import glob
import os
import subprocess
import sys

from PIL import Image, ImageDraw

W, H = 1080, 1920
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}
VID_EXT = {".mp4", ".mov", ".m4v"}


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


def collect(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            for f in sorted(glob.glob(os.path.join(p, "*"))):
                if os.path.splitext(f)[1].lower() in IMG_EXT | VID_EXT:
                    out.append(f)
        else:
            out.extend(sorted(glob.glob(p)))
    return [f for f in out if os.path.splitext(f)[1].lower() in IMG_EXT | VID_EXT]


def rounded_mask(path, w, h, radius=46):
    """Маска со скруглёнными углами: врезка с прямыми углами выглядит как
    вставленное окно, а не как часть кадра."""
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    Image.merge("RGB", (m, m, m)).save(path)


def make_segment(src, idx, seg, tmpdir, crop_bias, zoom=False):
    """Один кусок фона: кадр обрезается под вертикаль и медленно наезжает.

    crop_bias двигает окно кадрирования по вертикали (0 — верх, 1 — низ).
    Им же уводим из кадра вшитые чужие подписи и повторно используем одно
    и то же фото, показывая разные его части.
    """
    out = os.path.join(tmpdir, f"seg{idx:03d}.mp4")
    ext = os.path.splitext(src)[1].lower()
    frames = int(seg * 30)

    if ext in IMG_EXT:
        vf = (f"scale={W*2}:{H*2}:force_original_aspect_ratio=increase,"
              f"crop={W*2}:{H*2}:(iw-ow)/2:(ih-oh)*{crop_bias:.2f},"
              f"zoompan=z='min(zoom+0.0012,1.18)':d={frames}"
              f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps=30,"
              f"setsar=1")
        # -frames:v обязателен. zoompan выдаёт d кадров НА КАЖДЫЙ входной кадр,
        # а зацикленная картинка подаёт их сотнями: без ограничения один слайд
        # разрастался до полутора минут, и фон уезжал на 800 секунд.
        cmd = [FFMPEG, "-y", "-loglevel", "error", "-loop", "1",
               "-i", src, "-vf", vf, "-an", "-frames:v", str(frames), "-r", "30",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
               "-pix_fmt", "yuv420p", out]
    else:
        d = duration(src)
        start = max(0.0, min(d - seg, (idx * seg * 1.7) % max(0.1, d - seg)))
        vf = (f"scale={W}:{H}:force_original_aspect_ratio=increase,"
              f"crop={W}:{H}:(iw-ow)/2:(ih-oh)*{crop_bias:.2f},setsar=1,fps=30")
        if zoom:
            # Снятое с рук видео почти статично, и на фоне это читается как
            # стоп-кадр. Медленный наезд возвращает движение. d=1: на видео
            # zoompan обязан отдавать ровно один кадр на кадр, иначе кусок
            # разрастается в минуты, как это уже было с фотографиями.
            vf += (f",scale={W*2}:{H*2},"
                   f"zoompan=z='min(1+0.0009*on,1.14)':d=1"
                   f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps=30,setsar=1")
        cmd = [FFMPEG, "-y", "-loglevel", "error", "-ss", f"{start:.2f}",
               "-t", f"{seg}", "-i", src, "-vf", vf, "-an",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
               "-pix_fmt", "yuv420p", out]

    r = run(cmd)
    if r.returncode != 0 or not os.path.exists(out):
        print(f"  ! пропускаю {os.path.basename(src)}: {(r.stderr or '')[:160]}")
        return None
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("talking")
    p.add_argument("--broll", nargs="+", required=True)
    p.add_argument("--subs", default=None)
    p.add_argument("--out", required=True)
    p.add_argument("--seg", type=float, default=2.0, help="длина куска фона, сек")
    p.add_argument("--inset", type=float, default=0.48, help="ширина врезки, доля кадра")
    a = p.parse_args()

    if not os.path.exists(a.talking):
        sys.exit(f"ОШИБКА: нет файла {a.talking}")

    media = collect(a.broll)
    if not media:
        sys.exit("ОШИБКА: не нашёл ни одного файла для фона")

    total = duration(a.talking)
    need = int(total / a.seg) + 1
    print(f"говорящее видео: {total:.1f} сек")
    print(f"материала для фона: {len(media)} файлов, нужно кусков: {need}")

    tmpdir = os.path.join(os.path.dirname(os.path.abspath(a.out)), "_broll")
    os.makedirs(tmpdir, exist_ok=True)

    # Одно и то же фото возвращается на экран, но каждый раз другой своей
    # частью: сверху, по центру, снизу. Иначе повтор бросается в глаза.
    biases = [0.5, 0.25, 0.75, 0.4, 0.6]
    segs = []
    for i in range(need):
        src = media[i % len(media)]
        bias = biases[(i // len(media)) % len(biases)]
        s = make_segment(src, i, a.seg, tmpdir, bias)
        if s:
            segs.append(s)
    if not segs:
        sys.exit("ОШИБКА: ни один кусок фона не собрался")
    print(f"кусков собрано: {len(segs)}")

    lst = os.path.join(tmpdir, "list.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for s in segs:
            f.write(f"file '{os.path.abspath(s)}'\n")
    bg = os.path.join(tmpdir, "bg.mp4")
    # Склейка с пересжатием: куски однородны по размеру и кадровой частоте,
    # поэтому ничего доводить не нужно. Попытка переписать метки времени
    # вручную (genpts плюс setpts) как раз и съедала две трети материала.
    r = run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", lst, "-an",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
             "-pix_fmt", "yuv420p", bg])
    if r.returncode != 0:
        sys.exit("ОШИБКА склейки фона:\n" + (r.stderr or "")[:1500])

    got = duration(bg)
    print(f"фон: {got:.1f} сек")
    expect = len(segs) * a.seg
    if abs(got - expect) > expect * 0.2:
        sys.exit(f"ОШИБКА: фон собрался длиной {got:.1f} сек вместо ожидаемых "
                 f"{expect:.1f}. Склейка сломалась, дальше идти нельзя.")

    iw = int(W * a.inset) // 2 * 2
    ih = int(iw * 848 / 464) // 2 * 2       # пропорции исходной записи
    ih = min(ih, int(H * 0.56)) // 2 * 2
    mask = os.path.join(tmpdir, "mask.png")
    rounded_mask(mask, iw, ih)

    x, y = int(W * 0.03), H - ih - int(H * 0.015)

    fc = (
        f"[0:v]trim=duration={total:.3f},setpts=PTS-STARTPTS,scale={W}:{H},setsar=1[bgv];"
        f"[1:v]scale={iw}:{ih},setsar=1,format=rgba[fg];"
        f"[2:v]scale={iw}:{ih},format=gray[mk];"
        f"[fg][mk]alphamerge[fga];"
        f"[bgv][fga]overlay={x}:{y}:shortest=1[comp]"
    )
    if a.subs:
        esc = a.subs.replace("\\", "/").replace(":", "\\:")
        fc += f";[comp]subtitles='{esc}'[vout]"
    else:
        fc += ";[comp]copy[vout]"

    print("собираю итог...")
    r = run([FFMPEG, "-y", "-loglevel", "error",
             "-i", bg, "-i", a.talking, "-i", mask,
             "-filter_complex", fc,
             "-map", "[vout]", "-map", "1:a",
             "-c:v", "libx264", "-preset", "medium", "-crf", "20",
             "-pix_fmt", "yuv420p", "-r", "30",
             "-c:a", "aac", "-b:a", "192k", "-shortest", a.out])
    if r.returncode != 0:
        sys.exit("ОШИБКА сборки:\n" + (r.stderr or "")[:2000])

    print(f"готово: {a.out} ({duration(a.out):.1f} сек)")


if __name__ == "__main__":
    main()
