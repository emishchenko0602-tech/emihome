#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
make-pdf.py — лид-магнит в вёрстке инстаграм-карусели.

Формат 1080x1350 (те же 4:5, что у поста), фотография объекта фоном под
плотной кремовой вуалью, шапка с хэндлом и счётчиком страниц, подвал с
брендом. Собрано по работающему чек-листу «15 пунктов перед дизайном
интерьера ресторана»: он уже принят и отдаётся из воронки, поэтому своя
вёрстка здесь не нужна.

Почему не A4: файл открывают с телефона в директе. Вертикаль 4:5 занимает
экран целиком, A4 показывается мелкой страницей с полями.

Почему страницы рисуются как изображения: нужны фотоподложки, вуаль и
разрядка в заголовках. Генераторы PDF ради этого тянут за собой браузер,
а PIL уже стоит и даёт покадровый контроль.

Формат входного файла:

    # Заголовок обложки
    ## Подзаголовок обложки
    == Название блока          (необязательно, группирует пункты)
    1. Название пункта
    Текст пункта
    ---
    Текст финальной страницы
    [кнопка] Надпись на кнопке

Запуск:
  python scripts/make-pdf.py текст.txt --out файл.pdf \
    --brand "LA POUF" --tagline "ТЕКСТИЛЬ КАК ЧАСТЬ ИНТЕРЬЕРА" \
    --handle "@lapouf_textile" --photos папка/с/фото --png-dir папка/для/просмотра
