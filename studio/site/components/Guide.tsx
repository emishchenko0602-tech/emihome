import Link from "next/link";

// Кирпичи гайда по канону. Гайд = шапка + связная проза + две инфографики +
// врезки + блок источников. Ничего из этого не выдумывается на ходу: скилл /гайд
// собирает страницу из этих компонентов.

export function GuideHero({
  title,
  excerpt,
  date,
  readMin,
  tag,
}: {
  title: string;
  excerpt: string;
  date: string;
  readMin: number;
  tag: string;
}) {
  return (
    <header className="max-w-prose mx-auto px-5 pt-14 pb-10">
      <div className="flex items-center gap-3 font-mono text-[12px] uppercase tracking-wider text-clay-subtle mb-5">
        <span className="text-terra">{tag}</span>
        <span>·</span>
        <span>{new Date(date).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</span>
        <span>·</span>
        <span>{readMin} мин</span>
      </div>
      <h1 className="font-serif text-[36px] md:text-[52px] font-bold leading-[1.05] mb-5">{title}</h1>
      <p className="font-body text-[19px] leading-relaxed text-clay-muted">{excerpt}</p>
    </header>
  );
}

// Инфографика. Файл кладётся в public/guides/<slug>/<имя>.png генератором
// scripts/guide-infographics.mjs — путь сюда приходит уже готовым.
export function Figure({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  return (
    <figure className="my-12">
      <img
        src={src}
        alt={alt}
        className="w-full rounded-xl border border-paper-line bg-paper-card"
        loading="lazy"
      />
      {caption ? (
        <figcaption className="mt-3 text-[13.5px] text-clay-subtle text-center">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

export function Callout({
  title,
  children,
  tone = "note",
}: {
  title?: string;
  children: React.ReactNode;
  tone?: "note" | "warn";
}) {
  const styles =
    tone === "warn"
      ? "bg-terra/8 border-terra/30"
      : "bg-paper-card border-paper-line";
  return (
    <aside className={`my-10 rounded-xl border ${styles} p-6`}>
      {title ? <div className="font-sans font-semibold text-[15px] mb-2">{title}</div> : null}
      <div className="font-body text-[16.5px] leading-relaxed text-clay-muted [&>p:last-child]:mb-0">
        {children}
      </div>
    </aside>
  );
}

// Источники — обязательный блок. Пустым не оставлять: если ссылок нет,
// значит гайд написан по памяти, а такой гайд не публикуется.
export function Sources({ items }: { items: { title: string; url: string; note?: string }[] }) {
  return (
    <section className="max-w-prose mx-auto px-5 mt-16 pt-8 border-t border-paper-line">
      <h2 className="font-sans text-[13px] uppercase tracking-wider text-clay-subtle mb-5">Источники</h2>
      <ol className="space-y-3 text-[15.5px]">
        {items.map((s, i) => (
          <li key={s.url} className="flex gap-3">
            <span className="font-mono text-[13px] text-clay-subtle pt-1">{String(i + 1).padStart(2, "0")}</span>
            <span>
              <a
                href={s.url}
                target="_blank"
                rel="noopener"
                className="text-terra underline underline-offset-2 decoration-terra/40 hover:decoration-terra"
              >
                {s.title}
              </a>
              {s.note ? <span className="text-clay-subtle"> — {s.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Мост в воронку: человек пишет кодовое слово в директ и получает продолжение.
export function KeywordCTA({ keyword, text, href }: { keyword: string; text: string; href: string }) {
  return (
    <section className="max-w-prose mx-auto px-5 my-14">
      <div className="rounded-xl bg-clay text-paper p-7">
        <div className="font-body text-[17px] leading-relaxed mb-5">{text}</div>
        <a
          href={href}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-2 bg-terra hover:bg-terra-hover text-white px-6 py-3 rounded-lg font-sans text-[14px] font-semibold transition-colors"
        >
          Написать «{keyword}» →
        </a>
      </div>
    </section>
  );
}

export function BackToGuides() {
  return (
    <div className="max-w-prose mx-auto px-5 mt-14">
      <Link href="/guides" className="font-mono text-[13px] text-clay-subtle hover:text-terra transition-colors">
        ← все гайды
      </Link>
    </div>
  );
}
