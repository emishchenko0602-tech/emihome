#!/usr/bin/env python3
"""Линтер AI-слопа для антиклише-фильтра MassMedia Studio.

Проверяет ЧИСТОВОЙ текст, который идёт в публикацию: подпись, гайд, сценарий,
письмо, сообщение бота. Не проверяет черновики, цитаты «как было» и чужие тексты
внутри разбора.

    python lint.py caption.txt
    python lint.py < caption.txt
    python lint.py guide.md --allow-dots     # лонгрид: концевые точки разрешены
    python lint.py --self-test

СТОП   жёсткие запреты и следы копипаста из чат-бота. Пока есть хоть один,
       текст не публикуем (выход 1).
ЗАМЕТКА мягкие маркеры. Один ничего не значит, три в одном абзаце значат много.

Итог: стоп*3 + заметки -> чисто (0-3) / посмотреть (4-10) / переписать (11+).
"""
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:  # python < 3.7
    pass

# Куски, которые не проза: код, инлайн-код, ссылки, пути.
CODE = re.compile(r"```.*?```|`[^`\n]+`", re.S)
NOT_PROSE = re.compile(r"```.*?```|`[^`\n]+`|https?://\S+|[A-Za-z0-9_./\\-]+\.(?:mjs|py|json|md|html|css|jpg|png|mp4)", re.S)

# --- следы копипаста из чат-бота: сами по себе не появляются ---------------
TRACES = [
    ("сноска oaicite", re.compile(r":contentReference\[oaicite:\d+\]|oai_citation:\d+|\boaicite:\d+")),
    ("метка веб-поиска", re.compile(r"\bturn\d+(?:search|file|fetch|image|news|video|ref)\d+|citeturn")),
    ("хвост utm чат-бота", re.compile(r"utm_source=(?:chatgpt|copilot|perplexity)\.com|referrer=grok\.com")),
    ("цитата gemini", re.compile(r"\[cite_start\]|\[cite:\s*\d+|\[span_\d+\]|vertexaisearch\S*grounding-api-redirect")),
    ("служебная сноска", re.compile(r"【\d+†[^】]*】|\]\(sandbox:/mnt/data/")),
    ("остаток рассуждений", re.compile(r"</?think>|</?antml:")),
    ("незаполненная заглушка", re.compile(r"INSERT_\w+|PASTE_\w+|\bURL_HERE\b|\[вставить[^\]]*\]|\b20\d\d-XX-XX\b")),
    ("невидимый символ", re.compile(r"[-​‌⁠﻿]")),
]

# --- жёсткие запреты -------------------------------------------------------
DASH = re.compile(r"[—–]")
MATH = re.compile(r"[≈≥≤≠±⇒→←]|\s[=><]\s|\bvs\.?\s")
HR = re.compile(r"^\s*(-{3,}|\*{3,}|_{3,})\s*$")
# «не просто X, а Y» / «это не X, это Y» / «не только X, но Y»
NEGPAR = re.compile(
    r"[Нн]е только\b[^.!?\n]{1,80}?\b(?:но|а)\s+\S"
    r"|[Нн]е просто (?!так\b)[^.!?\n]{1,80}?(?:,\s*(?:а|но)\s+\S|(?:[,:]|\s[-—–]+)\s*это\s+\S)"
    r"|[Нн]е просто (?!так\b)[^.!?\n]{1,60}[.!?]\s+Это\s+\S"
    r"|[Ээ]то не [^.!?\n]{1,50}?,\s*это\s+\S")
# «Без кода. Без настроек.» / «Ноль рекламы. Ноль воронок.»
DRAMA = re.compile(r"\b(?:Без|Ноль|Никаких|Zero|No)\s[^.!?\n]{1,35}[.!]\s+(?:Без|Ноль|Никаких|Zero|No)\s")

