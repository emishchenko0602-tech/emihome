#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
transcribe.py — расшифровка речи через faster-whisper. Один скрипт на две задачи:

  1. сверка звука готового ролика  → сегменты с таймкодами + сплошной текст;
  2. нарезка и субтитры            → пословные таймкоды (--words).

Пути НЕ зашиты: всё приходит аргументами (старый reel-transcribe.py держал их
внутри файла и отрабатывал вхолостую с кодом 0 — грабля прогона 06.08).

Использование:
    python scripts/transcribe.py <файл> [ещё файлы...] [опции]

Опции:
    --words             пословный вывод [{w,s,e}] вместо сегментов
    --lang ru|en|auto   язык речи (по умолчанию ru)
    --model NAME        модель: tiny|base|small|medium|large-v3 (по умолчанию small)
    --out PATH          куда писать JSON (по умолчанию рядом с первым файлом)
    --txt               дополнительно положить .txt со сплошным текстом
    --offsets 0,10,20   сдвиги времени по файлам вручную
    --no-chain          не сшивать времена: каждый файл считается со своего нуля
    --print-only        ничего не писать на диск, только вывод в консоль

Несколько файлов по умолчанию сшиваются в одну шкалу: сдвиг каждого следующего =
сумма длительностей предыдущих (ffprobe). Это случай «части одного ролика».

