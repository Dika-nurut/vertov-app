'use client';

import { useState } from 'react';
import { useEffect } from 'react';
import { trackEvent, PlausibleEvent } from '../../_components/PlausibleEvents';

export function ReportButton({ slug, apiUrl }: { slug: string; apiUrl: string }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Viral loop metric: fire once per mount.
  useEffect(() => {
    trackEvent(PlausibleEvent.shareOpened);
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl + '/v1/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug,
          reason: open ? 'Пожаловаться на контент' : '',
          category: 'other',
        }),
      });
      if (res.ok) {
        setSent(true);
        setTimeout(() => setOpen(false), 2000);
      } else {
        setError('Не удалось отправить. Попробуйте позже.');
      }
    } catch {
      setError('Сетевая ошибка');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p
        className="text-center text-[11px] text-[color:var(--color-muted-foreground)]"
        data-testid="report-sent"
      >
        Спасибо, жалоба отправлена.
      </p>
    );
  }

  return (
    <div>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full text-center font-mono text-[11px] uppercase tracking-[0.08em] text-[color:var(--color-faint)] hover:text-[color:var(--color-muted-foreground)]"
          data-testid="report-open"
        >
          Пожаловаться
        </button>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="w-full border-[1.5px] border-[color:var(--color-destructive)] bg-[color:var(--color-surface2)] py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-[color:var(--color-destructive)] hover:bg-[color:var(--color-surface)] disabled:opacity-50"
            data-testid="report-submit"
          >
            {busy ? 'Отправляем…' : 'Подтвердить жалобу'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="w-full text-center font-mono text-[11px] text-[color:var(--color-faint)] hover:text-[color:var(--color-muted-foreground)]"
            data-testid="report-cancel"
          >
            Отмена
          </button>
          {error && (
            <p
              role="alert"
              className="text-center text-[11px] text-[color:var(--color-destructive)]"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
