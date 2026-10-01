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


def build_subs(lines, path, seconds, size, font, color, outline, shadow=5, align=8, margin=300, gap=0.0, spans=None):
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
Style: Trend,%s,%d,%s,&H00141210,&H96000000,0,0,0,0,100,100,0,0,1,%d,%d,%d,70,70,%d,204

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" % (W, H, font, size, color, outline, shadow, align, margin)
    # Фраза выкладывается кусками, каждый над своим планом. Так текст сам
    # становится ритмом: он прирастает вместе со склейками, и ролик перестаёт
    # быть неподвижной надписью поверх меняющихся картинок.
    def block(lns, a, b, fin, fout):
        tpl = 'Dialogue: 0,%s,%s,Trend,,0,0,0,,{\\fad(%d,%d)}%s\n'
        return tpl % (ass_time(a), ass_time(b), fin, fout, r'\N'.join(lns))

    body = ''
    n = len(lines)
    if spans:
        # Интервалы заданы снаружи: текст лежит ровно на тех планах, где
        # снято видео, а на фотографиях кадр остаётся чистым. Иначе подпись
        # наезжает на готовый интерьер, ради которого вставка и делалась.
        for (lns, (a0, b0)) in zip(lines, spans):
            body += block(lns, a0, b0, 220, 200)
        open(path, 'w', encoding='utf-8').write(head + body)
        return
    if n == 1:
        body = block(lines[0], 0.2, seconds - 0.1, 250, 250)
    else:
        # Последний кусок держится дольше остальных: на нём развязка,
        # и зритель должен успеть её прочесть до конца ролика.
        span = (seconds - 0.4) / (n + 0.6)
        t0 = 0.2
        for i, lns in enumerate(lines):
            last = (i == n - 1)
            t1 = seconds - 0.1 if last else t0 + span
            # Текст держится не весь свой отрезок: между кусками кадр остаётся
            # чистым. Так зритель успевает посмотреть на интерьер, а не только
            # читать, и ролик дышит вместо сплошной надписи.
            show = t1 if last else t1 - span * gap
            body += block(lns, t0, show, 200 if i else 260, 260 if last else 180)
            t0 = t1
    open(path, 'w', encoding='utf-8').write(head + body)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--clips', nargs='+', required=True)
    p.add_argument('--photos', nargs='+', default=None,
                   help='фотографии интерьеров: встают между кусками текста')
    p.add_argument('--text', required=True,
                   help='куски фразы через //, строки внутри куска через |')
    p.add_argument('--out', required=True)
    p.add_argument('--audio', default=None)
    p.add_argument('--seconds', type=float, default=23.7)
    p.add_argument('--per', type=float, default=2.12, help='секунд на план')
    p.add_argument('--size', type=int, default=62)
    p.add_argument('--font', default='Lora Medium')
    p.add_argument('--fontsdir', default='workspace/reels/fonts')
    p.add_argument('--dim', type=float, default=0.0)
    p.add_argument('--pos', choices=('top', 'middle', 'bottom'), default='top')
    p.add_argument('--margin', type=int, default=300, help='отступ от края, точек')
    p.add_argument('--outline', type=int, default=0, help='обводка букв')
    p.add_argument('--shadow', type=int, default=5, help='мягкая тень под буквами')
    p.add_argument('--seed', type=int, default=3)
    p.add_argument('--vary', action='store_true', help='рваный ритм вместо ровного')
    p.add_argument('--zoom', type=float, default=0.0, help='наезд на каждом плане, 0..0.2')
    p.add_argument('--gap', type=float, default=0.0,
                   help='доля отрезка без текста между кусками, 0..0.5')
    p.add_argument('--cine', action='store_true',
                   help='киношная окраска: контраст, лёгкая виньетка, тёплые тени')
    p.add_argument('--freeze', type=int, default=-1,
                   help='номер плана, который станет стоп-кадром')
    a = p.parse_args()

    def collect(paths, exts):
        out = []
        for c in paths:
            if os.path.isdir(c):
                out += sorted(glob.glob(os.path.join(c, '*')))
            else:
                out += sorted(glob.glob(c))
        seen, uniq = set(), []
        for f in out:
            if os.path.splitext(f)[1].lower() not in exts:
                continue
            # На Windows маска без учёта регистра ловит файл дважды.
            key = os.path.getsize(f)
            if key in seen:
                continue
            seen.add(key); uniq.append(f)
        return uniq

    files = collect(a.clips, ('.mp4', '.mov', '.m4v'))
    if not files:
        sys.exit('ОШИБКА: не нашёл ни одного ролика')
    photos = collect(a.photos, ('.jpg', '.jpeg', '.png', '.webp')) if a.photos else []
    if a.photos and not photos:
        sys.exit('ОШИБКА: фотографии указаны, но ни одной не нашёл')
    if photos:
        print('фотографий для вставок: %d' % len(photos))

    # Клипы короче плана дают недобор по длине: 12 кусков по 2,12 собрались
    # в 22,2 секунды вместо 23,7, потому что часть исходников шла по секунде.
    long_enough = [f for f in files if duration(f) >= a.per + 0.15]
    if len(long_enough) < 3:
        sys.exit('ОШИБКА: роликов длиннее %.1f сек всего %d, план не собрать'
                 % (a.per, len(long_enough)))
    if len(long_enough) < len(files):
        print('коротких роликов отброшено: %d из %d' % (len(files) - len(long_enough), len(files)))
    files = long_enough

    rnd = random.Random(a.seed)
    need = int(a.seconds / a.per) + 1
    order = files[:]
    rnd.shuffle(order)
    if len(order) < need:
        order = (order * (need // len(order) + 1))[:need]
    print('роликов в подборе: %d, нужно планов: %d по %.2f сек' % (len(files), need, a.per))

    tmp = tempfile.mkdtemp(prefix='trend-')
    try:
        # Рваный ритм вместо метронома: два коротких плана, один длинный.
        # Ровная сетка читается как слайдшоу, даже когда частота высокая.
        pattern = [a.per * 0.62, a.per * 0.62, a.per * 1.26] if a.vary else [a.per]
        plan, acc, k = [], 0.0, 0
        while acc < a.seconds:
            d = pattern[k % len(pattern)]
            plan.append(d); acc += d; k += 1
        need = len(plan)
        if len(order) < need:
            order = (order * (need // len(order) + 1))[:need]
        print('планов: %d, ритм %s' % (need, 'рваный' if a.vary else 'ровный'))

        # Фотографии встают между кусками текста: видео с подписью, потом
        # чистый кадр интерьера, снова видео. Контраст между сырой стройкой
        # и готовым кадром и есть смысл ролика.
        photo_at = set()
        if photos:
            seq, pi = [], 0
            for i in range(need):
                if i % 2 == 1 and pi < len(photos) * 10:
                    seq.append(photos[pi % len(photos)]); photo_at.add(i); pi += 1
                else:
                    seq.append(order[i % len(order)])
            order = seq
            print('фотовставок: %d из %d планов' % (len(photo_at), need))

        parts = []
        for i in range(need):
            src = order[i]
            per = plan[i]
            is_photo = i in photo_at
            d = 0.0 if is_photo else duration(src)
            # Начало берём не с нуля: первые кадры с рук часто смазаны.
            start = (min(max(0.0, d - per), 0.4 + (i * 0.7) % max(0.1, d - per - 0.4))
                     if d > per + 0.6 else 0.0)
            dst = os.path.join(tmp, 'p%03d.mp4' % i)
            vf = ('scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,'
                  'setsar=1,fps=%d,eq=brightness=-%.3f' % (W, H, W, H, FPS, a.dim))
            if a.cine:
                # Поднимаем контраст и слегка греем тени, сверху мягкая виньетка.
                # Яркость не трогаем: затемнение она уже забраковала, а глубину
                # даёт именно контраст, а не общее приглушение.
                vf += (',eq=contrast=1.09:saturation=1.06:gamma=0.98'
                       ',colorbalance=rs=0.02:gm=-0.01:bh=0.02'
                       ',vignette=PI/4.5:mode=forward')
            if a.zoom > 0:
                # Медленный наезд на каждом плане: статичный кадр даже в быстрой
                # нарезке читается как фотография. d=1 обязательно, иначе zoompan
                # размножает кадры и кусок разрастается в минуты.
                z = 1.0 + a.zoom
                step = a.zoom / max(1.0, per * FPS)
                vf += (",scale=%d:%d,zoompan=z='min(1+%0.5f*on,%0.3f)':d=1"
                       ":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
                       ":s=%dx%d:fps=%d,setsar=1"
                       % (W * 2, H * 2, step, z, W, H, FPS))
            if is_photo:
                pre = ['-loop', '1', '-t', '%.2f' % per]
            elif i == a.freeze:
                # Стоп-кадр: вытаскиваем один кадр в картинку и держим его.
                # Через -loop 1 на видеофайле не выходит, этот ключ только
                # для изображений, и кусок молча не собирается.
                still = os.path.join(tmp, 's%03d.png' % i)
                run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.2f' % start,
                     '-i', src, '-frames:v', '1', still])
                if os.path.exists(still):
                    src = still
                    pre = ['-loop', '1', '-t', '%.2f' % per]
                    vf = vf.split(',zoompan')[0]
                else:
                    pre = ['-ss', '%.2f' % start, '-t', '%.2f' % per]
            else:
                pre = ['-ss', '%.2f' % start, '-t', '%.2f' % per]
            r = run(['ffmpeg', '-y', '-loglevel', 'error'] + pre + ['-i', src, '-vf', vf, '-an',
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

        spans = None
        if photos:
            # Раскладываем куски текста по планам с видео, равномерно по всей
            # длине, и держим каждый до конца его плана.
            starts, acc = [], 0.0
            for d in plan:
                starts.append(acc); acc += d
            vid = [i for i in range(need) if i not in photo_at]
            nb = len(a.text.split('//'))
            spans = []
            for k in range(nb):
                idx = vid[min(len(vid) - 1, round(k * (len(vid) - 1) / max(1, nb - 1)))]
                s = starts[idx]
                e = min(a.seconds - 0.1, s + plan[idx] + 0.05)
                spans.append((max(0.15, s - 0.05), e))
            print('текст лёг на планы: %s' % ', '.join(str(
                vid[min(len(vid) - 1, round(k * (len(vid) - 1) / max(1, nb - 1)))]) for k in range(nb)))

        subs = os.path.join(tmp, 'text.ass')
        align = {'top': 8, 'middle': 5, 'bottom': 2}[a.pos]
        blocks = [part.split('|') for part in a.text.split('//')]
        print('кусков текста: %d' % len(blocks))
        align = {'top': 8, 'middle': 5, 'bottom': 2}[a.pos]
        build_subs(blocks, subs, a.seconds, a.size, a.font,
                   '&H00FFFFFF', a.outline, a.shadow, align, a.margin, a.gap, spans)

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
