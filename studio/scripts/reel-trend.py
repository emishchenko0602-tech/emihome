#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-trend.py — тренд «одна строка поверх видеоряда».

Формат разобран по референсу: неподвижный текст посередине экрана держится
весь ролик, меняется только то, что за ним. Нарезка медленная, два-четыре
такта на план, а не покадровая рубка.

Смысл формата — разрыв: в тексте утверждение, за текстом доказательство.
Поэтому кадры нужны не красивые, а подтверждающие.

Звук берётся из файла, который прислал клиент. Если ролик пойдёт в инстаграм,
правильнее выбрать тот же трек в редакторе: там он лицензирован, а вшитый
инстаграм глушит.

Запуск:
  python scripts/reel-trend.py --clips <папка> --text "строка|строка" --out <ролик.mp4>
  python scripts/reel-trend.py ... --audio <файл> --seconds 23.7 --per 2.1
"""

import argparse
import glob
import os
import random
import shutil
import subprocess
import sys
import tempfile

W, H = 1080, 1920
FPS = 30


def run(args):
    return subprocess.run(args, capture_output=True, text=True,
                          encoding='utf-8', errors='replace')


def duration(path):
    r = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=nk=1:nw=1', path])
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def ass_time(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return '%d:%02d:%05.2f' % (h, m, s)


def build_subs(lines, path, seconds, size, font, color, outline, align=8, margin=300):
    """align 8 — сверху, 5 — посередине, 2 — снизу.

    По центру текст ложится на лицо: в кадрах со стройки автор обычно стоит
    в середине. Поэтому по умолчанию сверху, как в остальных её роликах.
    """
    head = """[Script Info]
ScriptType: v4.00+
WrapStyle: 0
PlayResX: %d
PlayResY: %d
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Trend,%s,%d,%s,&H00141210,&H78000000,0,0,0,0,100,100,0,0,1,%d,2,%d,80,80,%d,204

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" % (W, H, font, size, color, outline, align, margin)
    text = r'\N'.join(lines)
    body = 'Dialogue: 0,%s,%s,Trend,,0,0,0,,{\\fad(250,250)}%s\n' % (
        ass_time(0.2), ass_time(seconds - 0.1), text)
    open(path, 'w', encoding='utf-8').write(head + body)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--clips', nargs='+', required=True)
    p.add_argument('--text', required=True, help='строки через вертикальную черту')
    p.add_argument('--out', required=True)
    p.add_argument('--audio', default=None)
    p.add_argument('--seconds', type=float, default=23.7)
    p.add_argument('--per', type=float, default=2.12, help='секунд на план')
    p.add_argument('--size', type=int, default=62)
    p.add_argument('--font', default='Lora Medium')
    p.add_argument('--fontsdir', default='workspace/reels/fonts')
    p.add_argument('--dim', type=float, default=0.12)
    p.add_argument('--pos', choices=('top', 'middle', 'bottom'), default='top')
    p.add_argument('--margin', type=int, default=300, help='отступ от края, точек')
    p.add_argument('--seed', type=int, default=3)
    a = p.parse_args()

    files = []
    for c in a.clips:
        if os.path.isdir(c):
            files += sorted(glob.glob(os.path.join(c, '*')))
        else:
            files += sorted(glob.glob(c))
    files = [f for f in files if os.path.splitext(f)[1].lower() in ('.mp4', '.mov', '.m4v')]
    if not files:
        sys.exit('ОШИБКА: не нашёл ни одного ролика')

    # Клипы короче плана дают недобор по длине: 12 кусков по 2,12 собрались
    # в 22,2 секунды вместо 23,7, потому что часть исходников шла по секунде.
    long_enough = [f for f in files if duration(f) >= a.per + 0.15]
    if len(long_enough) < 3:
        sys.exit('ОШИБКА: роликов длиннее %.1f сек всего %d, план не собрать'
                 % (a.per, len(long_enough)))
    if len(long_enough) < len(files):
        print('коротких роликов отброшено: %d из %d' % (len(files) - len(long_enough), len(files)))
    files = long_enough

    need = int(a.seconds / a.per) + 1
    rnd = random.Random(a.seed)
    order = files[:]
    rnd.shuffle(order)
    if len(order) < need:
        order = (order * (need // len(order) + 1))[:need]
    print('роликов в подборе: %d, нужно планов: %d по %.2f сек' % (len(files), need, a.per))

    tmp = tempfile.mkdtemp(prefix='trend-')
    try:
        parts = []
        for i in range(need):
            src = order[i]
            d = duration(src)
            # Начало берём не с нуля: первые кадры с рук часто смазаны.
            start = min(max(0.0, d - a.per), 0.4 + (i * 0.7) % max(0.1, d - a.per - 0.4)) if d > a.per + 0.6 else 0.0
            dst = os.path.join(tmp, 'p%03d.mp4' % i)
            vf = ('scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,'
                  'setsar=1,fps=%d,eq=brightness=-%.3f' % (W, H, W, H, FPS, a.dim))
            r = run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.2f' % start,
                     '-t', '%.2f' % a.per, '-i', src, '-vf', vf, '-an',
                     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                     '-pix_fmt', 'yuv420p', dst])
            if r.returncode != 0 or not os.path.exists(dst):
                print('  ! пропускаю %s' % os.path.basename(src))
                continue
            parts.append(dst)

        lst = os.path.join(tmp, 'list.txt')
        with open(lst, 'w', encoding='utf-8') as f:
            for s in parts:
                f.write("file '%s'\n" % s.replace('\\', '/'))
        joined = os.path.join(tmp, 'joined.mp4')
        r = run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
                 '-i', lst, '-t', '%.2f' % a.seconds, '-an',
                 '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                 '-pix_fmt', 'yuv420p', joined])
        if r.returncode != 0:
            sys.exit('ОШИБКА склейки:\n' + (r.stderr or '')[:1200])

        got = duration(joined)
        if abs(got - a.seconds) > 0.6:
            sys.exit('ОШИБКА: видеоряд %.1f сек вместо %.1f' % (got, a.seconds))

        subs = os.path.join(tmp, 'text.ass')
        align = {'top': 8, 'middle': 5, 'bottom': 2}[a.pos]
        build_subs(a.text.split('|'), subs, a.seconds, a.size, a.font,
                   '&H00F6F3EE', 3, align, a.margin)

        esc = subs.replace('\\', '/').replace(':', '\\:')
        fd = a.fontsdir.replace('\\', '/').replace(':', '\\:')
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', joined]
        if a.audio:
            cmd += ['-i', a.audio, '-map', '0:v', '-map', '1:a',
                    '-c:a', 'aac', '-b:a', '192k', '-shortest',
                    '-af', 'afade=t=out:st=%.2f:d=0.6' % (a.seconds - 0.6)]
        else:
            cmd += ['-an']
        cmd += ['-vf', "subtitles='%s':fontsdir='%s'" % (esc, fd),
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
                '-pix_fmt', 'yuv420p', a.out]
        r = run(cmd)
        if r.returncode != 0:
            sys.exit('ОШИБКА наложения текста:\n' + (r.stderr or '')[:1200])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print('готово: %s (%.1f сек)' % (a.out, duration(a.out)))


if __name__ == '__main__':
    main()
