import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono, Playfair_Display, Lora } from "next/font/google";
import site from "@/site.config.json";
import "./globals.css";

const display = Space_Grotesk({
  subsets: ["latin", "latin-ext"],
  variable: "--font-display",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500"],
});

const serif = Playfair_Display({
  subsets: ["latin", "cyrillic"],
  variable: "--font-serif",
  display: "swap",
  weight: ["500", "600", "700", "800"],
});

const body = Lora({
  subsets: ["latin", "cyrillic"],
  variable: "--font-body",
  display: "swap",
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

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
      className={`${display.variable} ${mono.variable} ${serif.variable} ${body.variable}`}
    >
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
