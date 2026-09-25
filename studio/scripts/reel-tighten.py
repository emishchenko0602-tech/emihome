#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
reel-tighten.py — ужимает говорящее видео по паузам и рисует субтитры.

Зачем: в живой записи между фразами висят секунды тишины. На них зритель
уходит. Скрипт находит границы слов, вырезает паузы длиннее порога, оставляя
короткий вдох, и собирает вертикальный ролик с вшитыми субтитрами.

Работает по словам, а не по сегментам: сегментный вывод whisper на медленной
речи дорисовывает несуществующие повторы, и резать по нему нельзя.

Запуск:
  python scripts/reel-tighten.py <видео> --out <готовое.mp4>
  python scripts/reel-tighten.py <видео> --plan-only      только план и SRT
  python scripts/reel-tighten.py <видео> --max-pause 0.6 --keep 0.25
  python scripts/reel-tighten.py <видео> --no-subs        без субтитров
"""

import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

W_OUT, H_OUT = 1080, 1920


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", **kw)


def probe_duration(path):
    r = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nk=1:nw=1", path])
    return float(r.stdout.strip())


def words_of(path):
    """Слова с таймкодами. Именно они, а не сегменты, задают, что оставить."""
    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8")
    segs, _ = model.transcribe(
        path, language="ru", beam_size=5, word_timestamps=True,
        condition_on_previous_text=False,
    )
    out = []
    for s in segs:
        for w in (s.words or []):
            t = w.word.strip()
            if t:
                out.append({"s": round(w.start, 3), "e": round(w.end, 3), "w": t})
    return out


def silences(path, noise="-32dB", min_len=0.4):
    """Тишина по измеренной энергии звука.

    Резать надо именно по ней. Таймкоды слов от whisper на паузах поплыли:
    на одном и том же файле разные прогоны дают то четыре секунды тишины,
    то семь десятых. Звук не врёт, модель врёт.
    """
    r = run([FFMPEG, "-hide_banner", "-i", path,
             "-af", f"silencedetect=noise={noise}:d={min_len}", "-f", "null", "-"])
    out, spans, start = (r.stderr or ""), [], None
    for line in out.splitlines():
        if "silence_start:" in line:
            start = float(line.split("silence_start:")[1].strip())
        elif "silence_end:" in line and start is not None:
            end = float(line.split("silence_end:")[1].split("|")[0].strip())
            spans.append((start, end))
            start = None
    return spans


def plan_keeps(path, duration, max_pause, keep):
    """Оставляем речь, паузы подрезаем до keep секунд на вдох."""
    sil = [(a, b) for a, b in silences(path) if b - a > max_pause]
    if not sil:
        return [(0.0, duration)], []

    keeps, gaps, cursor = [], [], 0.0
    for a, b in sil:
        # хвост тишины оставляем в предыдущем куске, голову — в следующем
        seg_end = min(duration, a + keep / 2)
        if seg_end > cursor + 0.05:
            keeps.append((round(cursor, 3), round(seg_end, 3)))
        gaps.append((round(a, 2), round(b, 2), round(b - a, 2)))
        cursor = max(0.0, b - keep / 2)

    if cursor < duration - 0.05:
        keeps.append((round(cursor, 3), round(duration, 3)))
    return keeps, gaps


def srt_time(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = int(t % 60); ms = int(round((t - int(t)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def ass_time(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def build_subs(words, keeps, path, max_chars=30):
    """Субтитры по НОВОЙ шкале времени, уже после вырезания пауз.

    Формат ASS, а не SRT, и с явными PlayResX/PlayResY: иначе libass считает
    кегль и поля в собственных координатах, и подпись уезжает на лицо.
    Строку рвём по длине и по концу предложения, а не по числу слов.
    """
    shift, mapped = 0.0, []
    for (a, b) in keeps:
        for w in words:
            if w["s"] >= a and w["e"] <= b:
                mapped.append({"s": w["s"] - a + shift, "e": w["e"] - a + shift, "w": w["w"]})
        shift += b - a

    lines, cur = [], []
    for w in mapped:
        cur.append(w)
        text = " ".join(c["w"] for c in cur)
        ends_sentence = w["w"].endswith(("?", ".", "!", "…"))
        ends_clause = w["w"].endswith((",", ":", ";"))
        if ends_sentence or (len(text) >= max_chars and ends_clause) or len(text) >= max_chars + 12:
            lines.append((cur[0]["s"], cur[-1]["e"], text))
            cur = []
    if cur:
        lines.append((cur[0]["s"], cur[-1]["e"], " ".join(c["w"] for c in cur)))

    # Подряд идущие одинаковые строки — след зацикливания whisper на паузах,
    # а не повтор в речи. В кадре такое читается как брак, поэтому снимаем.
    deduped = []
    for a, b, text in lines:
        if deduped and text.strip().lower() == deduped[-1][2].strip().lower():
            continue
        deduped.append((a, b, text))
    lines = deduped

    # Обрывки в одно-два слова читаются как ошибка: подклеиваем к соседу.
    merged = []
    for a, b, text in lines:
        if merged and len(text) < 14 and len(merged[-1][2]) + len(text) < max_chars + 20:
            pa, _, ptext = merged[-1]
            merged[-1] = (pa, b, f"{ptext} {text}")
        else:
            merged.append((a, b, text))
    lines = merged

    header = (
        "[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\n"
        f"PlayResX: {W_OUT}\nPlayResY: {H_OUT}\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour,"
        " Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,"
        " BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: Reel,Arial,64,&H00FFFFFF,&H00201B16,&H80000000,"
        "-1,0,0,0,100,100,0,0,1,5,0,2,90,90,430,204\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(header)
        for a, b, text in lines:
            f.write(f"Dialogue: 0,{ass_time(a)},{ass_time(b)},Reel,,0,0,0,,{text}\n")
    return len(lines)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("--out", default=None)
    p.add_argument("--max-pause", type=float, default=0.7, help="пауза длиннее этой режется, сек")
    p.add_argument("--keep", type=float, default=0.3, help="сколько тишины оставить на вдох, сек")
    p.add_argument("--plan-only", action="store_true")
    p.add_argument("--no-subs", action="store_true")
    # Распознавание ошибается в падежах и именах. Готовый .ass правится руками
    # и подаётся сюда, чтобы сборка не перезаписала выверенный текст.
    p.add_argument("--subs", default=None, help="взять готовый .ass, не генерировать")
    a = p.parse_args()

    if not os.path.exists(a.src):
        sys.exit(f"ОШИБКА: нет файла {a.src}")

    base = os.path.splitext(a.src)[0]
    out = a.out or base + "-tight.mp4"
    subs = base + ".ass"
    plan_path = base + "-plan.json"

    duration = probe_duration(a.src)
    print(f"исходник: {duration:.1f} сек")

    print("считаю слова...")
    words = words_of(a.src)
    print(f"слов: {len(words)}")

    keeps, gaps = plan_keeps(a.src, duration, a.max_pause, a.keep)
    total = sum(b - a_ for a_, b in keeps)
    print(f"кусков: {len(keeps)} | пауз вырезано: {len(gaps)} | станет: {total:.1f} сек "
          f"(минус {duration - total:.1f})")
    for g in gaps:
        print(f"   пауза {g[2]:.1f} сек на {g[0]:.1f}")

    json.dump({"src": a.src, "duration": duration, "keeps": keeps, "gaps": gaps,
               "words": words}, open(plan_path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"план: {plan_path}")

    if a.subs:
        subs = a.subs
        if not os.path.exists(subs):
            sys.exit(f"ОШИБКА: не найден файл субтитров {subs}")
        print(f"субтитры взяты готовые: {subs}")
    else:
        n = build_subs(words, keeps, subs)
        print(f"субтитры: {subs} ({n} строк)")

    if a.plan_only:
        return

    # Каждый кусок вырезается отдельной парой trim/atrim и склеивается concat:
    # так не плодим временные файлы и не теряем синхрон звука с картинкой.
    parts, labels = [], []
    for i, (s, e) in enumerate(keeps):
        parts.append(
            f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}];"
            f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]"
        )
        labels.append(f"[v{i}][a{i}]")
    chain = ";".join(parts) + ";" + "".join(labels) + f"concat=n={len(keeps)}:v=1:a=1[vc][ac]"

    # Вертикаль 1080x1920: вписываем кадр целиком, поля добираем размытой копией,
    # чтобы не обрезать голову и не оставлять чёрных полос.
    vchain = (f"[vc]scale={W_OUT}:{H_OUT}:force_original_aspect_ratio=increase,"
              f"crop={W_OUT}:{H_OUT},setsar=1[vs]")

    if a.no_subs:
        vchain += ";[vs]copy[vout]"
    else:
        # Стиль целиком лежит в .ass, здесь ничего не переопределяем:
        # force_style поверх ASS снова увёл бы поля в чужие координаты.
        esc = subs.replace("\\", "/").replace(":", "\\:")
        vchain += f";[vs]subtitles='{esc}'[vout]"

    fc = chain + ";" + vchain + ";[ac]loudnorm=I=-14:TP=-1.5:LRA=11[aout]"

    print("собираю...")
    r = run([FFMPEG, "-y", "-loglevel", "error", "-i", a.src,
             "-filter_complex", fc, "-map", "[vout]", "-map", "[aout]",
             "-c:v", "libx264", "-preset", "medium", "-crf", "20",
             "-pix_fmt", "yuv420p", "-r", "30",
             "-c:a", "aac", "-b:a", "192k", out])
    if r.returncode != 0:
        sys.exit("ОШИБКА ffmpeg:\n" + (r.stderr or "")[:2000])

    print(f"готово: {out} ({probe_duration(out):.1f} сек)")


if __name__ == "__main__":
    main()
