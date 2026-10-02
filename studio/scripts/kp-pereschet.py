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


def split_line_at(page, x, baseline, parts, size, font):
    """Набирает пункт списка кусками разного цвета от точки x.

    В оригинале невходящие пункты не закрашены плашкой, а набраны светло-серым
    (e7e6e6), а входящие тёмным (0d0d0d). Чтобы часть строки оставить, а часть
    погасить, строку надо пересобрать из двух кусков.

    Стирание сюда не входит намеренно: прямоугольники соседних строк
    перекрываются, и чистить надо с запасом, переписывая соседей.
    """
    f = pymupdf.Font(fontfile=font)
    for text, color in parts:
        page.insert_text((x, baseline), text, fontname='ml', fontfile=font,
                         fontsize=size, color=color)
        x += f.text_length(text, fontsize=size)


def list_items(page):
    """Пункты правой колонки по порядку.

    Новый пункт начинается там, где стоит маркер, набранный Arial.
    Строки одного пункта склеиваются обратно в одну.
    """
    items, cur = [], None
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for sp in l['spans']:
                t = sp['text']
                if sp['bbox'][0] < 520:
                    continue
                # Начало пункта опознаём по колонке маркера, а не по шрифту:
                # в оригинале маркер набран Arial, а в перерисованном списке
                # тем же Montserrat, и проверка по шрифту переставала работать.
                if sp['bbox'][0] < 540:
                    if cur:
                        items.append(cur.strip())
                    cur = ''
                elif cur is not None:
                    # Пробел добавляем сами: при переносе строки его нет ни
                    # в конце первой части, ни в начале второй, и склейка
                    # давала «кслову» вместо «к слову».
                    cur += t + ' '
    if cur:
        items.append(cur.strip())
    return items


