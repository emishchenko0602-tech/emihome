import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { guides } from "@/lib/guides";
import site from "@/site.config.json";

export default function Home() {
  const latest = guides.slice(0, 6);

  return (
    <>
      <Header />

      <section className="max-w-wide mx-auto px-5 pt-20 pb-14">
        <h1 className="font-serif text-[42px] md:text-[64px] font-bold leading-[1.03] max-w-[16ch] mb-6">
          {site.tagline}
        </h1>
        <p className="font-body text-[19px] leading-relaxed text-clay-muted max-w-prose">
          {site.description}
        </p>
        <Link
          href="/guides"
          className="inline-flex mt-8 items-center gap-2 bg-terra hover:bg-terra-hover text-white px-7 py-3.5 rounded-lg font-sans text-[14px] font-semibold transition-colors"
        >
          Смотреть гайды →
        </Link>
      </section>

      <section className="max-w-wide mx-auto px-5 pb-10">
        <div className="flex items-baseline justify-between mb-6">
          <h2 className="font-serif text-[26px] font-bold">Свежее</h2>
          <Link href="/guides" className="font-mono text-[13px] text-clay-subtle hover:text-terra">
            все →
          </Link>
        </div>

        {latest.length === 0 ? (
          <div className="rounded-xl border border-dashed border-paper-line p-10 text-center text-clay-subtle">
            Гайдов пока нет. Первый появится здесь сам, когда агент выполнит команду «сделай гайд».
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {latest.map((g) => (
              <Link
                key={g.slug}
                href={`/guides/${g.slug}`}
                className="block rounded-xl border border-paper-line bg-paper-card p-6 hover:border-terra/40 transition-colors"
              >
                <div className="font-mono text-[12px] uppercase tracking-wider text-terra mb-3">{g.tag}</div>
                <div className="font-serif text-[21px] font-semibold leading-snug mb-2">{g.title}</div>
                <div className="font-body text-[15.5px] text-clay-muted leading-relaxed">{g.excerpt}</div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <Footer />
    </>
  );
}
