#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
photo-slide.py — собирает слайд карусели из настоящей фотографии.

Зачем отдельно от движка генерации: реальный объект нейросети отдавать нельзя,
она его перерисует. Здесь фотография ложится как есть, пиксель в пиксель,
а подпись и знак встают по сетке.

Два режима подгонки под формат 4:5:
  fill   — кадр заполняет слайд целиком, лишнее срезается (для вертикальных фото);
  fit    — кадр целиком на фирменном фоне, сверху и снизу поля (для горизонтальных).

Запуск:
  python scripts/photo-slide.py <фото> <выход.png> --caption "текст" [--mode fill|fit]
"""

import argparse
import io
import os
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 1122, 1402                      # формат слайдов карусели
PAPER = (245, 240, 232)                # топлёное молоко
INK = (46, 39, 33)
MUTED = (107, 96, 88)
TERRA = (181, 98, 60)

FONT_SERIF = r"C:\Windows\Fonts\georgia.ttf"
FONT_SERIF_BOLD = r"C:\Windows\Fonts\georgiab.ttf"
FONT_SANS = r"C:\Windows\Fonts\arial.ttf"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(ROOT, "workspace", "assets", "photos", "brand", "logo-trim.png")


def brand_handle():
    """Хэндл берём из брендбука, а не из кода: он меняется, и зашитая строка
    однажды уже увела все слайды на чужой аккаунт."""
    try:
        import json
        with io.open(os.path.join(ROOT, "scripts", ".f2-brand.json"), encoding="utf-8") as f:
            return json.load(f).get("handle", "")
    except Exception:
        return ""


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def wrap(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def stamp_logo(canvas):
    """Знак слева внизу и хэндл справа — той же сеткой, что у brand-stamp.mjs."""
    if not os.path.exists(LOGO):
        return
    logo = Image.open(LOGO).convert("RGBA")
    lh = int(H * 0.035)
    lw = max(1, int(logo.width * lh / logo.height))
    logo = logo.resize((lw, lh), Image.LANCZOS)

    mx, my = int(W * 0.07), int(H * 0.045)
    canvas.alpha_composite(logo, (mx, H - lh - my))

    d = ImageDraw.Draw(canvas)
    handle = brand_handle()
    if not handle:
        return
    f = load_font(FONT_SERIF, int(H * 0.019))
    tw = d.textlength(handle, font=f)
    d.text((W - tw - mx, H - my - int(lh * 0.62)), handle, font=f, fill=MUTED)


def build(src, out, caption, mode):
    if not os.path.exists(src):
        sys.exit(f"ОШИБКА: не найдено фото {src}")

    photo = Image.open(src).convert("RGB")
    canvas = Image.new("RGBA", (W, H), PAPER + (255,))

    # Высоту нижней полосы считаем по фактическому числу строк подписи, а не
    # берём константой: на двух строках текст наезжал на знак в углу.
    pad = int(W * 0.07)
    probe = ImageDraw.Draw(canvas)
    fc_probe = load_font(FONT_SERIF_BOLD, int(H * 0.034))
    n_lines = max(1, len(wrap(probe, caption, fc_probe, W - pad * 2)))

    # кикер + строки подписи + воздух над знаком, который стоит на 4.5% снизу
    band_h = int(H * 0.055) + n_lines * int(H * 0.042) + int(H * 0.105)
    if mode == "fit":
        band_h = max(band_h, int(H * 0.155))

    if mode == "fill":
        area_h = H - band_h
        scale = max(W / photo.width, area_h / photo.height)
        nw, nh = int(photo.width * scale), int(photo.height * scale)
        photo = photo.resize((nw, nh), Image.LANCZOS)
        # кадрируем по центру по ширине и ближе к низу по высоте: внизу пол и трап,
        # ради которых слайд и существует
        left = (nw - W) // 2
        top = int((nh - area_h) * 0.62)
        photo = photo.crop((left, top, left + W, top + area_h))
        canvas.paste(photo, (0, 0))
        text_top = area_h + int(H * 0.035)
    else:
        side = int(W * 0.06)
        avail_w = W - side * 2
        avail_h = H - band_h - int(H * 0.10)
        scale = min(avail_w / photo.width, avail_h / photo.height)
        nw, nh = int(photo.width * scale), int(photo.height * scale)
        photo = photo.resize((nw, nh), Image.LANCZOS)
        x = (W - nw) // 2
        y = int(H * 0.085)
        canvas.paste(photo, (x, y))
        text_top = y + nh + int(H * 0.045)

    d = ImageDraw.Draw(canvas)

    kicker = "НАШ ПРОЕКТ"
    fk = load_font(FONT_SANS, int(H * 0.0155))
    d.text((pad, text_top), " ".join(kicker), font=fk, fill=TERRA)

    fc = load_font(FONT_SERIF_BOLD, int(H * 0.034))
    y = text_top + int(H * 0.036)
    for line in wrap(d, caption, fc, W - pad * 2):
        d.text((pad, y), line, font=fc, fill=INK)
        y += int(H * 0.042)

    stamp_logo(canvas)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    canvas.convert("RGB").save(out, quality=95)
    print(f"готово: {out}  ({mode})")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("out")
    p.add_argument("--caption", required=True)
    p.add_argument("--mode", choices=["fill", "fit"], default="fill")
    a = p.parse_args()
    build(a.src, a.out, a.caption, a.mode)