# --- мягкие маркеры --------------------------------------------------------
MARKERS = {
    "канцелярит": [
        "в современном мире", "на сегодняшний день", "в настоящее время",
        "представляет собой", "выступает в роли", "служит основой",
        "является неотъемлемой", "данный подход", "осуществлять", "ключевым моментом",
        "необходимо учитывать", "в целях", "с целью",
    ],
    "затычка": [
        "важно отметить", "важно понимать", "стоит отметить", "следует подчеркнуть",
        "стоит обратить внимание", "нельзя не упомянуть", "как известно",
        "не секрет, что", "давайте разберёмся", "давайте разберемся",
        "а теперь самое", "но это ещё не всё", "как вы уже догадались",
    ],
    "ложная глубина": [
        "по сути", "в конечном счёте", "если копнуть глубже", "настоящий вопрос",
        "все упускают", "большинство упускает", "никто не расскажет",
        "никто не говорит о", "главная ошибка большинства", "секрет в том",
        "вот в чём магия", "это меняет всё",
    ],
    "фальшивая близость": [
        "знакомо?", "узнаёте себя", "звучит знакомо", "представьте себе",
        "готовы узнать", "скажу прямо", "давайте начистоту", "вот в чём штука",
        "если по-честному", "честно?",
    ],
    "терапевт": [
        "и это нормально", "и это окей", "вы не одиноки", "давайте признаем",
        "позвольте себе", "это абсолютно естественно",
    ],
    "подобострастие": [
        "отличный вопрос", "вы совершенно правы", "замечательное наблюдение",
        "надеюсь, это поможет", "надеюсь, было полезно", "буду рад помочь",
        "дайте знать, если",
    ],
    "дутая энергия": ["спойлер:", "plot twist", "лайфхак:", "бонус:", "внимание, сейчас"],
    "размытая ссылка": [
        "по мнению экспертов", "аналитики отмечают", "исследователи утверждают",
        "многие считают", "существует мнение",
    ],
    "пустой глагол": [
        "прокачивай", "прокачать навык", "создавай ценность", "создать ценность",
        "работай над собой", "будь собой", "двигайся к цели", "строй систему",
        "делай ценный контент",
    ],
    "рекламный": [
        "революционн", "уникальн", "мощный инструмент", "передов", "инновацион",
        "не имеет аналогов", "меняет правила игры", "game-changer",
    ],
    "финал-пересказ": [
        "подводя итог", "в заключение", "резюмируя", "таким образом, можно",
        "будущее выглядит", "впереди захватывающ", "продолжает процветать",
    ],
    "догадка вместо факта": [
        "широко не задокументирован", "предположительно", "судя по всему",
        "информация ограничена",
    ],
    "стопка абзацев": ["кроме того", "более того", "также стоит", "ещё один аспект", "ещё одним"],
    "калька": [
        "адресовать проблему", "доставить ценность", "встретить дедлайн",
        "имплементировать", "экспертиза команды",
    ],
    "английский телл": [
        "delve", "leverage", "unlock", "unleash", "seamless", "robust", "holistic",
        "let's dive in", "in a world where", "game changer", "move the needle",
    ],
}
SOFTENERS = ("возможно", "вероятно", "по-видимому", "как правило", "скорее всего",
             "в некоторых случаях", "в большинстве случаев", "обычно", "потенциально")
COLON_HOOK = re.compile(
    r"(?:[Сс]амое (?:интересное|главное|важное)|[Лл]учшая часть|[Фф]ишка в том|[Гг]лавная деталь)\s*:")
EMOJI = re.compile(r"[\U0001F300-\U0001FAFF☀-➿]")
BOLD = re.compile(r"\*\*[^*\n]+\*\*")
VERB_TAIL = re.compile(r"(ует|яет|ает|еет|ит|ат|ят|ют|ал|ял|ил|ел|ся|сь|ть)$")
SERVICE = re.compile(r"^\s*(#|\||>|\d+\.\s|[-*+]\s)")


def blocks(lines):
    """Абзацы: списки подряд идущих непустых прозаических строк."""
    cur, out = [], []
    for i, line in enumerate(lines, 1):
        if line.strip():
            cur.append((i, line))
        elif cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def sentences(lines):
    prose = " ".join(l for l in lines if l.strip() and not SERVICE.match(l))
    prose = re.sub(r"\*\*|«|»", "", prose)
    return [s.strip() for s in re.split(r"(?<=[.!?…])\s+", prose) if s.strip()]


