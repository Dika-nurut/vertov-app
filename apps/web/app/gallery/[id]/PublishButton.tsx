'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { trackEvent, PlausibleEvent } from '../../_components/PlausibleEvents';

export function PublishButton({
  itemId,
  initiallyPublic,
  initialSlug,
  apiUrl,
  webPublicUrl,
}: {
  itemId: string;
  initiallyPublic: boolean;
  initialSlug: string | null;
  apiUrl: string;
  webPublicUrl: string;
}) {
  const [isPublic, setIsPublic] = useState(initiallyPublic);
  const [slug, setSlug] = useState<string | null>(initialSlug);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function togglePublish() {
    setBusy(true);
    setError(null);
    try {
      const path = isPublic ? '/v1/gallery/unpublish' : '/v1/gallery/publish';
      const res = await fetch(`${apiUrl}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId }),
      });
      if (!res.ok) {
        setError(`Ошибка: ${res.status}`);
        return;
      }
      if (!isPublic) {
        const body = (await res.json()) as { slug: string };
        setSlug(body.slug);
        setIsPublic(true);
        trackEvent(PlausibleEvent.galleryPublish);
      } else {
        setIsPublic(false);
      }
    } finally {
      setBusy(false);
    }
  }

  const publicUrl = slug ? `${webPublicUrl}/g/${slug}` : null;

  return (
    <div className="space-y-2">
      <Button
        type="button"
        data-testid="publish-button"
        onClick={() => void togglePublish()}
        disabled={busy}
        variant="outline"
        className="w-full"
      >
        {busy ? 'Подожди…' : isPublic ? 'Снять с публикации' : 'Опубликовать'}
      </Button>
      {isPublic && publicUrl && (
        <p
          data-testid="public-url"
          className="break-all text-xs text-[color:var(--color-muted-foreground)]"
        >
          Публичная ссылка:{' '}
          <a
            href={publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[color:var(--color-accent)] underline-offset-2 hover:underline"
          >
            {publicUrl}
          </a>
        </p>
      )}
      {error && <p className="text-xs text-[color:var(--color-destructive)]">{error}</p>}
    </div>
  );
}
