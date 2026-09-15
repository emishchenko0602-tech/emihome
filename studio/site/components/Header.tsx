import Link from "next/link";
import site from "@/site.config.json";

export function Header() {
  return (
    <header className="border-b border-paper-line bg-paper/90 backdrop-blur sticky top-0 z-30">
      <div className="max-w-wide mx-auto px-5 h-16 flex items-center justify-between">
        <Link href="/" className="font-serif text-[20px] font-bold tracking-tight">
          {site.brand}
        </Link>
        <nav className="flex items-center gap-6 text-[14px]">
          <Link href="/guides" className="text-clay-muted hover:text-terra transition-colors">
            Гайды
          </Link>
          {site.instagram ? (
            <a
              href={site.instagram}
              target="_blank"
              rel="noopener"
              className="font-mono text-[13px] text-clay-subtle hover:text-terra transition-colors"
            >
              {site.handle}
            </a>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
