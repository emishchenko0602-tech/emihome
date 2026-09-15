import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { GuideHero, Figure, Callout, Sources, KeywordCTA, BackToGuides } from "@/components/Guide";
import { getGuide } from "@/lib/guides";

// ОБРАЗЕЦ. Скилл /гайд копирует этот файл под новый slug и заменяет содержимое.
// Удали папку, когда выйдет первый настоящий гайд, и убери запись из lib/guides.ts.

const g = getGuide("primer-gayda")!;

export const metadata: Metadata = {
  title: g.title,
  description: g.excerpt,
};

export default function Page() {
  return (
    <>
      <Header />

      <GuideHero title={g.title} excerpt={g.excerpt} date={g.date} readMin={g.readMin} tag={g.tag} />

      <article className="prose-editorial max-w-prose mx-auto px-5">
        <p>
          Гайд держится на четырёх вещах, и ни одна из них не украшение. Первое — настоящие
          источники: каждая команда и каждое утверждение взяты из документации или репозитория,
          а не по памяти. Второе — связная проза: абзацы, которые читаются подряд, а не список
          из семи пунктов вместо текста. Третье — тёплая типографика, на которой длинный текст
          не утомляет. Четвёртое — две инфографики, которые показывают то, что тяжело объяснить
          словами.
        </p>

        <h2>Как устроена страница</h2>
        <p>
          Шапка берёт данные из <code>lib/guides.ts</code> — там же лежит карточка для списка,
          поэтому заголовок и описание нигде не расходятся. Дальше идёт проза внутри
          <code>.prose-editorial</code>: заголовки, списки, таблицы и код уже оформлены, руками
          стили не назначаются.
        </p>

        <Figure
          src="/guides/primer-gayda/infographic-01.png"
          alt="Первая инфографика гайда"
          caption="Первая инфографика: общая схема того, о чём гайд"
        />

        <h2>Врезки</h2>
        <p>
          Врезка нужна там, где читатель может ошибиться. Не для украшения абзаца, а чтобы
          остановить его перед граблями.
        </p>

        <Callout title="Если пропустить этот шаг" tone="warn">
          <p>
            Так выглядит предупреждение. Внутри — обычный текст, ссылки и списки работают как везде.
          </p>
        </Callout>

        <h2>Вторая инфографика</h2>
        <p>
          Вторая обычно показывает порядок действий или сравнение вариантов. Обе картинки
          генерируются командой <code>node scripts/guide-infographics.mjs</code> и кладутся
          в <code>public/guides/&lt;slug&gt;/</code>.
        </p>

        <Figure
          src="/guides/primer-gayda/infographic-02.png"
          alt="Вторая инфографика гайда"
          caption="Вторая инфографика: порядок действий"
        />
      </article>

      <KeywordCTA
        keyword="СЛОВО"
        text="Здесь стоит мост в воронку: человек пишет кодовое слово в директ и получает продолжение. Слово должно совпадать с тем, что заведено в воронке."
        href="https://instagram.com/"
      />

      <Sources
        items={[
          { title: "Документация инструмента", url: "https://example.com", note: "откуда взяты команды" },
          { title: "Репозиторий проекта", url: "https://github.com", note: "лицензия и установка" },
        ]}
      />

      <BackToGuides />
      <Footer />
    </>
  );
}
