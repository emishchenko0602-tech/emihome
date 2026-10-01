#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
make-pdf.py — собирает лид-магнит в PDF из текстового файла.

Зачем свой сборщик: готовые генераторы тянут за собой либо браузер, либо
reportlab с его шрифтовой возней. Здесь страницы рисуются как изображения
и складываются в многостраничный PDF средствами PIL, который уже стоит.
Полный контроль над версткой и ни одной новой зависимости.

Формат входного файла: строки вида

    # Заголовок обложки
    ## Подзаголовок обложки
    1. Название пункта
    Текст пункта, одна или несколько строк
    ---
    Текст финальной страницы

Запуск:
  python scripts/make-pdf.py <текст.txt> --out <файл.pdf> --brand "LA POUF"
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1240, 1754          # A4 при 150 точках на дюйм
M = 110                    # поля
BG = (250, 248, 245)
INK = (28, 26, 24)
GREY = (108, 102, 96)
ACCENT = (176, 124, 92)


def font(name, size):
    for p in ('workspace/reels/fonts/%s.ttf' % name,
              'workspace/reels/fonts/Manrope-400.ttf'):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def wrap(draw, text, fnt, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=fnt) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def parse(path):
    title = sub = tail = ''
    items, cur = [], None
    mode = 'head'
    for raw in open(path, encoding='utf-8'):
        s = raw.rstrip('\n')
        if s.startswith('# '):
            title = s[2:].strip(); continue
        if s.startswith('## '):
            sub = s[3:].strip(); continue
        if s.strip() == '---':
            mode = 'tail'; continue
        if mode == 'tail':
            tail += s + '\n'; continue
        if s[:2].isdigit() or (s[:1].isdigit() and s[1:2] == '.'):
            if cur:
                items.append(cur)
            n, _, rest = s.partition('.')
            cur = {'n': n.strip(), 'head': rest.strip(), 'body': ''}
        elif s.strip() and cur:
            cur['body'] += (' ' if cur['body'] else '') + s.strip()
    if cur:
        items.append(cur)
    return title, sub, items, tail.strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('src')
    p.add_argument('--out', required=True)
    p.add_argument('--brand', default='')
    p.add_argument('--tagline', default='')
    p.add_argument('--per-page', type=int, default=2)
    p.add_argument('--png-dir', default=None,
                   help='куда сложить страницы картинками — вёрстку надо видеть')
    a = p.parse_args()

    if not os.path.exists(a.src):
        sys.exit('ОШИБКА: нет файла %s' % a.src)

    title, sub, items, tail = parse(a.src)
    if not items:
        sys.exit('ОШИБКА: не нашёл ни одного пункта')
    print('пунктов: %d' % len(items))

    f_title = font('Montserrat-900', 62)
    f_sub = font('Manrope-400', 30)
    f_num = font('Montserrat-900', 44)
    f_head = font('Montserrat-800', 38)
    f_body = font('Manrope-400', 30)
    f_brand = font('Montserrat-900', 34)
    f_small = font('Manrope-400', 24)

    pages = []

    # обложка
    page = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(page)
    y = 420
    for ln in wrap(d, title, f_title, W - M * 2):
        d.text((M, y), ln, font=f_title, fill=INK); y += 76
    if sub:
        y += 26
        for ln in wrap(d, sub, f_sub, W - M * 2):
            d.text((M, y), ln, font=f_sub, fill=GREY); y += 42
    d.line([(M, H - 240), (M + 120, H - 240)], fill=ACCENT, width=4)
    if a.brand:
        d.text((M, H - 200), a.brand, font=f_brand, fill=INK)
    if a.tagline:
        d.text((M, H - 150), a.tagline, font=f_small, fill=GREY)
    pages.append(page)

    # пункты
    x = M + 86
    gap = 76
    for i in range(0, len(items), a.per_page):
        page = Image.new('RGB', (W, H), BG)
        d = ImageDraw.Draw(page)

        # Сначала меряем, потом рисуем: пункты разной длины, и если просто
        # начинать от верхнего поля, на последней странице остаётся полстраницы
        # пустоты. Блок ставим по центру — тогда все страницы выглядят ровно.
        chunk = []
        total_h = 0
        for it in items[i:i + a.per_page]:
            hl = wrap(d, it['head'], f_head, W - M - x)
            bl = wrap(d, it['body'], f_body, W - M - x)
            h = len(hl) * 50 + 16 + len(bl) * 44
            chunk.append((it['n'], hl, bl))
            total_h += h + gap
        total_h -= gap

        y = max(M + 20, (H - total_h) // 2)
        for n, hl, bl in chunk:
            d.text((M, y), n, font=f_num, fill=ACCENT)
            hy = y
            for ln in hl:
                d.text((x, hy), ln, font=f_head, fill=INK); hy += 50
            by = hy + 16
            for ln in bl:
                d.text((x, by), ln, font=f_body, fill=(62, 58, 54)); by += 44
            y = by + gap
        if a.brand:
            d.text((W - M - d.textlength(a.brand, font=f_small), H - 70),
                   a.brand, font=f_small, fill=GREY)
        pages.append(page)

    # финальная страница
    if tail:
        page = Image.new('RGB', (W, H), BG)
        d = ImageDraw.Draw(page)
        y = 480
        for block in tail.split('\n'):
            if not block.strip():
                y += 26; continue
            fnt = f_head if block.strip().endswith('?') else f_body
            col = INK if fnt is f_head else (62, 58, 54)
            for ln in wrap(d, block.strip(), fnt, W - M * 2):
                d.text((M, y), ln, font=fnt, fill=col)
                y += 52 if fnt is f_head else 44
            y += 18
        d.line([(M, H - 240), (M + 120, H - 240)], fill=ACCENT, width=4)
        if a.brand:
            d.text((M, H - 200), a.brand, font=f_brand, fill=INK)
        if a.tagline:
            d.text((M, H - 150), a.tagline, font=f_small, fill=GREY)
        pages.append(page)

    if a.png_dir:
        os.makedirs(a.png_dir, exist_ok=True)
        for k, pg in enumerate(pages):
            pg.save(os.path.join(a.png_dir, 'p%02d.png' % (k + 1)))
        print('страницы картинками: %s' % a.png_dir)

    pages[0].save(a.out, save_all=True, append_images=pages[1:],
                  resolution=150.0, quality=92)
    print('готово: %s (%d страниц, %.1f МБ)' %
          (a.out, len(pages), os.path.getsize(a.out) / 1048576))
    # Лид-магнит открывают на телефоне: тяжёлый файл просто не станут ждать.
    if os.path.getsize(a.out) > 12 * 1024 * 1024:
        print('ВНИМАНИЕ: файл тяжёлый, с телефона будет грузиться долго')


if __name__ == '__main__':
    main()
