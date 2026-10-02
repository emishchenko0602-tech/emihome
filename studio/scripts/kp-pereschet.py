#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
kp-pereschet.py — пересчёт коммерческого предложения под другой объект.

Правит готовое КП студии прямо в её файле, сохраняя вёрстку, фотографии
и шрифты. Переписывать КП заново нельзя: оформление делал дизайнер,
и собранная с нуля копия будет выглядеть чужой.

Что умеет:
  - переписать обложку под новый объект и метраж;
  - пересчитать итоговые суммы в существующих пакетах;
  - добавить новые пакеты, скопировав страницу существующего;
  - погасить ненужные пункты списка, как это сделано в оригинале у Standart;
  - поменять контакты.

Шрифт берётся из самого файла: встроенный Montserrat Light извлекается
и используется для вставок, поэтому новый текст неотличим от старого.

Три правила, добытые на граблях:

1. Копировать страницы ДО правок. Иначе копия унаследует уже изменённые
   суммы, и пересчитывать придётся дважды.
2. Правки одной страницы собирать в пачку: сначала найти все места, потом
   забелить все разом, потом вставить новый текст. По одной нельзя —
   забеливание строки задевает соседнюю, если их прямоугольники касаются,
   и соседняя строка исчезает молча.
3. Страницы искать по содержимому, а не по номеру: после вставки новых
   страниц номера съезжают.

Фон страниц белый, поэтому старый текст убирается забелением. На цветной
подложке приём не сработает, и тогда нужен другой подход.

Запуск:
  python scripts/kp-pereschet.py <исходник.pdf> --out <новый.pdf> --area 70 \
      --object "дома из бруса в Воронеже," --site ... --email ...
