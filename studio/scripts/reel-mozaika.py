#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-mozaika.py — ролик-витрина: мозаика, титр, нарезка в ритм.

Собран по референсу, который прислала Екатерина: кадры выкладываются плиткой,
поверх собранной мозаики появляется титр, дальше идёт быстрая нарезка крупных
планов. Смена плана привязана к долям такта, а не к ровным секундам.

Кадры рисуются покадрово через PIL, а не фильтрами ffmpeg. Причина: мозаика с
появлением плиток по одной на фильтрах превращается в нечитаемый граф, где
ошибку видно только в готовом файле. Здесь каждый кадр можно посмотреть.

Музыку скрипт не вшивает намеренно. Инстаграм глушит звук, если узнаёт трек в
загруженном видео; правильный путь — выбрать ту же дорожку в редакторе
инстаграма, где она лицензирована.

Запуск:
  python scripts/reel-mozaika.py <папка с фото> --out <ролик.mp4> --title "EMI HOME"
  python scripts/reel-mozaika.py ... --bpm 125 --seconds 10 --cols 3 --rows 5
"""

import argparse
import glob
import os
import random
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

try:                     # айфон отдаёт фотографии в heic, а их тут большинство
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

W, H = 1080, 1920
FPS = 30
BG = (16, 15, 14)


def load_photos(folder):
    files = []
    seen = set()
    for f in sorted(glob.glob(os.path.join(folder, '*'))):
        if os.path.splitext(f)[1].lower() not in ('.jpg', '.jpeg', '.png', '.webp', '.heic'):
            continue
        # На Windows маска без учёта регистра ловит один файл дважды: отсекаем
        # по содержимому, иначе половина «разных» кадров окажется повторами.
        key = os.path.getsize(f)
        if key in seen:
            continue
        seen.add(key)
        files.append(f)
    return files


def crop_to(im, w, h, bias=0.5, zoom=1.0):
    """Вырезает кусок нужной формы. zoom > 1 — приближение, то есть деталь."""
    r = max(w / im.width, h / im.height) * zoom
    n = im.resize((max(1, int(im.width * r)) + 1, max(1, int(im.height * r)) + 1),
                  Image.LANCZOS)
    left = int((n.width - w) * bias)
    top = int((n.height - h) * 0.5)
    left = max(0, min(left, n.width - w))
    top = max(0, min(top, n.height - h))
    return n.crop((left, top, left + w, top + h))


def details(files, count, rnd):
    """Делает крупные планы из общих: режет каждый кадр в разных местах.

    В присланном материале почти нет деталей, одни общие планы, а в плитке
    мозаики общий план читается как каша. Приближение вытаскивает из него
    фактуру: ткань кресла, лампу, узор обоев.
    """
    out = []
    for i in range(count):
        f = files[i % len(files)]
        im = Image.open(f).convert('RGB')
        zoom = rnd.choice((1.6, 1.9, 2.2, 2.6))
        bias = rnd.choice((0.2, 0.35, 0.5, 0.65, 0.8))
        out.append((f, im, zoom, bias))
    return out


def font(size, weight=300):
    # Знак студии нарисован тонкой линией одной толщины, с большим воздухом.
    # Жирный шрифт рядом с ним спорит, поэтому по умолчанию берём светлое
    # начертание и разрежаем буквы: так титр читается как часть того же знака.
    for p in ('workspace/reels/fonts/Manrope-%d.ttf' % weight,
              'workspace/reels/fonts/Manrope-300.ttf',
              'workspace/reels/fonts/Manrope-700.ttf'):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def spaced(text, gap='  '):
    """Разрядка: у знака много воздуха, у плотного слова его нет."""
    return gap.join(text)


def draw_spaced(d, text, fnt, cx, y, fill, track=18):
    widths = [d.textlength(ch, font=fnt) for ch in text]
    total = sum(widths) + track * (len(text) - 1)
    x = cx - total / 2
    for ch, w in zip(text, widths):
        d.text((x, y), ch, font=fnt, fill=fill)
        x += w + track
    return total


def main():
    p = argparse.ArgumentParser()
    p.add_argument('folder')
    p.add_argument('--out', required=True)
    p.add_argument('--title', default='EMI HOME')
    p.add_argument('--bpm', type=float, default=125.0)
    p.add_argument('--seconds', type=float, default=10.0)
    p.add_argument('--cols', type=int, default=3)
    p.add_argument('--rows', type=int, default=5)
    p.add_argument('--seed', type=int, default=4)
    p.add_argument('--card', action='store_true', help='титр на белой подложке')
    p.add_argument('--mark', default='workspace/assets/photos/brand/logo-white.png',
                   help='знак студии для тёмного титра')
    p.add_argument('--mark-dark', default='workspace/assets/photos/brand/logo-trim.png',
                   help='знак студии для светлой подложки')
    p.add_argument('--audio', default=None,
                   help='звуковая дорожка; по умолчанию ролик без звука')
    p.add_argument('--only-fast', action='store_true',
                   help='без мозаики и титра: только нарезка в ритм. Нужно, когда '
                        'ролик строится на входе музыки, а не на сборке плитки')
    p.add_argument('--fast-beats', type=float, default=0.5,
                   help='сколько долей такта держится план в быстрой части')
    a = p.parse_args()

    files = load_photos(a.folder)
    if len(files) < 6:
        sys.exit('ОШИБКА: нужно хотя бы шесть разных фотографий, нашёл %d' % len(files))
    print('фотографий: %d' % len(files))

    beat = 60.0 / a.bpm                      # 0.48 сек при 125
    total = int(a.seconds * FPS)
    rnd = random.Random(a.seed)

    tiles_n = a.cols * a.rows
    tw, th = W // a.cols, H // a.rows

    # Фазы в долях такта, а не в секундах: так нарезка попадает в музыку.
    t_mosaic = beat * 5          # выкладываем плитку
    t_title = t_mosaic + beat * 4
    t_slow = t_title + beat * 4
    per_slow = beat
    per_fast = beat * a.fast_beats
    if a.only_fast:
        t_mosaic = t_title = t_slow = 0.0

    print('такт %.3f сек | мозаика до %.1f | титр до %.1f | быстрая нарезка с %.1f' %
          (beat, t_mosaic, t_title, t_slow))

    mos = details(files, tiles_n, rnd)
    slow = details(files, 6, rnd)
    fast = details(files, 40, rnd)

    tile_imgs = [crop_to(im, tw, th, bias, zoom) for _, im, zoom, bias in mos]
    order = list(range(tiles_n))
    rnd.shuffle(order)

    tmp = tempfile.mkdtemp(prefix='mozaika-')
    f_title = font(84, 300)
    f_sub = font(30, 400)
    mark = mark_dark = None
    if os.path.exists(a.mark):
        mark = Image.open(a.mark).convert('RGBA')
    if os.path.exists(a.mark_dark):
        mark_dark = Image.open(a.mark_dark).convert('RGBA')
    try:
        for i in range(total):
            t = i / FPS
            frame = Image.new('RGB', (W, H), BG)

            if t < t_title:
                shown = min(tiles_n, int(t / (t_mosaic / tiles_n)) + 1)
                for k in range(shown):
                    idx = order[k]
                    frame.paste(tile_imgs[idx], ((idx % a.cols) * tw, (idx // a.cols) * th))
            elif t < t_slow:
                k = int((t - t_title) / per_slow) % len(slow)
                _, im, zoom, bias = slow[k]
                frame.paste(crop_to(im, W, H, bias, zoom * 0.85), (0, 0))
            else:
                k = int((t - t_slow) / per_fast) % len(fast)
                _, im, zoom, bias = fast[k]
                frame.paste(crop_to(im, W, H, bias, zoom * 0.8), (0, 0))

            # Титр держится от момента, когда мозаика собралась, и до конца
            # медленной части: в референсе он лежит поверх собранной картинки.
            if t_mosaic <= t < t_slow:
                d = ImageDraw.Draw(frame)
                sub = 'дизайн интерьеров'
                asc, desc = f_title.getmetrics()
                th_ = asc
                sb = d.textbbox((0, 0), sub, font=f_sub)
                sw_, sh_ = sb[2] - sb[0], sb[3] - sb[1]
                track = int(f_title.size * 0.22)
                tw_ = sum(d.textlength(c, font=f_title) for c in a.title) + track * (len(a.title) - 1)

                mark_h = int(f_title.size * 1.15) if mark else 0
                gap1, gap2 = int(f_title.size * 0.42), int(f_title.size * 0.30)
                block_h = mark_h + (gap1 if mark else 0) + th_ + gap2 + sh_
                y0 = (H - block_h) // 2

                if a.card:
                    pad = 52
                    bw = max(tw_, sw_, mark_h)
                    d.rectangle([(W - bw) // 2 - pad, y0 - pad,
                                 (W + bw) // 2 + pad, y0 + block_h + pad],
                                fill=(245, 242, 236))
                    c_title, c_sub = (24, 22, 20), (96, 90, 84)
                    sign = mark_dark
                else:
                    veil = Image.new('RGBA', (W, H), (0, 0, 0, 0))
                    ImageDraw.Draw(veil).rectangle(
                        [0, y0 - 110, W, y0 + block_h + 110], fill=(12, 11, 10, 120))
                    frame = Image.alpha_composite(frame.convert('RGBA'), veil).convert('RGB')
                    d = ImageDraw.Draw(frame)
                    c_title, c_sub = (250, 248, 244), (214, 208, 200)
                    sign = mark

                y = y0
                if sign is not None:
                    m = sign.resize((int(sign.width * mark_h / sign.height), mark_h),
                                    Image.LANCZOS)
                    frame.paste(m, ((W - m.width) // 2, y), m)
                    y += mark_h + gap1
                draw_spaced(d, a.title, f_title, W / 2, y, c_title, track)
                y += th_ + gap2
                d.text(((W - sw_) // 2 - sb[0], y - sb[1]), sub, font=f_sub, fill=c_sub)

            frame.save(os.path.join(tmp, 'f%04d.jpg' % i), quality=92)
            if (i + 1) % 60 == 0:
                print('  кадров %d из %d' % (i + 1, total), flush=True)

        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS),
               '-i', os.path.join(tmp, 'f%04d.jpg')]
        if a.audio:
            cmd += ['-i', a.audio, '-map', '0:v', '-map', '1:a',
                    '-c:a', 'aac', '-b:a', '192k', '-shortest',
                    '-af', 'afade=t=out:st=%.2f:d=0.5' % (total / FPS - 0.5)]
        else:
            cmd += ['-an']
        cmd += ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
                '-pix_fmt', 'yuv420p', a.out]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0:
            sys.exit('ОШИБКА ffmpeg:\n' + r.stderr.decode('utf-8', 'replace')[:1500])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print('готово: %s (%.1f сек, без звука)' % (a.out, total / FPS))
    print('Музыку добавлять в редакторе инстаграма, не вшивать в файл.')


if __name__ == '__main__':
    main()
