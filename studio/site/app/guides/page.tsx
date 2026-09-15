import Link from "next/link";
import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { guides } from "@/lib/guides";
import site from "@/site.config.json";

export const metadata: Metadata = {
  title: `Гайды — ${site.brand}`,
  description: site.description,
};

export default function GuidesPage() {
  return (
    <>
      <Header />

      <section className="max-w-wide mx-auto px-5 pt-16 pb-10">
        <h1 className="font-serif text-[36px] md:text-[48px] font-bold mb-4">Гайды</h1>
        <p className="font-body text-[18px] text-clay-muted max-w-prose">
          Разборы инструментов с проверенными источниками и пошаговыми командами.
        </p>
      </section>

      <section className="max-w-wide mx-auto px-5 pb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {guides.map((g) => (
            <Link
              key={g.slug}
              href={`/guides/${g.slug}`}
              className="block rounded-xl border border-paper-line bg-paper-card p-6 hover:border-terra/40 transition-colors"
            >
              <div className="flex items-center gap-3 font-mono text-[12px] uppercase tracking-wider text-clay-subtle mb-3">
                <span className="text-terra">{g.tag}</span>
                <span>·</span>
                <span>{g.readMin} мин</span>
              </div>
              <div className="font-serif text-[21px] font-semibold leading-snug mb-2">{g.title}</div>
              <div className="font-body text-[15.5px] text-clay-muted leading-relaxed">{g.excerpt}</div>
            </Link>
          ))}
        </div>
      </section>

      <Footer />
    </>
  );
}