"""

import argparse
import os
import sys

import pymupdf

INK = (0x22 / 255, 0x28 / 255, 0x31 / 255)


def extract_font(doc, out_path):
    """Достаёт из файла полный (не урезанный) Montserrat Light."""
    best = None
    for i in range(doc.page_count):
        for f in doc.get_page_fonts(i):
            xref, base = f[0], f[3]
            if 'Montserrat' in base and 'Light' in base:
                _, _, _, buf = doc.extract_font(xref)
                # Урезанные подшивки весят килобайты и содержат не все буквы,
                # поэтому берём самую большую: она полная.
                if best is None or len(buf) > len(best):
                    best = buf
    if best is None:
        sys.exit('ОШИБКА: в файле нет встроенного Montserrat Light')
    open(out_path, 'wb').write(best)
    return out_path


def page_with(doc, needle, start=0):
    """Номер первой страницы, где встречается строка."""
    for i in range(start, doc.page_count):
        if doc[i].search_for(needle):
            return i
    return None


def apply_edits(page, edits, font):
    """edits: список (старое, новое, кегль, цвет, сдвиг_x, сдвиг_y).

    Сначала ищем все прямоугольники, потом белим разом, потом пишем.
    Порядок важен: см. правило 2 в шапке файла.
    """
    found = []
    for e in edits:
        old = e[0]
        r = page.search_for(old)
        if not r:
            print('  ! не нашёл: %r' % old[:44])
            continue
        found.append((r[0], e))
    if not found:
        return 0
    for rect, _ in found:
        page.add_redact_annot(rect + (-1.0, 0.2, 2.0, -0.2), fill=(1, 1, 1))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
    for rect, (old, new, size, color, dx, dy) in found:
        if not new:
            continue
        page.insert_text((rect.x0 + dx, rect.y1 - size * 0.22 + dy), new,
                         fontname='ml', fontfile=font, fontsize=size, color=color)
    return len(found)


def clear(page, x0, y0, x1, y1):
    """Стирает область целиком. Нужно там, где меняется не строка,
    а весь пункт списка вместе с переносом."""
    page.add_redact_annot(pymupdf.Rect(x0, y0, x1, y1), fill=(1, 1, 1))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)


def block(page, rect, lines, size, color, leading, font, first_baseline):
    """Стирает блок и набирает его заново.

    Точечная замена строки в этой вёрстке не работает: строки стоят с
    интервалом меньше высоты своего прямоугольника, и забеливание одной
    съедает соседнюю. Блоком надёжнее и предсказуемее.
    """
    page.add_redact_annot(pymupdf.Rect(*rect), fill=(1, 1, 1))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
    y = first_baseline
    for ln in lines:
        if ln:
            page.insert_text((rect[0] + 5, y), ln, fontname='ml', fontfile=font,
                             fontsize=size, color=color)
        y += leading


def fade(page, x0, y0, x1, y1, strength=0.62):
    """Гасит пункты списка, как в оригинале у Standart.

    Не переписывает текст, а кладёт сверху белую полупрозрачную плашку.
    Так сохраняются переносы и отступы, которые при перенаборе разъехались бы.
    """
    page.draw_rect(pymupdf.Rect(x0, y0, x1, y1), color=None,
                   fill=(1, 1, 1), fill_opacity=strength)


def money(value):
    return '%s р.' % format(int(value), ',').replace(',', ' ')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('src')
    p.add_argument('--out', required=True)
    p.add_argument('--area', type=float, required=True, help='площадь объекта, кв.м')
    p.add_argument('--object', required=True, help='строка про объект на обложку')
    p.add_argument('--rate-concept', type=float, default=3500)
    p.add_argument('--plan-price', type=float, default=30000)
    p.add_argument('--site', default=None)
    p.add_argument('--email', default=None)
    p.add_argument('--png-dir', default=None)
    a = p.parse_args()

    if not os.path.exists(a.src):
        sys.exit('ОШИБКА: нет файла %s' % a.src)

    doc = pymupdf.open(a.src)
    font = extract_font(doc, os.path.join(os.path.dirname(a.out) or '.', '.kp-font.ttf'))
    print('страниц в исходнике: %d' % doc.page_count)

    i_prem = page_with(doc, '«Premium»')
    i_std = page_with(doc, '«Standart»')
    if i_prem is None or i_std is None:
        sys.exit('ОШИБКА: не нашёл страницы пакетов Premium и Standart')

    # Правило 1: копируем до правок.
    doc.fullcopy_page(i_std, to=i_std + 1)
    doc.fullcopy_page(i_std, to=i_std + 2)
    i_conc, i_plan = i_std + 1, i_std + 2
    print('новые страницы: %d и %d' % (i_conc + 1, i_plan + 1))

    # ---- обложка -------------------------------------------------------
    # Блоком: строки подзаголовка стоят с шагом 19 при высоте 23, и точечная
    # замена средней строки съедает верхнюю «На разработку дизайн-проекта».
    block(doc[0], (108, 345, 445, 416), [
        'На разработку дизайн-проекта',
        a.object,
        '%g кв.м.' % a.area,
    ], 18.0, (0, 0, 0), 19.7, font, 369.0)

    # ---- существующие пакеты -------------------------------------------
    apply_edits(doc[i_prem], [
        ('360 000 р.', money(4500 * a.area), 14.0, INK, 0, 0)], font)
    apply_edits(doc[i_std], [
        ('312 000 р.', money(3900 * a.area), 14.0, INK, 0, 0)], font)
    print('  Premium %s | Standart %s' % (money(4500 * a.area), money(3900 * a.area)))

    # ---- пакет «Концепция» ---------------------------------------------
    k = doc[i_conc]
    block(k, (90, 128, 345, 186), ['Дизайн-проект', '«Концепция»'],
          20.0, (0, 0, 0), 22, font, 155.6)
    block(k, (90, 200, 400, 292),
          ['Дизайн-проект с коллажами',
           'и мудбордами вместо 3D-',
           'визуализаций, с полными',
           'чертежами и упрощенными',
           'спецификациями'],
          14.0, INK, 15, font, 220.9)
    block(k, (88, 335, 480, 376),
          ['Расчетная стоимость дизайн-проекта',
           'под вашу задачу: %s р/кв.м.' % format(int(a.rate_concept), ',').replace(',', ' ')],
          14.0, INK, 15, font, 353.9)
    apply_edits(k, [('312 000 р.', money(a.rate_concept * a.area), 14.0, INK, 0, 0)], font)
    # Трёхмерной визуализации в этом пакете нет. Пункт занимает две строки
    # с переносом, поэтому стираем область целиком и пишем свой.
    clear(k, 528, 265, 845, 299)
    k.insert_text((531, 280), chr(0x2022), fontname='ml', fontfile=font, fontsize=11, color=(0, 0, 0))
    k.insert_text((544, 280), 'Коллажи и мудборды по каждой зоне',
                  fontname='ml', fontfile=font, fontsize=11, color=(0, 0, 0))
    print('  Концепция %s' % money(a.rate_concept * a.area))

    # ---- пакет «Планировка» --------------------------------------------
    k = doc[i_plan]
    block(k, (90, 128, 345, 186), ['Дизайн-проект', '«Планировка»'],
          20.0, (0, 0, 0), 22, font, 155.6)
    block(k, (90, 200, 400, 292),
          ['Планировочное решение:',
           'три варианта расстановки',
           'в 2D, замеры объекта',
           'и техническое задание'],
          14.0, INK, 15, font, 220.9)
    block(k, (88, 335, 480, 376),
          ['Стоимость планировочного решения',
           'за весь объект:'],
          14.0, INK, 15, font, 353.9)
    apply_edits(k, [('312 000 р.', money(a.plan_price), 14.0, INK, 0, 0)], font)
    # В пакет входят только обмеры и расстановка, остальное гасим.
    # Начало ровно по верху третьего пункта: на 108 плашка срезала бы
    # «План размещения мебели», а он в пакет входит.
    fade(k, 528, 111, 845, 445, strength=0.7)
    print('  Планировка %s' % money(a.plan_price))

    # ---- контакты -------------------------------------------------------
    # Блоком, а не построчно: строки стоят с шагом 13 при высоте 15,
    # и точечная замена съедает соседей. На этом я уже потерял телефон и VK.
    i_con = page_with(doc, 'Контакты:')
    if i_con is None:
        print('  ! страницу контактов не нашёл')
    else:
        block(doc[i_con], (90, 190, 400, 296), [
            'Tel: +7 (980) 539-96-18',
            'Tel: +7 (980) 346-87-15',
            'email: ' + (a.email or 'info@emihome.ru'),
            'web: ' + (a.site or 'https://emihome.ru'),
            'VK: https://vk.com/emi.home',
            'Inst: instagram.com/emi.home',
            'Telegram: https://t.me/emihome',
        ], 12.0, (0, 0, 0), 13, font, 208.4)
        print('  контакты пересобраны на стр.%d' % (i_con + 1))

    doc.save(a.out, garbage=3, deflate=True)
    print('готово: %s (%d страниц, %.1f МБ)'
          % (a.out, doc.page_count, os.path.getsize(a.out) / 1048576))

    if a.png_dir:
        os.makedirs(a.png_dir, exist_ok=True)
        d2 = pymupdf.open(a.out)
        for i in range(d2.page_count):
            d2[i].get_pixmap(dpi=90).save(os.path.join(a.png_dir, 'k%02d.png' % (i + 1)))
        print('страницы картинками: %s' % a.png_dir)


if __name__ == '__main__':
    main()
