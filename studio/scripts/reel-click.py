#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-click.py — щелчок как монтажный переход.

Идея Екатерины: крупно рука щёлкает выключателем, сразу после щелчка кадр
переключается на готовый интерьер. Склейка получает причину — зритель видит,
что картинка сменилась потому, что её переключили, и досматривает, чтобы
увидеть следующий щелчок.

Момент щелчка ищется по звуку, а не на глаз: промах в треть секунды убивает
весь эффект, а на глаз такую разницу не поймать.

Запуск:
  python scripts/reel-click.py --clicks <папка> --reveals <папка> --out <ролик.mp4>
  python scripts/reel-click.py ... --text "ДЕВОЧКИ//ВАШ ДИЗАЙНЕР НЕ ПРОПАЛ" --audio <трек>
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

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


def find_click(path):
    """Момент щелчка: самый резкий скачок энергии звука.

    Возвращает (время, резкость). Резкость ниже 0.4 означает, что внятного
    щелчка в ролике нет и брать его не стоит.
    """
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1',
                        '-ar', '22050', '-f', 's16le', '-'], capture_output=True)
    a = np.frombuffer(r.stdout, np.int16).astype(np.float32) / 32768
    if len(a) < 2205:
        return None, 0.0
    hop = 220
    n = len(a) // hop
    e = np.array([float((a[i * hop:(i + 1) * hop] ** 2).sum()) for i in range(n)])
    m = e.max()
    if m <= 0:
        return None, 0.0
    e /= m
    d = np.diff(e, prepend=e[0])
    d[d < 0] = 0
    i = int(np.argmax(d))
    return i * hop / 22050, float(d[i])


