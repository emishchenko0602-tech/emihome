import type { Config } from "tailwindcss";

// Палитра editorial-«бумаги»: тёплый кремовый фон, near-black текст, один
// терракотовый акцент. Меняешь акцент — меняется весь сайт, трогать больше нечего.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: "#F7F2E8", // фон страницы
          card: "#FCF9F2",    // карточки
          deep: "#EFE7D6",    // чередующиеся секции
          line: "#E4DAC7",    // границы
        },
        clay: {
          DEFAULT: "#1E1A16", // основной текст
          muted: "#6E655A",   // вторичный
          subtle: "#9B8F7E",  // подписи и мета
        },
        terra: {
          DEFAULT: "#BE4A24", // акцент
          hover: "#A23C1B",
          soft: "#F2E2D9",
        },
        gold: "#C98A3C",
      },
      fontFamily: {
        sans: ["var(--font-display)", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
        body: ["var(--font-body)", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      maxWidth: {
        prose: "720px",
        wide: "1120px",
      },
    },
  },
  plugins: [],
};

export default config;
