import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AppShell } from '../../_components/AppShell';
import { apiBaseUrl, apiGet } from '../../../lib/server-api';
import { modelDisplayName, modelDisplayNameFromId } from '../../../lib/models';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { assetSrc } from '@/lib/asset-src';
import { TokenStar } from '@/components/ui/token-star';
import { PublishButton } from './PublishButton';
import { CopyPromptButton } from './CopyPromptButton';
import {
  parseProjectIdSearchValue,
  withProjectContext,
  type ProjectIdSearchValue,
} from '@/lib/project-context';

const WEB_PUBLIC_URL = process.env.WEB_PUBLIC_URL ?? 'http://127.0.0.1:3000';

export const dynamic = 'force-dynamic';

interface MeResponse {
  user: { id: string; email: string; isAnonymous?: boolean };
}
interface BalanceResponse {
  available: number;
}
interface JobDetail {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'refunded';
  modelId: string;
  resultAssets: string[];
  errorCode: string | null;
  errorMessage: string | null;
  creditsReserved: number;
  creditsSpent: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  params: Record<string, unknown>;
  referenceAssets: string[];
  model: { family: string; variant: string; displayName: string | null; kind: string } | null;
  galleryItem: { id: string; isPublic: boolean; publicSlug: string | null } | null;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return iso;
  }
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

const STATUS_LABELS: Record<JobDetail['status'], string> = {
  queued: 'В очереди',
  running: 'Генерируется',
  succeeded: 'Готово',
  failed: 'Ошибка',
  refunded: 'Возврат',
};

export default async function GalleryItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ projectId?: ProjectIdSearchValue }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const context = parseProjectIdSearchValue(sp.projectId);
  const workspaceProjectId = context.mode === 'project' ? context.projectId : null;
  const galleryHref = workspaceProjectId
    ? withProjectContext('/gallery', workspaceProjectId)
    : '/gallery';
  const repeatHref = workspaceProjectId
    ? withProjectContext(`/generate?from=${encodeURIComponent(id)}`, workspaceProjectId)
    : `/generate?from=${encodeURIComponent(id)}`;
  const [me, job, balance] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<JobDetail>(`/v1/jobs/${encodeURIComponent(id)}`),
    apiGet<BalanceResponse>('/v1/credits/balance'),
  ]);
  if (!me.data || me.data.user.isAnonymous) redirect('/login');
  if (!job.data) notFound();

  const j = job.data;
  const prompt = typeof j.params['prompt'] === 'string' ? (j.params['prompt'] as string) : '';
  const size = typeof j.params['size'] === 'string' ? (j.params['size'] as string) : null;
  // Full generation params — what a power user needs to reproduce the result.
  const p = j.params;
  const seed = typeof p['seed'] === 'number' ? (p['seed'] as number) : null;
  const resolution = typeof p['resolution'] === 'string' ? (p['resolution'] as string) : null;
  const durationSec =
    typeof p['duration_seconds'] === 'number' && (p['duration_seconds'] as number) > 0
      ? (p['duration_seconds'] as number)
      : null;
  const aspect = typeof p['aspect_ratio'] === 'string' ? (p['aspect_ratio'] as string) : null;
  const batchN = typeof p['n'] === 'number' && (p['n'] as number) > 1 ? (p['n'] as number) : null;

  return (
    <AppShell
      email={me.data.user.email}
      balance={balance.data?.available ?? 0}
      apiUrl={apiBaseUrl()}
      projectContext={context}
    >
      <div className="px-6 py-6">
        <Link
          href={galleryHref}
          className="inline-block text-sm text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-fg)]"
        >
          ← Назад в архив
        </Link>

        <div className="mt-4 grid items-start gap-6 md:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <div className="space-y-3">
            {j.status === 'succeeded' && j.resultAssets.length > 0 ? (
              j.resultAssets.map((url, i) =>
                isVideoUrl(url) ? (
                  <video
                    key={url}
                    src={assetSrc(url)}
                    data-testid="detail-video"
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] shadow-[5px_5px_0_0_var(--color-shadow)]"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={url}
                    src={assetSrc(url)}
                    alt={prompt ? `${prompt} — ${i + 1}` : `Результат ${i + 1}`}
                    data-testid="detail-image"
                    className="w-full rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] shadow-[5px_5px_0_0_var(--color-shadow)]"
                  />
                ),
              )
            ) : (
              <Card className="flex aspect-square w-full items-center justify-center text-[color:var(--color-muted-foreground)]">
                {STATUS_LABELS[j.status] ?? j.status}
                {j.errorMessage && (
                  <span className="ml-2 text-[color:var(--color-destructive)]">
                    — {j.errorMessage}
                  </span>
                )}
              </Card>
            )}
          </div>

          <Card className="space-y-4 p-5 text-sm md:sticky md:top-20">
            <div>
              <div className="flex items-center justify-between">
                <div className="label-eyebrow">Промпт</div>
                {prompt && <CopyPromptButton text={prompt} />}
              </div>
              <div className="mt-1 whitespace-pre-wrap" data-testid="detail-prompt">
                {prompt || '—'}
              </div>
            </div>
            <div>
              <div className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-faint)]">
                Модель
              </div>
              <div className="mt-1">
                {j.model ? modelDisplayName(j.model) : modelDisplayNameFromId(j.modelId)}
              </div>
            </div>
            {/* Generation params — enough to reproduce the result exactly. */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-3" data-testid="detail-params">
              {size && (
                <div>
                  <div className="label-eyebrow">Размер</div>
                  <div className="mt-1">{size}</div>
                </div>
              )}
              {batchN && (
                <div>
                  <div className="label-eyebrow">Кол-во</div>
                  <div className="mt-1">×{batchN}</div>
                </div>
              )}
              {durationSec && (
                <div>
                  <div className="label-eyebrow">Длительность</div>
                  <div className="mt-1">{durationSec} с</div>
                </div>
              )}
              {resolution && (
                <div>
                  <div className="label-eyebrow">Разрешение</div>
                  <div className="mt-1">{resolution}</div>
                </div>
              )}
              {aspect && (
                <div>
                  <div className="label-eyebrow">Формат</div>
                  <div className="mt-1">{aspect}</div>
                </div>
              )}
              {seed != null && (
                <div>
                  <div className="label-eyebrow">Seed</div>
                  <div className="mt-1 font-mono text-[13px]" data-testid="detail-seed">
                    {seed}
                  </div>
                </div>
              )}
            </div>
            <div>
              <div className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-faint)]">
                Стоимость
              </div>
              <div className="mt-1 inline-flex items-center gap-1">
                <TokenStar size={11} />
                {j.creditsSpent || j.creditsReserved}
              </div>
            </div>
            <div>
              <div className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-faint)]">
                Создано
              </div>
              <div className="mt-1">{formatDate(j.queuedAt)}</div>
            </div>
            <div className="space-y-3 pt-1">
              <Button asChild className="w-full">
                <Link href={repeatHref} data-testid="remix-button">
                  Повторить
                </Link>
              </Button>
              {j.galleryItem && (
                <PublishButton
                  itemId={j.galleryItem.id}
                  initiallyPublic={j.galleryItem.isPublic}
                  initialSlug={j.galleryItem.publicSlug}
                  apiUrl={apiBaseUrl()}
                  webPublicUrl={WEB_PUBLIC_URL}
                />
              )}
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