Требуется: ffmpeg/ffprobe в PATH (или переменная FFMPEG), pip install faster-whisper.
"""

import json
import os
import subprocess
import sys
import tempfile

# Вывод питона на этой машине уходит в cp1251 и читается кашей при перенаправлении
# в файл — жёстко переводим на utf-8 (грабля этапа 11 прогона 06.08).
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except AttributeError:
    pass

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
# Путь вида D:/tools/ffmpeg/bin/ffmpeg содержит «ffmpeg» дважды — меняем только имя файла.
_dir, _name = os.path.split(FFMPEG)
FFPROBE = os.path.join(_dir, _name.replace("ffmpeg", "ffprobe")) if _dir else _name.replace("ffmpeg", "ffprobe")


def die(msg):
    print(f"ОШИБКА: {msg}", file=sys.stderr)
    sys.exit(1)


def parse_args(argv):
    opts = {
        "files": [],
        "words": False,
        "lang": "ru",
        "model": "small",
        "out": None,
        "txt": False,
        "offsets": None,
        "chain": True,
        "print_only": False,
    }
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--words":
            opts["words"] = True
        elif a == "--txt":
            opts["txt"] = True
        elif a == "--no-chain":
            opts["chain"] = False
        elif a == "--print-only":
            opts["print_only"] = True
        elif a in ("--lang", "--model", "--out", "--offsets"):
            i += 1
            if i >= len(argv):
                die(f"у {a} нет значения")
            key = a[2:]
            opts[key] = argv[i]
        elif a.startswith("--"):
            die(f"неизвестная опция {a}")
        else:
            opts["files"].append(a)
        i += 1
    if not opts["files"]:
        print(__doc__)
        sys.exit(1)
    for f in opts["files"]:
        if not os.path.isfile(f):
            die(f"файл не найден: {f}")
    if opts["offsets"]:
        try:
            opts["offsets"] = [float(x) for x in opts["offsets"].split(",")]
        except ValueError:
            die("--offsets: ожидаются числа через запятую, например 0,10.1,20.4")
        if len(opts["offsets"]) != len(opts["files"]):
            die(f"--offsets: {len(opts['offsets'])} значений на {len(opts['files'])} файлов")
    return opts


def duration(path):
    res = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        die(f"ffprobe не смог прочитать {path}: {res.stderr.strip()[:200]}")
    try:
        return float(res.stdout.strip())
    except ValueError:
        die(f"ffprobe вернул не длительность для {path}: {res.stdout.strip()[:80]}")


def to_wav(src, dst):
    res = subprocess.run(
        [FFMPEG, "-y", "-i", src, "-vn", "-ar", "16000", "-ac", "1", dst, "-loglevel", "error"],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        die(f"ffmpeg не извлёк звук из {src}: {res.stderr.strip()[:300]}")
    if not os.path.isfile(dst) or os.path.getsize(dst) == 0:
        die(f"в {src} нет звуковой дорожки")


def main():
    o = parse_args(sys.argv[1:])

    # --- сдвиги по файлам ---
    if o["offsets"] is not None:
        offsets = o["offsets"]
    elif o["chain"] and len(o["files"]) > 1:
        offsets, acc = [], 0.0
        for f in o["files"]:
            offsets.append(round(acc, 3))
            acc += duration(f)
    else:
        offsets = [0.0] * len(o["files"])

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        die("не установлен faster-whisper — выполните: pip install faster-whisper")

    # Фильтр тишины (VAD) тянет onnxruntime, а тот — Visual C++ Runtime.
    # Там, где его нет (а прав администратора на установку может не быть),
    # импорт валится с ImportError о DLL. Распознавание работает и без VAD,
    # просто обсчитывает паузы наравне с речью. Молча падать из-за этого нельзя.
    try:
        import onnxruntime  # noqa: F401
        use_vad = True
    except Exception as e:
        use_vad = False
        print(f"фильтр тишины отключён (onnxruntime недоступен: {type(e).__name__})")

    print(f"модель {o['model']}, язык {o['lang']}, файлов {len(o['files'])}")
    model = WhisperModel(o["model"], device="cpu", compute_type="int8")

    words, segments, full_text = [], [], []
    tmpdir = tempfile.mkdtemp(prefix="transcribe-")
    try:
        for idx, (path, off) in enumerate(zip(o["files"], offsets), start=1):
            wav = os.path.join(tmpdir, f"part{idx}.wav")
            to_wav(path, wav)
            segs, _info = model.transcribe(
                wav,
                language=None if o["lang"] == "auto" else o["lang"],
                word_timestamps=o["words"],
                vad_filter=use_vad,
                beam_size=5,
                # Без этого модель опирается на уже распознанный текст и на
                # медленной речи с паузами зацикливается: одна и та же фраза
                # попадает в расшифровку дважды подряд. В субтитрах это видно
                # сразу, а в фактах приводит к выдуманным «повторам» автора.
                condition_on_previous_text=False,
            )
            part_words, part_text = [], []
            for s in segs:
                part_text.append(s.text)
                segments.append({
                    "s": round(s.start + off, 3),
                    "e": round(s.end + off, 3),
                    "text": s.text.strip(),
                    "src": os.path.basename(path),
                })
                for w in (s.words or []):
                    part_words.append({"w": w.word.strip(), "s": round(w.start + off, 3), "e": round(w.end + off, 3)})
            words += part_words
            text = " ".join(t.strip() for t in part_text).strip()
            full_text.append(text)
            head = f"[{idx}/{len(o['files'])}] {os.path.basename(path)} (+{off:g}с)"
            if o["words"]:
                print(f"{head}: {len(part_words)} слов | {text[:110]}")
            else:
                print(f"{head}: {text[:140]}")
    finally:
        for f in os.listdir(tmpdir):
            os.remove(os.path.join(tmpdir, f))
        os.rmdir(tmpdir)

    if o["words"] and not words:
        print("ВНИМАНИЕ: речь не распознана — ни одного слова", file=sys.stderr)

    text_all = " ".join(t for t in full_text if t).strip()

    if o["print_only"]:
        print("\n" + text_all)
        return

    base, _ = os.path.splitext(o["files"][0])
    out = o["out"] or (base + ("-words.json" if o["words"] else "-transcript.json"))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    if o["words"]:
        payload = words  # плоский список [{w,s,e}] — формат, который читают движки субтитров
    else:
        payload = {"lang": o["lang"], "sources": [os.path.basename(f) for f in o["files"]],
                   "text": text_all, "segments": segments}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"записано: {out} ({len(words) if o['words'] else len(segments)} записей)")

    if o["txt"]:
        txt_path = os.path.splitext(out)[0] + ".txt"
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(text_all + "\n")
        print(f"записано: {txt_path}")


if __name__ == "__main__":
    main()
