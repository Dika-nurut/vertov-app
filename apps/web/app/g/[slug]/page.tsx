import { notFound } from 'next/navigation';
import { Wordmark } from '@/components/ui/wordmark';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import { ReportButton } from './ReportButton';
import { assetSrc } from '@/lib/asset-src';
import { modelDisplayName } from '@/lib/models';
import { apiBaseUrl } from '@/lib/server-api';

interface PublicItem {
  id: string;
  jobId: string;
  assetUrl: string;
  kind: 'image' | 'video';
  modelId: string;
  modelFamily: string;
  modelVariant: string;
  modelDisplayName: string | null;
  prompt: string;
  presetSlug: string | null;
  createdAt: string;
  displayName: string;
}

const SSR_API_URL =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'; // SSR: internal origin

// ISR with a 10s revalidation window — tightened from 60s so an unpublish
// is visible within 10 s without forcing every request through the API.
// The API also sets Cache-Control: private, no-store so a stale CDN layer
// can never serve a now-unpublished item (#3 audit fix).
export const revalidate = 10;

async function getItem(slug: string): Promise<PublicItem | null> {
  try {
    const res = await fetch(`${SSR_API_URL}/v1/g/${encodeURIComponent(slug)}`, {
      next: { revalidate: 10 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicItem;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const item = await getItem(slug);
  // Unknown/unpublished slug: notFound() gives the 404 status (this route has
  // no loading.tsx, so the render blocks on the fetch above instead of
  // streaming a 200 shell first), and the explicit noindex keeps the variant
  // out of search results even if a proxy ever serves it as 200 (soft-404).
  if (!item) return { title: 'Vertov', robots: { index: false, follow: false } };
  const title = item.prompt
    ? `${item.prompt.slice(0, 80)} — Vertov`
    : `Работа от ${item.displayName} — Vertov`;
  const description = item.prompt
    ? item.prompt.slice(0, 200)
    : `Сгенерировано на Vertov моделью ${modelDisplayName({ family: item.modelFamily, variant: item.modelVariant, displayName: item.modelDisplayName })}.`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: item.assetUrl }],
      type: 'article',
      locale: 'ru_RU',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [item.assetUrl],
    },
  };
}

export default async function PublicGalleryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const item = await getItem(slug);
  if (!item) notFound();

  // Provenance deep-link — recipe (preset) + source refs (from) together, plus
  // the public `via` handle (J-2 follow-up, 2026-09-02): when the visitor is not
  // the job owner, /v1/jobs/:id 404s and the client falls back to
  // /v1/g/<via>/prefill for the same recipe.
  const remixHref = `/generate?${new URLSearchParams(
    item.presetSlug
      ? { preset: item.presetSlug, from: item.jobId, via: slug }
      : { from: item.jobId, via: slug },
  )}`;
  const remixLabel = item.presetSlug ? 'Повторить стиль' : 'Сгенерировать похожее';

  return (
    <main className="mx-auto max-w-5xl px-5 py-10" data-testid="public-gallery-page">
      <header className="mb-8 flex items-center justify-between">
        <Link href="/" className="press inline-flex items-center">
          <Wordmark size={28} />
        </Link>
        <Button asChild variant="outline" size="sm">
          <Link href="/login">Войти</Link>
        </Button>
      </header>

      <div className="grid gap-8 md:grid-cols-[2fr_1fr]">
        <div
          className="overflow-hidden rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-black/40 shadow-[5px_5px_0_0_var(--color-shadow)]"
          data-testid="public-hero"
        >
          {item.kind === 'video' ? (
            <video
              src={assetSrc(item.assetUrl)}
              controls
              playsInline
              className="h-auto w-full"
              aria-label={item.prompt || 'Сгенерированное видео'}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={assetSrc(item.assetUrl)}
              alt={item.prompt || 'Сгенерированная работа'}
              className="w-full"
            />
          )}
        </div>
        <aside className="space-y-6">
          <div>
            <div className="label-eyebrow">Промт</div>
            <p
              data-testid="public-prompt"
              className="mt-1.5 whitespace-pre-wrap text-[15px] leading-relaxed text-[color:var(--color-fg)]"
            >
              {item.prompt || '—'}
            </p>
          </div>
          <div>
            <div className="label-eyebrow">Модель</div>
            <div
              className="mt-1.5 text-sm text-[color:var(--color-muted-foreground)]"
              data-testid="public-model"
            >
              {modelDisplayName({
                family: item.modelFamily,
                variant: item.modelVariant,
                displayName: item.modelDisplayName,
              })}
            </div>
          </div>
          <div>
            <div className="label-eyebrow">Автор</div>
            <div
              className="mt-1.5 text-sm text-[color:var(--color-muted-foreground)]"
              data-testid="public-author"
            >
              {item.displayName}
            </div>
          </div>
          <Button asChild size="lg" className="w-full">
            <Link href={remixHref} data-testid="public-remix">
              {remixLabel}
            </Link>
          </Button>
        </aside>
        {/* Client-side reports must use the browser-reachable public origin, not API_INTERNAL_URL. */}
        <ReportButton slug={slug} apiUrl={apiBaseUrl()} />
      </div>
      <footer className="mt-8 border-t-[2px] border-[color:var(--color-line-soft)] pt-4 text-center">
        <a
          href="https://vertov.space"
          className="font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-accent)]"
          data-testid="public-attribution"
        >
          Сделано в Vertov
        </a>
      </footer>
    </main>
  );
}
