'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { mediaDisplayTitle } from '@seed/shared/media-title';
import { assetSrc } from '@/lib/asset-src';
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
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(
      `${apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(assetId)}`,
      { credentials: 'include' },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`http_${response.status}`);
        return (await response.json()) as { asset: ViewerAsset };
      })
      .then((payload) => {
        if (alive) setAsset(payload.asset);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [apiUrl, assetId, projectId]);

  if (!asset) {
    return (
      <main className={styles.viewer} data-testid="media-viewer">
        <header>
          <Link href={`/workspace/${projectId}`}>← НА СТОЛ</Link>
        </header>
        <section className={styles.stage}>{error ? 'МАТЕРИАЛ НЕДОСТУПЕН' : 'ОТКРЫВАЕМ…'}</section>
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
        <span>{asset.sourceLine ?? 'материал проекта'}</span>
        <a href={assetSrc(asset.assetUrl)} download>
          СКАЧАТЬ ↓
        </a>
      </footer>
    </main>
  );
}
