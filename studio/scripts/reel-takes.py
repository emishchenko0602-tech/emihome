#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-takes.py — собирает говорящее видео из выбранных дублей.

Зачем: reel-tighten.py убирает тишину, но не умеет выбрасывать неудачные
дубли. В живой записи автор переписывает фразу по два-три раза подряд, и в
расшифровке это выглядит как повтор, а не как брак. Решает человек, какой
дубль оставить; этот скрипт исполняет решение.

Стыки дублей закрываются коротким перекрытием: при прямой склейке взгляд и
поза прыгают, и склейка читается. Четверти секунды хватает, чтобы глаз её
не заметил, и мало, чтобы речь не поплыла.

Внутри каждого куска паузы подтягиваются обычным способом, по энергии звука.

Запуск:
  python scripts/reel-takes.py <видео> --keeps 6.4-41.8,52.6-73.2 --out <готовое.mp4>
  python scripts/reel-takes.py ... --xfade 0.25 --max-pause 0.6 --no-trim
"""

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
W, H = 1080, 1920


def load_tighten():
    """Паузорезка живёт в reel-tighten.py; дублировать её здесь незачем."""
    path = os.path.join(ROOT, "scripts", "reel-tighten.py")
    spec = importlib.util.spec_from_file_location("reel_tighten", path)
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


def parse_keeps(s):
    out = []
    for chunk in s.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        a, b = chunk.split("-")
        a, b = float(a), float(b)
        if b <= a:
            sys.exit(f"ОШИБКА: кусок {chunk} кончается раньше, чем начинается")
        out.append((a, b))
    if not out:
        sys.exit("ОШИБКА: не задан ни один кусок")
    return out


def cut_part(src, start, end, dst, trim, tighten, max_pause, keep):
    """Один дубль: вырезаем, по желанию подтягиваем паузы внутри, вертикалим."""
    inner = [(0.0, end - start)]
    if trim:
        raw = os.path.join(os.path.dirname(dst), "raw-" + os.path.basename(dst))
        r = run([FFMPEG, "-y", "-loglevel", "error", "-ss", f"{start:.3f}",
                 "-to", f"{end:.3f}", "-i", src, "-c", "copy", "-avoid_negative_ts",
                 "make_zero", raw])
        if r.returncode != 0:
            r = run([FFMPEG, "-y", "-loglevel", "error", "-ss", f"{start:.3f}",
                     "-to", f"{end:.3f}", "-i", src, "-c:v", "libx264", "-crf", "18",
                     "-c:a", "aac", raw])
        if r.returncode == 0 and os.path.exists(raw):
            d = duration(raw)
            inner, gaps = tighten.plan_keeps(raw, d, max_pause, keep)
            src, start = raw, 0.0
            if gaps:
                print(f"    внутри подтянуто пауз: {len(gaps)} "
                      f"(минус {sum(g[2] - keep for g in gaps):.1f} сек)")
        else:
            print("    ! паузы внутри не тронуты, режу как есть")

    parts, labels = [], []
    for i, (s, e) in enumerate(inner):
        s, e = start + s, start + e
        parts.append(
            f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}];"
            f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]")
        labels.append(f"[v{i}][a{i}]")
    fc = (";".join(parts) + ";" + "".join(labels)
          + f"concat=n={len(inner)}:v=1:a=1[vc][ac];"
          f"[vc]scale={W}:{H}:force_original_aspect_ratio=increase,"
          f"crop={W}:{H},setsar=1,fps=30[vout]")

    r = run([FFMPEG, "-y", "-loglevel", "error", "-i", src,
             "-filter_complex", fc, "-map", "[vout]", "-map", "[ac]",
             "-c:v", "libx264", "-preset", "medium", "-crf", "18",
             "-pix_fmt", "yuv420p", "-r", "30",
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", dst])
    if r.returncode != 0:
        sys.exit("ОШИБКА ffmpeg на куске:\n" + (r.stderr or "")[:2000])
    return duration(dst)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("--keeps", required=True,
                   help="куски в секундах исходника: 6.4-41.8,52.6-73.2")
    p.add_argument("--out", required=True)
    p.add_argument("--xfade", type=float, default=0.25, help="перекрытие на стыке, сек")
    p.add_argument("--max-pause", type=float, default=0.6)
    p.add_argument("--keep", type=float, default=0.25)
    p.add_argument("--no-trim", action="store_true", help="не трогать паузы внутри кусков")
    a = p.parse_args()

    if not os.path.exists(a.src):
        sys.exit(f"ОШИБКА: нет файла {a.src}")

    keeps = parse_keeps(a.keeps)
    src_dur = duration(a.src)
    for s, e in keeps:
        if e > src_dur + 0.5:
            sys.exit(f"ОШИБКА: кусок до {e:.1f} сек, а в исходнике {src_dur:.1f}")

    tighten = load_tighten()
    tmp = tempfile.mkdtemp(prefix="takes-")
    try:
        files, durs = [], []
        for i, (s, e) in enumerate(keeps):
            dst = os.path.join(tmp, f"p{i:02d}.mp4")
            print(f"  дубль {i + 1}: {s:.2f}-{e:.2f} ({e - s:.1f} сек)")
            durs.append(cut_part(a.src, s, e, dst, not a.no_trim, tighten,
                                 a.max_pause, a.keep))
            files.append(dst)

        if len(files) == 1:
            shutil.copyfile(files[0], a.out)
        else:
            ins = []
            for f in files:
                ins += ["-i", f]
            # Каждый xfade съедает своё перекрытие, поэтому смещение следующего
            # стыка считается от уже укороченной склейки, а не от суммы длин.
            chain, vlab, alab, off = [], "[0:v]", "[0:a]", 0.0
            for i in range(1, len(files)):
                off += durs[i - 1] - a.xfade
                chain.append(f"{vlab}[{i}:v]xfade=transition=fade:"
                             f"duration={a.xfade}:offset={off:.3f}[vx{i}]")
                chain.append(f"{alab}[{i}:a]acrossfade=d={a.xfade}[ax{i}]")
                vlab, alab = f"[vx{i}]", f"[ax{i}]"
            fc = ";".join(chain) + f";{vlab}format=yuv420p[vout]"
            fc += f";{alab}loudnorm=I=-14:TP=-1.5:LRA=11[aout]"
            r = run([FFMPEG, "-y", "-loglevel", "error"] + ins +
                    ["-filter_complex", fc, "-map", "[vout]", "-map", "[aout]",
                     "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                     "-pix_fmt", "yuv420p", "-r", "30",
                     "-c:a", "aac", "-b:a", "192k", a.out])
            if r.returncode != 0:
                sys.exit("ОШИБКА ffmpeg на склейке:\n" + (r.stderr or "")[:2000])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    got = duration(a.out)
    expect = sum(durs) - a.xfade * (len(durs) - 1)
    print(f"готово: {a.out} ({got:.1f} сек)")
    # Склейка xfade тихо теряет куски, если смещения посчитаны неверно:
    # проверяем длину, иначе брак уедет дальше по конвейеру незамеченным.
    if abs(got - expect) > 0.6:
        sys.exit(f"ОШИБКА: вышло {got:.1f} сек вместо ожидаемых {expect:.1f}. "
                 f"Стыки посчитаны неверно, пересоберите.")


if __name__ == "__main__":
    main()