def stems(sentence):
    found = set()
    for w in re.findall(r"[а-яё]{5,}", sentence.lower()):
        if VERB_TAIL.search(w):
            found.add(VERB_TAIL.sub("", w)[:6])
    return {s for s in found if len(s) >= 4}


def blank(match):
    return "\n" * match.group(0).count("\n")


def lint(text, allow_dots=False):
    found = []          # (уровень, строка, правило, кусок)
    text = text.lstrip("﻿")

    # следы копипаста ищем по сырому тексту: ссылки тут нужны, бэктики нет
    raw = CODE.sub(blank, text)
    for n, line in enumerate(raw.splitlines(), 1):
        for rule, rx in TRACES:
            m = rx.search(line)
            if m:
                found.append(("СТОП", n, rule, line[max(0, m.start() - 25):m.end() + 25].strip()))

    clean = NOT_PROSE.sub(blank, text)
    lines = clean.splitlines()

    for n, line in enumerate(lines, 1):
        if HR.match(line):
            found.append(("СТОП", n, "разделитель в теле текста", line.strip()[:40]))
            continue
        scan = re.sub(r"^\s*[>+*-]\s", "  ", line)
        for rule, rx in (("длинное тире", DASH), ("знак вместо слова", MATH),
                         ("«не просто X, а Y»", NEGPAR), ("рубленый пафос", DRAMA)):
            m = rx.search(scan)
            if m:
                found.append(("СТОП", n, rule, scan[max(0, m.start() - 25):m.end() + 25].strip()))
        low = scan.lower()
        for group, phrases in MARKERS.items():
            for p in phrases:
                if p in low:
                    found.append(("ЗАМЕТКА", n, group, p))
                    break
        if EMOJI.search(scan):
            found.append(("ЗАМЕТКА", n, "эмодзи", scan.strip()[:60]))
        if COLON_HOOK.search(scan):
            found.append(("ЗАМЕТКА", n, "двоеточие-подводка", scan.strip()[:60]))

    # концевые точки абзацев: подпись голоса, в лонгриде снимается флагом
    if not allow_dots:
        for block in blocks(lines):
            n, line = block[-1]
            if SERVICE.match(line) or HR.match(line):
                continue
            if line.rstrip().endswith(".") and not line.rstrip().endswith(".."):
                found.append(("СТОП", n, "точка в конце абзаца", line.strip()[-45:]))

    sents = sentences(lines)
    lengths = [len(s.split()) for s in sents]

    # рубка точками: три коротких подряд
    for i in range(len(sents) - 2):
        if all(lengths[i + k] <= 2 for k in range(3)):
            found.append(("СТОП", 0, "рубка точками", " ".join(sents[i:i + 3])[:60]))

    # хлопок-эмфаза: короткий довесок после длинного предложения
    for i in range(1, len(sents)):
        if lengths[i] <= 3 and lengths[i - 1] >= 10 and not sents[i].endswith(("?", ":")):
            found.append(("ЗАМЕТКА", 0, "хлопок-эмфаза", f"…{sents[i - 1][-35:]} {sents[i]}"))

    # каскад смягчений
    for s in sents:
        low = s.lower()
        hits = sum(low.count(w) for w in SOFTENERS)
        if hits >= 3:
            found.append(("ЗАМЕТКА", 0, "каскад смягчений", s[:60]))

    # один глагол в соседних предложениях
    for a, b in zip(sents, sents[1:]):
        common = stems(a) & stems(b)
        if common:
            found.append(("ЗАМЕТКА", 0, "повтор глагола", f"«{sorted(common)[0]}…» дважды подряд: {b[:45]}"))

    # ритм
    if len(lengths) >= 8:
        diffs = [abs(x - y) for x, y in zip(lengths, lengths[1:])]
        mean = sum(diffs) / len(diffs)
        if mean < 4:
            found.append(("ЗАМЕТКА", 0, "ритм ровный",
                          f"соседние предложения различаются на {mean:.1f} слова, у живого текста 6+"))
        if len(lengths) >= 10 and not any(l <= 8 for l in lengths):
            found.append(("ЗАМЕТКА", 0, "нет коротких фраз", "ни одного предложения до 8 слов"))

    total = sum(lengths)
    bold = len(BOLD.findall(text))
    if total >= 200 and bold > total / 200 + 1:
        found.append(("ЗАМЕТКА", 0, "жирный перебор", f"{bold} выделений на {total} слов"))

    return found


