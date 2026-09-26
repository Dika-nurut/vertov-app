'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { mediaDisplayTitle } from '@seed/shared/media-title';
import { assetSrc } from '@/lib/asset-src';
import { AssetLifecycleNotice } from '@/app/_components/AssetLifecycleNotice';
import styles from './viewer.module.css';

interface ViewerAsset {
  id: string;
  assetUrl: string;
  thumbnailUrl: string | null;
  kind: 'image' | 'video' | 'audio';
  title: string | null;
  originalName: string | null;
  sourceLine: string | null;
  mimeType: string | null;
  expiresAt: string | null;
  createdAt: string;
}

function assetLabel(asset: ViewerAsset): string {
  return mediaDisplayTitle(asset);
}

export function MediaViewer({
  projectId,
  assetId,
  apiUrl,
}: {
  projectId: string;
  assetId: string;
  apiUrl: string;
}) {
  const [asset, setAsset] = useState<ViewerAsset | null>(null);
  const [state, setState] = useState<
    'loading' | 'ready' | 'missing' | 'forbidden' | 'expired' | 'deleted' | 'error'
  >('loading');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setAsset(null);
    setState('loading');
    fetch(
      `${apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(assetId)}`,
      { credentials: 'include' },
    )
      .then(async (response) => {
        if (response.status === 404) {
          if (alive) setState('missing');
          return null;
        }
        if (response.status === 403) {
          if (alive) setState('forbidden');
          return null;
        }
        if (response.status === 410) {
          const body = (await response.json().catch(() => null)) as { reason?: unknown } | null;
          if (alive) setState(body?.reason === 'deleted' ? 'deleted' : 'expired');
          return null;
        }
        if (!response.ok) throw new Error(`http_${response.status}`);
        return (await response.json()) as { asset: ViewerAsset };
      })
      .then((payload) => {
        if (alive && payload) {
          setAsset(payload.asset);
          setState('ready');
        }
      })
      .catch(() => {
        if (alive) setState('error');
      });
    return () => {
      alive = false;
    };
  }, [apiUrl, assetId, projectId, retryKey]);

  if (!asset || state !== 'ready') {
    return (
      <main className={styles.viewer} data-testid="media-viewer">
        <header>
          <Link href={`/workspace/${projectId}`}>← НА СТОЛ</Link>
        </header>
        <div className={styles.lifecycle} aria-hidden="true" />
        <section className={styles.stage}>
          {state === 'loading' && 'ОТКРЫВАЕМ…'}
          {state === 'missing' && 'МАТЕРИАЛ НЕ НАЙДЕН'}
          {state === 'forbidden' && 'НЕТ ДОСТУПА К МАТЕРИАЛУ'}
          {state === 'expired' && (
            <div className={styles.stateMessage}>
              <strong>СРОК ХРАНЕНИЯ ИСТЁК</strong>
              <Link href="/pricing">ОСТАВИТЬ НАВСЕГДА → ТАРИФ</Link>
            </div>
          )}
          {state === 'deleted' && 'МАТЕРИАЛ УДАЛЁН'}
          {state === 'error' && (
            <div className={styles.stateMessage}>
              <strong>НЕ УДАЛОСЬ ОТКРЫТЬ МАТЕРИАЛ</strong>
              <button type="button" onClick={() => setRetryKey((value) => value + 1)}>
                ПОВТОРИТЬ
              </button>
            </div>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className={styles.viewer} data-testid="media-viewer">
      <header>
        <Link href={`/workspace/${projectId}`}>← НА СТОЛ</Link>
        <b>{assetLabel(asset)}</b>
        <span>{asset.kind.toUpperCase()}</span>
      </header>
      <div className={styles.lifecycle}>
        <AssetLifecycleNotice expiresAt={asset.expiresAt} assetUrl={asset.assetUrl} />
      </div>
      <section className={styles.stage}>
        {asset.kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assetSrc(asset.assetUrl)} alt={assetLabel(asset)} />
        ) : asset.kind === 'video' ? (
          <video src={assetSrc(asset.assetUrl)} controls autoPlay playsInline />
        ) : (
          <div className={styles.audioStage}>
            <strong>AUDIO</strong>
            <audio src={assetSrc(asset.assetUrl)} controls autoPlay />
          </div>
        )}
      </section>
      <footer>
        <span>
          {asset.sourceLine ?? 'материал проекта'} ·{' '}
          <time className="tnum" dateTime={asset.createdAt}>
            {new Date(asset.createdAt).toLocaleDateString('ru-RU')}
          </time>
        </span>
        <a href={assetSrc(asset.assetUrl)} download>
          СКАЧАТЬ ↓
        </a>
      </footer>
    </main>
  );
}
