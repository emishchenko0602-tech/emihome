import type { Metadata } from "next";
import site from "@/site.config.json";
import "./fonts.css";
import "./globals.css";

// Шрифты подключены в fonts.css файлами из public/fonts, а не через next/font.
// Причина: сборка на Layero не имеет доступа к Google Fonts, и деплой падал.
export const metadata: Metadata = {
  title: `${site.brand} — ${site.tagline}`,
  description: site.description,
  openGraph: {
    title: site.brand,
    description: site.description,
    type: "website",
    locale: "ru_RU",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="ru"
    >
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