def collect(paths, exts):
    out, seen, uniq = [], set(), []
    for c in paths:
        out += sorted(glob.glob(os.path.join(c, '*'))) if os.path.isdir(c) else sorted(glob.glob(c))
    for f in out:
        if os.path.splitext(f)[1].lower() not in exts:
            continue
        k = os.path.getsize(f)
        if k in seen:
            continue
        seen.add(k)
        uniq.append(f)
    return uniq


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--clicks', nargs='+', required=True, help='ролики со щелчками')
    p.add_argument('--reveals', nargs='+', required=True, help='что показываем после щелчка')
    p.add_argument('--out', required=True)
    p.add_argument('--audio', default=None)
    p.add_argument('--pairs', type=int, default=6, help='сколько пар щелчок-интерьер')
    p.add_argument('--before', type=float, default=0.55, help='сколько секунд до щелчка показать')
    p.add_argument('--after', type=float, default=0.10, help='сколько оставить после щелчка')
    p.add_argument('--reveal', type=float, default=1.45, help='длина кадра после щелчка')
    p.add_argument('--min-sharp', type=float, default=0.4)
    p.add_argument('--cine', action='store_true')
    p.add_argument('--punch', type=float, default=0.0,
                   help='наезд на щелчке, 0..0.4: камера ускоряется к моменту щелчка')
    p.add_argument('--sharp', type=float, default=0.0,
                   help='резкость кадра, 0..1.5')
    p.add_argument('--lift', type=float, default=0.0,
                   help='высветлить кадры со щелчком, 0..0.2')
    p.add_argument('--drift', type=float, default=0.0,
                   help='боковой снос камеры на наезде, 0..0.3')
    p.add_argument('--finale', type=float, default=0.0,
                   help='секунд в конце под быструю россыпь фотографий')
    p.add_argument('--finale-per', type=float, default=0.34,
                   help='длина кадра в финале, сек')
    p.add_argument('--endshot', default=None,
                   help='ролик для последнего крупного плана')
    p.add_argument('--endshot-len', type=float, default=1.3)
    p.add_argument('--endtext', default=None,
                   help='строка в самом конце, строки через вертикальную черту')
    p.add_argument('--endtext-size', type=int, default=92)
    p.add_argument('--endtext-font', default='Montserrat Black')
    p.add_argument('--fontsdir', default='workspace/reels/fonts')
    a = p.parse_args()

    clicks = collect(a.clicks, ('.mp4', '.mov', '.m4v'))
    reveals = collect(a.reveals, ('.mp4', '.mov', '.m4v', '.jpg', '.jpeg', '.png'))
    if not clicks or not reveals:
        sys.exit('ОШИБКА: нужны и щелчки, и кадры для показа')

    good = []
    for f in clicks:
        t, sharp = find_click(f)
        if t is None or sharp < a.min_sharp:
            continue
        # Щелчок у самого начала не годится: не успеваем показать подводку.
        if t < a.before * 0.5:
            continue
        good.append((f, t, sharp))
    good.sort(key=lambda x: -x[2])
    print('щелчков с внятным звуком: %d из %d' % (len(good), len(clicks)))
    if len(good) < 2:
        sys.exit('ОШИБКА: внятных щелчков меньше двух')

    tmp = tempfile.mkdtemp(prefix='click-')
    grade = (',eq=contrast=1.09:saturation=1.06:gamma=0.98,vignette=PI/4.5:mode=forward'
             if a.cine else '')
    try:
        parts = []
        for i in range(a.pairs):
            src, t, _ = good[i % len(good)]
            start = max(0.0, t - a.before)
            length = (t + a.after) - start
            dst = os.path.join(tmp, 'c%02d.mp4' % i)
            vf = ('scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,'
                  'setsar=1,fps=%d%s' % (W, H, W, H, FPS, grade))
            if a.lift > 0:
                # Съёмка на стройке тёмная: там серый бетон и мало света.
                # Поднимаем только кадры со щелчком, фотографии и так светлые.
                vf += ',eq=brightness=%0.3f:contrast=1.04' % a.lift
            if a.punch > 0:
                # Наезд с ускорением к щелчку: квадрат от доли пройденного
                # времени. Ровный наезд читается как технический зум, а
                # ускоряющийся — как бросок камеры, и щелчок получает удар.
                frames = max(2, int(length * FPS))
                # Снос вбок вместе с наездом: настоящего облёта из неподвижного
                # плана не сделать, но смещение точки съёмки при приближении
                # читается как движение камеры вокруг, а не как простой зум.
                xexpr = ("iw/2-(iw/zoom/2)+%0.1f*sin(on/%d*1.57)" % (W * a.drift, frames)
                         if a.drift > 0 else "iw/2-(iw/zoom/2)")
                vf += (',scale=%d:%d,zoompan='
                       "z='1+%0.4f*pow(on/%d,2)':d=1"
                       ":x='%s':y='ih/2-(ih/zoom/2)'"
                       ':s=%dx%d:fps=%d,setsar=1'
                       % (W * 2, H * 2, a.punch, frames, xexpr, W, H, FPS))
            if a.sharp > 0:
                vf += ',unsharp=5:5:%0.2f:3:3:0.0' % a.sharp
            r = run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.3f' % start,
                     '-t', '%.3f' % length, '-i', src, '-vf', vf, '-an',
                     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                     '-pix_fmt', 'yuv420p', dst])
            if r.returncode == 0 and os.path.exists(dst):
                parts.append(dst)
            else:
                print('  ! щелчок %s не вырезался' % os.path.basename(src))
                continue

            rv = reveals[i % len(reveals)]
            dst2 = os.path.join(tmp, 'r%02d.mp4' % i)
            is_img = os.path.splitext(rv)[1].lower() in ('.jpg', '.jpeg', '.png')
            pre = ['-loop', '1', '-t', '%.3f' % a.reveal] if is_img else \
                  ['-ss', '%.2f' % min(0.5, max(0.0, duration(rv) - a.reveal)),
                   '-t', '%.3f' % a.reveal]
            vf2 = ('scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,'
                   'setsar=1,fps=%d%s' % (W, H, W, H, FPS, grade))
            if a.sharp > 0:
                vf2 += ',unsharp=5:5:%0.2f:3:3:0.0' % a.sharp
            r = run(['ffmpeg', '-y', '-loglevel', 'error'] + pre + ['-i', rv, '-vf', vf2, '-an',
                     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                     '-pix_fmt', 'yuv420p', dst2])
            if r.returncode == 0 and os.path.exists(dst2):
                parts.append(dst2)

        # Финал: трек в конце учащается, и под него идёт россыпь интерьеров,
        # а последним кадром крупный план автора. Это даёт концовку вместо
        # обрыва на очередном щелчке.
        if a.finale > 0:
            k = int(a.finale / a.finale_per)
            vf3 = ('scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,'
                   'setsar=1,fps=%d%s' % (W, H, W, H, FPS, grade))
            if a.sharp > 0:
                vf3 += ',unsharp=5:5:%0.2f:3:3:0.0' % a.sharp
            for j in range(k):
                rv = reveals[(len(reveals) - 1 - j) % len(reveals)]
                dst3 = os.path.join(tmp, 'f%02d.mp4' % j)
                is_img = os.path.splitext(rv)[1].lower() in ('.jpg', '.jpeg', '.png')
                pre3 = ['-loop', '1', '-t', '%.3f' % a.finale_per] if is_img else                        ['-ss', '0.3', '-t', '%.3f' % a.finale_per]
                r = run(['ffmpeg', '-y', '-loglevel', 'error'] + pre3 +
                        ['-i', rv, '-vf', vf3, '-an', '-c:v', 'libx264',
                         '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', dst3])
                if r.returncode == 0 and os.path.exists(dst3):
                    parts.append(dst3)
            print('россыпь в финале: %d кадров по %.2f сек' % (k, a.finale_per))

        if a.endshot and os.path.exists(a.endshot):
            dste = os.path.join(tmp, 'zz.mp4')
            d = duration(a.endshot)
            ss = max(0.0, d / 2 - a.endshot_len / 2)
            vfe = ('scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,'
                   'setsar=1,fps=%d%s' % (W, H, W, H, FPS, grade))
            if a.lift > 0:
                vfe += ',eq=brightness=%0.3f:contrast=1.04' % a.lift
            if a.sharp > 0:
                vfe += ',unsharp=5:5:%0.2f:3:3:0.0' % a.sharp
            r = run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.2f' % ss,
                     '-t', '%.2f' % a.endshot_len, '-i', a.endshot, '-vf', vfe, '-an',
                     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                     '-pix_fmt', 'yuv420p', dste])
            if r.returncode == 0 and os.path.exists(dste):
                parts.append(dste)
                print('последний кадр: %s' % os.path.basename(a.endshot))

        lst = os.path.join(tmp, 'list.txt')
        with open(lst, 'w', encoding='utf-8') as f:
            for s in parts:
                f.write("file '%s'\n" % s.replace('\\', '/'))
        # Строка в самом конце, после того как приём отработал. Поверх всего
        # ролика текст соперничал бы со щелчком; здесь он ставит точку: зритель
        # уже восемь раз увидел лёгкость, и тут ему называют настоящую цену.
        subs = None
        if a.endtext:
            total = sum(duration(x) for x in parts)
            start = max(0.0, total - a.endshot_len + 0.2)
            subs = os.path.join(tmp, 'end.ass')
            style = ('Style: End,%s,%d,&H00FFFFFF,&H00141210,&H96000000,0,0,0,0,'
                     '100,100,0,0,1,0,5,5,70,70,0,204' % (a.endtext_font, a.endtext_size))
            head = '\n'.join([
                '[Script Info]', 'ScriptType: v4.00+', 'WrapStyle: 0',
                'PlayResX: %d' % W, 'PlayResY: %d' % H,
                'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
                'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, '
                'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, '
                'Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, '
                'MarginR, MarginV, Encoding',
                style, '', '[Events]',
                'Format: Layer, Start, End, Style, Name, MarginL, MarginR, '
                'MarginV, Effect, Text', ''])

            def tt(x):
                return '%d:%02d:%05.2f' % (int(x // 3600), int(x % 3600 // 60), x % 60)

            line = r'\N'.join(a.endtext.split('|'))
            body = ('Dialogue: 0,%s,%s,End,,0,0,0,,{\\fad(260,120)}%s\n'
                    % (tt(start), tt(total - 0.05), line))
            open(subs, 'w', encoding='utf-8').write(head + body)
            print('строка в конце с %.2f сек' % start)

        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst]
        if a.audio:
            cmd += ['-i', a.audio, '-map', '0:v', '-map', '1:a', '-shortest',
                    '-c:a', 'aac', '-b:a', '192k']
        else:
            cmd += ['-an']
        if subs:
            esc = subs.replace('\\', '/').replace(':', '\\:')
            fd = a.fontsdir.replace('\\', '/').replace(':', '\\:')
            cmd += ['-vf', "subtitles='%s':fontsdir='%s'" % (esc, fd)]
        cmd += ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
                '-pix_fmt', 'yuv420p', a.out]
        r = run(cmd)
        if r.returncode != 0:
            sys.exit('ОШИБКА сборки:\n' + (r.stderr or '')[:1200])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    got = duration(a.out)
    print('готово: %s (%.1f сек, пар %d)' % (a.out, got, len(parts) // 2))
    if got < 3:
        sys.exit('ОШИБКА: ролик вышел короче трёх секунд, собралось не всё')


if __name__ == '__main__':
    main()
