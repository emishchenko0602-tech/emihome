// Реестр гайдов. Скилл /гайд дописывает сюда одну запись — и гайд появляется
// и на витрине, и в списке. Порядок в массиве = порядок на сайте (новые сверху).

export type Guide = {
  slug: string;        // папка в app/guides/<slug>/
  title: string;       // заголовок карточки
  excerpt: string;     // 1–2 предложения, зачем читать
  date: string;        // YYYY-MM-DD
  readMin: number;     // время чтения, минут
  tag: string;         // короткая метка темы
  keyword?: string;    // кодовое слово воронки, если гайд связан с ней
};

export const guides: Guide[] = [
  {
    slug: "primer-gayda",
    title: "Пример гайда: как устроена эта страница",
    excerpt:
      "Образец структуры по канону: связная проза, врезки, две инфографики и блок источников. Удали его, когда выйдет первый настоящий гайд.",
    date: "2026-01-01",
    readMin: 4,
    tag: "образец",
  },
];

export const getGuide = (slug: string) => guides.find((g) => g.slug === slug);