def draw_list(page, items, font, x_bullet=531, x_text=544, top=96.6, step=13.2,
              width=285, size=11, color=(0x0d / 255, 0x0d / 255, 0x0d / 255),
              pale=None):
    """Рисует правую колонку заново.

    Перерисовка целиком вместо точечных правок. Причина: прямоугольники
    соседних строк перекрываются, и стирание одного пункта уносит соседа,
    а расширение области уносит следующего. Цепочку надо обрывать.
    """
    f = pymupdf.Font(fontfile=font)
    y = top
    for item in items:
        words, lines, cur = item.split(), [], ''
        for w in words:
            t = (cur + ' ' + w).strip()
            if f.text_length(t, fontsize=size) <= width:
                cur = t
            else:
                lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)
        page.insert_text((x_bullet, y), chr(0x2022), fontname='ml', fontfile=font,
                         fontsize=size, color=color)
        for i, ln in enumerate(lines):
            col = color
            if pale and item in pale:
                head = pale[item]
                # Часть строки гасим: до head тёмным, дальше светлым.
                if head in ln:
                    k = ln.index(head)
                    page.insert_text((x_text, y), ln[:k], fontname='ml', fontfile=font,
                                     fontsize=size, color=color)
                    page.insert_text((x_text + f.text_length(ln[:k], fontsize=size), y),
                                     ln[k:], fontname='ml', fontfile=font, fontsize=size,
                                     color=(0xe7 / 255, 0xe6 / 255, 0xe6 / 255))
                    y += step
                    continue
            page.insert_text((x_text, y), ln, fontname='ml', fontfile=font,
                             fontsize=size, color=col)
            y += step
    return y


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
    p.add_argument('--term', default='2 месяца', help='срок разработки проекта')
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
    # «Концепция» делается из Premium: по наполнению она равна полному
    # пакету, отличается только тем, что вместо трёхмерных визуализаций
    # коллажи. Копия со Standart давала бы урезанные спецификации.
    doc.fullcopy_page(i_prem, to=i_std + 1)
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
          ['Полный дизайн-проект с',
           'коллажами и мудбордами',
           'вместо 3D-визуализаций,',
           'с полными чертежами',
           'и детальными спецификациями'],
          14.0, INK, 15, font, 220.9)
    block(k, (88, 335, 480, 376),
          ['Расчетная стоимость дизайн-проекта',
           'под вашу задачу: %s р/кв.м.' % format(int(a.rate_concept), ',').replace(',', ' ')],
          14.0, INK, 15, font, 353.9)
    apply_edits(k, [('360 000 р.', money(a.rate_concept * a.area), 14.0, INK, 0, 0)], font)
    # Список берём у Premium и перерисовываем целиком, заменив один пункт.
    # Точечные стирания здесь не работают: прямоугольники строк перекрываются,
    # и каждое расширение области уносило следующий пункт по цепочке.
    items = list_items(doc[i_prem])
    items = ['Коллажи и мудборды по каждой зоне' if '3D визуализация' in it else it
             for it in items]
    k.add_redact_annot(pymupdf.Rect(525, 78, 850, 455), fill=(1, 1, 1))
    k.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
    draw_list(k, items, font,
              pale={it: ' и мебели' for it in items if it.startswith('Смета по отделочным')})
    print('  Концепция %s (наполнение как в Premium)' % money(a.rate_concept * a.area))

    # Смета по отделочным материалам в Standart и Концепцию входит,
    # по мебели — нет. Стираем хвост списка целиком и набираем заново:
    # строка сметы перекрывается прямоугольником следующего пункта, и чистка
    # по её границам обрывает «Изготовление комплектов чертежей».
    DARK = (0x0d / 255, 0x0d / 255, 0x0d / 255)
    PALE = (0xe7 / 255, 0xe6 / 255, 0xe6 / 255)
    # Только Standart: на странице «Концепция» список перерисован целиком
    # функцией draw_list, и она уже гасит «и мебели» сама. Повторная правка
    # по жёстким координатам ломала бы свежую раскладку.
    for idx in (i_std,):
        pg = doc[idx]
        pg.add_redact_annot(pymupdf.Rect(543, 399, 806, 446), fill=(1, 1, 1))
        pg.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
        # Маркер пункта набран отдельным спаном и мог остаться бледным
        # от состояния, когда пункт был погашен целиком. Перекрываем тёмным.
        pg.insert_text((531, 412.9), chr(0x2022), fontname='ml', fontfile=font,
                       fontsize=11, color=DARK)
        split_line_at(pg, 544, 412.9,
                      [('Смета по отделочным материалам', DARK), (' и мебели', PALE)],
                      11.0, font)
        pg.insert_text((544, 425.9), 'Изготовление комплектов чертежей дизайн-',
                       fontname='ml', fontfile=font, fontsize=11, color=DARK)
        pg.insert_text((544, 438.9), 'проекта на бумажном носителе',
                       fontname='ml', fontfile=font, fontsize=11, color=DARK)
    print('  смета по отделке подсвечена в Standart')

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

    # ---- срок разработки ------------------------------------------------
    i_srok = page_with(doc, 'Срок разработки проекта')
    if i_srok is not None:
        block(doc[i_srok], (86, 379, 520, 404),
              ['Срок разработки проекта: %s' % a.term], 14.0, (0, 0, 0), 15, font, 397.9)
        print('  срок разработки: %s (стр.%d)' % (a.term, i_srok + 1))

    # ---- авторский надзор ----------------------------------------------
    # Екатерина: цену убрать, писать «обсуждается индивидуально».
    # Страницу оставляем: услуга есть, не названа только сумма.
    i_nadzor = page_with(doc, 'авторского надзора')
    if i_nadzor is not None:
        block(doc[i_nadzor], (92, 394, 520, 420),
              ['Стоимость авторского надзора: обсуждается индивидуально'],
              14.0, (0, 0, 0), 15, font, 413.9)
        print('  авторский надзор: цена убрана, стр.%d' % (i_nadzor + 1))

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

    # Проверка, а не доверие: список «Концепции» обязан повторять Premium,
    # кроме пункта про визуализации. Сверяем пункты целиком, а не строки:
    # перенос слова в разных раскладках встаёт по-разному, и построчное
    # сравнение давало ложную тревогу.
    def norm(x):
        return ' '.join(x.replace('-', ' ').split()).rstrip('.').lower()

    was = {norm(x) for x in list_items(doc[i_prem])}
    now = {norm(x) for x in list_items(doc[i_conc])}
    lost = {x for x in was - now if '3d визуализация' not in x}
    if lost:
        print('  ВНИМАНИЕ: в Концепции не хватает пунктов Premium:')
        for x in sorted(lost):
            print('    - %s' % x)
    else:
        print('  проверка: список Концепции повторяет Premium, %d пунктов' % len(now))

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