def verdict(stops, notes):
    score = stops * 3 + notes
    if score <= 3:
        return score, "чисто"
    if score <= 10:
        return score, "посмотреть: заметки смотреть кластерами, одиночные не считаются"
    return score, "переписать: точечной правкой не спасти"


def self_test():
    bad = ("Это не просто курс — это экосистема. Скорость > идеальности. "
           "Без кода. Без настроек. Итог ≈ 5 часов.")
    rules = [f[2] for f in lint(bad) if f[0] == "СТОП"]
    assert any("тире" in r for r in rules), rules
    assert any("не просто" in r for r in rules), rules
    assert any("знак" in r for r in rules), rules
    assert any("пафос" in r for r in rules), rules

    ok = "Обычный текст без слопа, с коротким дефисом - вот так\nЦифры 12 и 87 на месте"
    assert not [f for f in lint(ok) if f[0] == "СТОП"], lint(ok)

    dots = "Первый абзац про дело.\n\nВторой абзац тоже про дело"
    assert any("точка в конце" in f[2] for f in lint(dots)), lint(dots)
    assert not [f for f in lint(dots, allow_dots=True) if "точка в конце" in f[2]]

    chop = "Написал. Перечитал. Не то"
    assert any("рубка" in f[2] for f in lint(chop)), lint(chop)

    slap = "Берут полторы тысячи долларов за то, что площадка отдаёт любому желающему даром. Бесплатно"
    assert any("хлопок" in f[2] for f in lint(slap)), lint(slap)

    trace = "Рынок вырос :contentReference[oaicite:0]{index=0}, см. turn0search3 и https://x.ru/?utm_source=chatgpt.com"
    rules = [f[2] for f in lint(trace) if f[0] == "СТОП"]
    assert any("oaicite" in r for r in rules), rules
    assert any("веб-поиска" in r for r in rules), rules
    assert any("utm" in r for r in rules), rules

    quoted = "Статья разбирает метки `turn0search0` как признак генерации"
    assert not [f for f in lint(quoted) if f[0] == "СТОП"], lint(quoted)

    verbs = ("Сбербанк предлагает клиентам проверять адрес перевода внимательно. "
             "Тинькофф предлагает подтверждать каждую операцию кодом")
    assert any("повтор глагола" in f[2] for f in lint(verbs)), lint(verbs)

    soft = "Возможно, в некоторых случаях это, скорее всего, сработает"
    assert any("каскад" in f[2] for f in lint(soft)), lint(soft)

    mono = " ".join(["Это предложение содержит ровно семь слов подряд."] * 12)
    assert any("ритм" in f[2] for f in lint(mono)), lint(mono)

    print("self-test: OK")


def main():
    argv = sys.argv[1:]
    if "--self-test" in argv:
        return self_test()
    allow_dots = "--allow-dots" in argv
    files = [a for a in argv if not a.startswith("-")]
    text = open(files[0], encoding="utf-8").read() if files else sys.stdin.read()

    found = lint(text, allow_dots=allow_dots)
    stops = [f for f in found if f[0] == "СТОП"]
    notes = [f for f in found if f[0] == "ЗАМЕТКА"]
    for level, n, rule, ctx in found:
        where = f"строка {n}" if n else "текст"
        print(f"{level} {where}: [{rule}] {ctx}")
    score, v = verdict(len(stops), len(notes))
    print(f"\nитого: {len(stops)} стоп, {len(notes)} заметок, вес {score} -> {v}")
    if stops:
        print("публиковать нельзя: чини стопы и гоняй снова")
        sys.exit(1)
    print("жёстких запретов нет")


if __name__ == "__main__":
    main()
