import Link from 'next/link';
import type { Metadata } from 'next';

// 404 variants must never be indexed (crawl hygiene: unknown /g/ slugs and
// unmatched URLs render here). Next also auto-injects noindex on notFound()
// renders — this makes it explicit and unit-testable.
export const metadata: Metadata = {
  title: 'Страница не найдена',
  robots: { index: false, follow: false },
};

// 404 — SPEC 11-03 state grammar (finding BA-03). Formula: a mono coral status
// readout → a plain display statement → one factual sentence → the primary way
// home + one alternative. No illustration, no broken-robot mascot, no default
// white Next page.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="text-label text-[color:var(--color-destructive)]">
        Ошибка 404 · Страница не найдена
      </p>
      <h1 className="text-h1 text-[color:var(--color-fg)]">Такой страницы нет</h1>
      <p className="max-w-md text-sm leading-relaxed text-[color:var(--color-muted-foreground)]">
        Ссылка устарела или страницу перенесли. Вернись на главную или загляни в архив своих работ.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Link href="/" className="btn btn-primary">
          На главную
        </Link>
        <Link href="/gallery" className="btn btn-ghost">
          В архив
        </Link>
      </div>
    </main>
  );
}