"""

import argparse
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

try:                                    # фотографии с айфона приходят в heic
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

W, H = 1080, 1350
M = 90                                   # боковые поля
TOP, BOT = 210, 1165                     # рабочая полоса между шапкой и подвалом

CREAM = (247, 242, 233)
INK = (42, 40, 38)
BODY = (74, 70, 66)
MUTE = (168, 160, 150)
ACCENT = (142, 59, 47)                   # кирпичный; меняется одним флагом

FONTS = 'workspace/reels/fonts'


def font(name, size):
    p = os.path.join(FONTS, name + '.ttf')
    if os.path.exists(p):
        return ImageFont.truetype(p, size)
    alt = os.path.join(FONTS, 'Manrope-400.ttf')
    return ImageFont.truetype(alt, size) if os.path.exists(alt) else ImageFont.load_default()


def wrap(d, text, fnt, width):
    lines, cur = [], ''
    for w in text.split():
        t = (cur + ' ' + w).strip()
        if d.textlength(t, font=fnt) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def spaced(d, text, fnt, x, y, fill, track):
    """Разрядка: в подписях капсом буквы должны дышать, иначе читается как шум."""
    for ch in text:
        d.text((x, y), ch, font=fnt, fill=fill)
        x += d.textlength(ch, font=fnt) + track
    return x


def spaced_width(d, text, fnt, track):
    return sum(d.textlength(c, font=fnt) for c in text) + track * max(0, len(text) - 1)


def cover_crop(im, w, h):
    r = max(w / im.width, h / im.height)
    n = im.resize((int(im.width * r) + 1, int(im.height * r) + 1), Image.LANCZOS)
    return n.crop(((n.width - w) // 2, (n.height - h) // 2,
                   (n.width - w) // 2 + w, (n.height - h) // 2 + h))


def scrim(page, top=250, bottom=300, strength=0.92):
    """Кремовые растяжки у верхнего и нижнего края.

    Шапка и подвал набраны светло-серым. Над пёстрым участком фотографии
    такая подпись просто пропадает, а проверить это можно только глазами
    на готовой странице. Растяжка гасит фон ровно там, где идёт мелкий текст,
    и не трогает середину.
    """
    mask = Image.new('L', (W, H), 0)
    md = ImageDraw.Draw(mask)
    for y in range(top):
        md.line([(0, y), (W, y)], fill=int(255 * strength * (1 - y / top) ** 1.6))
    for i in range(bottom):
        y = H - 1 - i
        md.line([(0, y), (W, y)], fill=int(255 * strength * (1 - i / bottom) ** 1.6))
    return Image.composite(Image.new('RGB', (W, H), CREAM), page, mask)


def backdrop(photo, veil):
    """Фон страницы: фото, уведённое в кремовый.

    Вуаль намеренно плотная. Фотография здесь не иллюстрация, а фактура:
    она должна читаться краем глаза и ни на миллиметр не мешать тексту.
    """
    page = Image.new('RGB', (W, H), CREAM)
    if photo is None:
        return page
    return scrim(Image.blend(cover_crop(photo, W, H), page, veil))


def chrome(d, handle, page_no, total, brand, tagline, more):
    """Шапка и подвал — одинаковые на всех страницах."""
    f_small = font('Manrope-400', 27)
    if handle:
        d.text((M, 52), handle, font=f_small, fill=MUTE)
    num = '%d/%d' % (page_no, total)
    d.text((W - M - d.textlength(num, font=f_small), 52), num, font=f_small, fill=MUTE)

    f_brand = font('Montserrat-800', 31)
    f_tag = font('Manrope-400', 20)
    d.text((M, H - 128), brand, font=f_brand, fill=INK)
    if tagline:
        spaced(d, tagline.upper(), f_tag, M, H - 86, MUTE, 4)

    if more:
        f_more = font('Manrope-700', 26)
        t = 'Листай дальше'
        x = W - M - d.textlength(t, font=f_more) - 38
        d.text((x, H - 108), t, font=f_more, fill=ACCENT)
        # Стрелку рисуем линиями: гарантии, что глиф есть в шрифте, нет.
        ax, ay = W - M - 26, H - 95
        d.line([(ax, ay), (ax + 22, ay)], fill=ACCENT, width=3)
        d.line([(ax + 13, ay - 8), (ax + 22, ay), (ax + 13, ay + 8)], fill=ACCENT, width=3)


def parse(path):
    title = sub = tail = button = ''
    items, cur, block = [], None, ''
    mode = 'head'
    for raw in open(path, encoding='utf-8'):
        s = raw.rstrip('\n')
        t = s.strip()
        if t.startswith('# '):
            title = t[2:].strip(); continue
        if t.startswith('## '):
            sub = t[3:].strip(); continue
        if t.startswith('== '):
            block = t[3:].strip(); continue
        if t == '---':
            mode = 'tail'; continue
        if mode == 'tail':
            if t.startswith('[кнопка]'):
                button = t[len('[кнопка]'):].strip()
            else:
                tail += s + '\n'
            continue
        head = t.split('.', 1)
        if len(head) == 2 and head[0].isdigit():
            if cur:
                items.append(cur)
            cur = {'n': head[0], 'head': head[1].strip(), 'body': '', 'block': block}
        elif t and cur:
            cur['body'] += (' ' if cur['body'] else '') + t
    if cur:
        items.append(cur)
    return title, sub, items, tail.strip(), button


def load_photos(folder):
    if not folder:
        return []
    out = []
    for f in sorted(glob.glob(os.path.join(folder, '*'))):
        if os.path.splitext(f)[1].lower() not in ('.jpg', '.jpeg', '.png', '.heic', '.webp'):
            continue
        try:
            out.append(Image.open(f).convert('RGB'))
        except Exception as e:
            print('  пропустил %s: %s' % (os.path.basename(f), e))
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('src')
    p.add_argument('--out', required=True)
    p.add_argument('--brand', default='')
    p.add_argument('--tagline', default='')
    p.add_argument('--handle', default='')
    p.add_argument('--eyebrow', default='ГАЙД ДЛЯ ПРОЕКТА')
    p.add_argument('--photos', default=None)
    p.add_argument('--veil', type=float, default=0.90,
                   help='плотность кремовой вуали поверх фото: 1.0 — фото не видно')
    p.add_argument('--cover-veil', type=float, default=0.80)
    p.add_argument('--accent', default=None, help='акцентный цвет в виде RRGGBB')
    p.add_argument('--per-page', type=int, default=2)
    p.add_argument('--png-dir', default=None)
    a = p.parse_args()

    global ACCENT
    if a.accent:
        h = a.accent.lstrip('#')
        ACCENT = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

    if not os.path.exists(a.src):
        sys.exit('ОШИБКА: нет файла %s' % a.src)

    title, sub, items, tail, button = parse(a.src)
    if not items:
        sys.exit('ОШИБКА: не нашёл ни одного пункта')

    photos = load_photos(a.photos)
    print('пунктов: %d | фотографий: %d' % (len(items), len(photos)))
    if a.photos and not photos:
        sys.exit('ОШИБКА: папка с фото указана, но ни одной картинки не открылось')

    chunks = [items[i:i + a.per_page] for i in range(0, len(items), a.per_page)]
    total = 1 + len(chunks) + (1 if tail else 0)

    f_eyebrow = font('Montserrat-800', 25)
    f_big = font('Montserrat-900', 150)
    f_title = font('Montserrat-900', 52)
    f_sub = font('Manrope-400', 29)
    f_block = font('Montserrat-800', 25)
    f_num = font('Montserrat-900', 40)
    f_head = font('Montserrat-800', 37)
    f_body = font('Manrope-400', 29)
    f_ask = font('Montserrat-900', 60)
    f_btn = font('Montserrat-800', 31)

    pages = []
    ph = lambda i: photos[i % len(photos)] if photos else None

    # ---- обложка -------------------------------------------------------
    page = backdrop(ph(0), a.cover_veil)
    d = ImageDraw.Draw(page)
    t_lines = wrap(d, title, f_title, W - M * 2)
    s_lines = wrap(d, sub, f_sub, W - M * 2) if sub else []
    block_h = 74 + 179 + len(t_lines) * 64 + (26 + len(s_lines) * 42 if s_lines else 0)
    y = BOT - block_h - 40
    spaced(d, a.eyebrow.upper(), f_eyebrow, M, y, ACCENT, 5)
    y += 74
    d.text((M, y), str(len(items)), font=f_big, fill=ACCENT)
    y += 179
    for ln in t_lines:
        d.text((M, y), ln, font=f_title, fill=INK); y += 64
    if s_lines:
        y += 26
        for ln in s_lines:
            d.text((M, y), ln, font=f_sub, fill=BODY); y += 42
    chrome(d, a.handle, 1, total, a.brand, a.tagline, True)
    pages.append(page)

    # ---- страницы с пунктами -------------------------------------------
    x = M + 76
    gap = 58
    shown_blocks = set()
    for k, chunk in enumerate(chunks):
        page = backdrop(ph(k + 1), a.veil)
        d = ImageDraw.Draw(page)

        block = chunk[0]['block']
        new_block = bool(block) and block not in shown_blocks
        if new_block:
            shown_blocks.add(block)

        # Меряем до отрисовки: пункты разной длины, и без этого текст
        # на коротких страницах прилипает к шапке.
        measured, total_h = [], 0
        for it in chunk:
            hl = wrap(d, it['head'], f_head, W - M - x)
            bl = wrap(d, it['body'], f_body, W - M - x)
            measured.append((it['n'], hl, bl))
            total_h += len(hl) * 48 + 14 + len(bl) * 43 + gap
        total_h -= gap
        if new_block:
            total_h += 62

        y = max(TOP, (TOP + BOT - total_h) // 2)
        if new_block:
            spaced(d, block.upper(), f_block, M, y, ACCENT, 5)
            y += 62
        for n, hl, bl in measured:
            d.text((M, y + 2), n, font=f_num, fill=ACCENT)
            hy = y
            for ln in hl:
                d.text((x, hy), ln, font=f_head, fill=INK); hy += 48
            by = hy + 14
            for ln in bl:
                d.text((x, by), ln, font=f_body, fill=BODY); by += 43
            y = by + gap
        chrome(d, a.handle, k + 2, total, a.brand, a.tagline, True)
        pages.append(page)

    # ---- финальная страница --------------------------------------------
    if tail:
        page = backdrop(ph(len(chunks) + 1), a.cover_veil)
        d = ImageDraw.Draw(page)
        blocks = [b.strip() for b in tail.split('\n') if b.strip()]
        ask = blocks[0] if blocks and blocks[0].endswith('?') else ''
        rest = blocks[1:] if ask else blocks

        ask_lines = wrap(d, ask, f_ask, W - M * 2) if ask else []
        rest_lines = [wrap(d, b, f_body, W - M * 2 - 60) for b in rest]
        h = len(ask_lines) * 72 + (40 if ask_lines else 0)
        h += sum(len(ls) * 43 + 28 for ls in rest_lines)
        if button:
            h += 50 + 96
        y = max(TOP, (TOP + BOT - h) // 2)

        for ln in ask_lines:
            d.text(((W - d.textlength(ln, font=f_ask)) / 2, y), ln, font=f_ask, fill=INK)
            y += 72
        if ask_lines:
            y += 40
        for ls in rest_lines:
            for ln in ls:
                d.text(((W - d.textlength(ln, font=f_body)) / 2, y), ln, font=f_body, fill=BODY)
                y += 43
            y += 28
        if button:
            y += 50
            bw = d.textlength(button, font=f_btn) + 110
            bh = 96
            d.rounded_rectangle([(W - bw) / 2, y, (W + bw) / 2, y + bh],
                                radius=bh // 2, fill=ACCENT)
            d.text(((W - d.textlength(button, font=f_btn)) / 2, y + 27),
                   button, font=f_btn, fill=(255, 252, 248))
        chrome(d, a.handle, total, total, a.brand, a.tagline, False)
        pages.append(page)

    if a.png_dir:
        os.makedirs(a.png_dir, exist_ok=True)
        for i, pg in enumerate(pages):
            pg.save(os.path.join(a.png_dir, 'p%02d.png' % (i + 1)))
        print('страницы картинками: %s' % a.png_dir)

    pages[0].save(a.out, save_all=True, append_images=pages[1:],
                  resolution=150.0, quality=90)
    mb = os.path.getsize(a.out) / 1048576
    print('готово: %s (%d страниц, %.1f МБ)' % (a.out, len(pages), mb))
    # ChatPlace принимает документ до 20 МБ, и файл открывают с телефона.
    if mb > 15:
        print('ВНИМАНИЕ: больше 15 МБ, ChatPlace может не принять')


if __name__ == '__main__':
    main()
