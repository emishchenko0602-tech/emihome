import site from "@/site.config.json";

export function Footer() {
  return (
    <footer className="border-t border-paper-line mt-24">
      <div className="max-w-wide mx-auto px-5 py-10 flex flex-col md:flex-row gap-3 md:items-center md:justify-between text-[13px] text-clay-subtle">
        <div>
          © {new Date().getFullYear()} {site.brand}
        </div>
        <div className="flex gap-5">
          {site.instagram ? (
            <a href={site.instagram} target="_blank" rel="noopener" className="hover:text-terra transition-colors">
              Instagram
            </a>
          ) : null}
          {site.telegram ? (
            <a href={site.telegram} target="_blank" rel="noopener" className="hover:text-terra transition-colors">
              Telegram
            </a>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
