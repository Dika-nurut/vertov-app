'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { mediaDisplayTitle } from '@seed/shared/media-title';
import { assetSrc } from '@/lib/asset-src';
import { AssetLifecycleNotice } from '@/app/_components/AssetLifecycleNotice';

interface MediaDetail {
  id: string;
  title: string | null;
  originalName: string | null;
  assetUrl: string;
  thumbnailUrl: string | null;
  kind: 'image' | 'video' | 'audio';
  mimeType: string | null;
  createdAt: string;
  expiresAt: string | null;
  projects: Array<{ id: string; title: string }>;
  projectCount: number;
  association: 'standalone' | 'single' | 'multiple';
  projectsTruncated: boolean;
}

function mediaLabel(media: MediaDetail): string {
  return mediaDisplayTitle(media);
}

export function MediaDetailClient({ assetId, apiUrl }: { assetId: string; apiUrl: string }) {
  const router = useRouter();
  const [media, setMedia] = useState<MediaDetail | null>(null);
  const [state, setState] = useState<
    'loading' | 'ready' | 'error' | 'missing' | 'forbidden' | 'expired' | 'deleted'
  >('loading');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    fetch(`${apiUrl.replace(/\/$/, '')}/v1/search/media/${encodeURIComponent(assetId)}`, {
      credentials: 'include',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        if (response.status === 404) {
          setState('missing');
          return null;
        }
        if (response.status === 403) {
          setState('forbidden');
          return null;
        }
        if (response.status === 410) {
          const body = (await response.json().catch(() => null)) as { reason?: unknown } | null;
          setState(body?.reason === 'deleted' ? 'deleted' : 'expired');
          return null;
        }
        if (!response.ok) throw new Error(`http_${response.status}`);
        return (await response.json()) as { media: MediaDetail };
      })
      .then((payload) => {
        if (!payload || controller.signal.aborted) return;
        setMedia(payload.media);
        setState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('error');
      });
    return () => controller.abort();
  }, [apiUrl, assetId, retryKey]);

  return (
    <main className="min-h-dvh bg-[color:var(--color-bg)] px-5 py-5 text-[color:var(--color-fg)] md:px-10 md:py-8">
      <header className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          data-testid="media-back"
          onClick={() => {
            if (window.history.length > 1) router.back();
            else router.push('/search');
          }}
          className="border-2 border-[color:var(--color-line)] px-4 py-2 font-mono text-[10px] font-bold uppercase focus-visible:outline-[3px] focus-visible:outline-[color:var(--color-accent)]"
        >
          ← Назад
        </button>
        <Link
          href="/gallery"
          className="border-2 border-[color:var(--color-line)] px-4 py-2 font-mono text-[10px] font-bold uppercase focus-visible:outline-[3px] focus-visible:outline-[color:var(--color-accent)]"
        >
          Галерея
        </Link>
        <Link
          href="/search"
          className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-muted-foreground)] underline underline-offset-4"
        >
          Новый поиск
        </Link>
      </header>

      {state === 'loading' && (
        <section
          data-testid="media-detail-loading"
          role="status"
          className="mx-auto mt-8 grid min-h-[70vh] max-w-7xl animate-pulse place-items-center border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] font-mono text-xs uppercase tracking-widest"
        >
          Открываем точный материал…
        </section>
      )}

      {state === 'missing' && (
        <section
          data-testid="media-detail-missing"
          className="mx-auto mt-8 grid min-h-[70vh] max-w-7xl place-items-center border-2 border-[color:var(--color-line-soft)] text-center"
        >
          <div>
            <h1 className="font-display text-3xl font-black">Материал недоступен</h1>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              Он удалён, срок хранения истёк или у вас нет доступа.
            </p>
          </div>
        </section>
      )}

      {state === 'forbidden' && (
        <section
          data-testid="media-detail-forbidden"
          className="mx-auto mt-8 grid min-h-[70vh] max-w-7xl place-items-center border-2 border-[color:var(--color-destructive)] text-center"
        >
          <div>
            <h1 className="font-display text-3xl font-black">Нет доступа к материалу</h1>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              Откройте материал из своего проекта или поиска.
            </p>
          </div>
        </section>
      )}

      {state === 'expired' && (
        <section
          data-testid="media-detail-expired"
          className="mx-auto mt-8 grid min-h-[70vh] max-w-7xl place-items-center border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] text-center"
        >
          <div>
            <h1 className="font-display text-3xl font-black">Срок хранения истёк</h1>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              Материал больше нельзя открыть или скачать.
            </p>
            <Link
              href="/pricing"
              className="mt-5 inline-block border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2 font-mono text-[10px] font-bold uppercase text-black"
            >
              Оставить навсегда → тариф
            </Link>
          </div>
        </section>
      )}

      {state === 'deleted' && (
        <section
          data-testid="media-detail-deleted"
          className="mx-auto mt-8 grid min-h-[70vh] max-w-7xl place-items-center border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] text-center"
        >
          <div>
            <h1 className="font-display text-3xl font-black">Материал удалён</h1>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              Этот материал больше нельзя открыть или скачать.
            </p>
          </div>
        </section>
      )}

      {state === 'error' && (
        <section
          data-testid="media-detail-error"
          role="alert"
          className="mx-auto mt-8 grid min-h-[70vh] max-w-7xl place-items-center border-2 border-[color:var(--color-destructive)] text-center"
        >
          <div>
            <h1 className="font-display text-3xl font-black">Не удалось открыть материал</h1>
            <button
              type="button"
              onClick={() => setRetryKey((value) => value + 1)}
              className="mt-5 border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2 font-mono text-[10px] font-bold uppercase text-black"
            >
              Повторить
            </button>
          </div>
        </section>
      )}

      {state === 'ready' && media && (
        <div
          data-testid="media-detail"
          className="mx-auto mt-8 grid max-w-7xl gap-6 lg:grid-cols-[minmax(0,1fr)_340px]"
        >
          <section className="grid min-h-[65vh] place-items-center border-[2.5px] border-[color:var(--color-line)] bg-black p-3">
            {media.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                data-testid="media-detail-image"
                src={assetSrc(media.assetUrl)}
                alt={mediaLabel(media)}
                className="max-h-[78vh] max-w-full object-contain"
              />
            ) : media.kind === 'video' ? (
              <video
                data-testid="media-detail-video"
                src={assetSrc(media.assetUrl)}
                controls
                playsInline
                className="max-h-[78vh] max-w-full"
              />
            ) : (
              <div className="w-full max-w-xl text-center">
                <strong className="font-display text-5xl">AUDIO</strong>
                <audio
                  data-testid="media-detail-audio"
                  src={assetSrc(media.assetUrl)}
                  controls
                  className="mt-8 w-full"
                />
              </div>
            )}
          </section>

          <aside className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--color-accent-tint)]">
              {media.kind}
            </p>
            <h1 className="mt-2 break-words font-display text-3xl font-black">
              {mediaLabel(media)}
            </h1>
            <div className="mt-4">
              <AssetLifecycleNotice expiresAt={media.expiresAt} assetUrl={media.assetUrl} />
            </div>
            <p className="mt-3 font-mono text-[10px] uppercase text-[color:var(--color-faint)]">
              Точный ID · {media.id}
            </p>
            <p className="tnum mt-3 text-xs text-[color:var(--color-muted-foreground)]">
              Создано · {new Date(media.createdAt).toLocaleString('ru-RU')}
            </p>

            <div className="mt-8 border-t border-[color:var(--color-line-soft)] pt-5">
              {media.association === 'standalone' ? (
                <>
                  <h2 className="font-display text-lg font-black">Личная библиотека</h2>
                  <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
                    Самостоятельный материал без проекта.
                  </p>
                </>
              ) : (
                <>
                  <h2 className="font-display text-lg font-black">
                    {media.association === 'multiple'
                      ? 'Выберите контекст проекта'
                      : 'Контекст проекта'}
                  </h2>
                  <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
                    Материал откроется на столе выбранного проекта. Поиск не выбирает проект
                    автоматически.
                  </p>
                  <nav aria-label="Открыть материал в проекте" className="mt-4 flex flex-col gap-2">
                    {media.projects.map((project) => (
                      <a
                        key={project.id}
                        data-testid={`media-project-${project.id}`}
                        href={`/workspace/${encodeURIComponent(project.id)}/media/${encodeURIComponent(media.id)}`}
                        className="border-2 border-[color:var(--color-line)] px-3 py-3 font-mono text-[11px] font-bold uppercase hover:bg-[color:var(--color-accent)] hover:text-black focus-visible:bg-[color:var(--color-accent)] focus-visible:text-black focus-visible:outline-[3px] focus-visible:outline-[color:var(--color-line)]"
                      >
                        {project.title} ↗
                      </a>
                    ))}
                  </nav>
                  {media.projectsTruncated && (
                    <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
                      Показаны первые {media.projects.length} из {media.projectCount} проектов.
                    </p>
                  )}
                </>
              )}
            </div>

            <a
              href={assetSrc(media.assetUrl)}
              download
              className="mt-8 inline-block font-mono text-[10px] font-bold uppercase underline underline-offset-4"
            >
              Скачать оригинал ↓
            </a>
          </aside>
        </div>
      )}
    </main>
  );
}
