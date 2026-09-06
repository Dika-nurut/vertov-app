import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { AppShell } from './_components/AppShell';
import { Landing } from './_components/landing/Landing';
import {
  HomeBoard,
  type GenFrame,
  type ProjFrame,
  type TrendFrame,
} from './_components/home/HomeBoard';
import { apiBaseUrl, apiGet } from '../lib/server-api';
import type { PresetRow } from './generate/GenerateClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { alternates: { canonical: '/' } };

interface MeResponse {
  user: { id: string; email: string; name?: string; isAnonymous?: boolean };
}
interface BalanceResponse {
  available: number;
}
interface ProfileResponse {
  displayName: string | null;
  onboardedAt: string | null;
}
interface GalleryRow {
  assetUrl: string;
  thumbnailUrl: string | null;
  kind: 'image' | 'video';
}
interface ProjectRow {
  id: string;
  title: string;
  updatedAt: string;
}

const TREND_EYEBROW: Record<string, string> = {
  effect: 'Эффект · тренд',
  camera: 'Камера · тренд',
  style: 'Стиль · тренд',
  scene: 'Сцена · тренд',
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const sp = await searchParams;
  const cookieStore = await cookies();
  const lang = sp.lang ?? cookieStore.get('lang')?.value ?? 'ru';

  const me = await apiGet<MeResponse>('/v1/me');

  // Pre-paywall anonymous browsing (2026-07-07): a silently-minted "Гость"
  // session carries a real cookie, so `!me.data` alone no longer distinguishes
  // visitor from user — an anon landing back on / must still see the marketing
  // page, never the authenticated board wearing a fake account header.
  if (!me.data || me.data.user.isAnonymous) {
    return <Landing />;
  }

  const [balance, profile, gallery, boards, scripts, studio, packs] = await Promise.all([
    apiGet<BalanceResponse>('/v1/credits/balance'),
    apiGet<ProfileResponse>('/v1/me/profile'),
    apiGet<{ rows: GalleryRow[] }>('/v1/gallery?limit=12'),
    apiGet<{ items: ProjectRow[] }>('/v1/boards'),
    apiGet<{ items: ProjectRow[] }>('/v1/scripts'),
    apiGet<{ items: ProjectRow[] }>('/v1/studio/projects'),
    apiGet<{ items: PresetRow[] }>('/v1/preset-packs?lang=ru'),
  ]);

  // «Твои кадры» — the user's own recent generations (materialised outputs).
  const generations: GenFrame[] = (gallery.data?.rows ?? [])
    .filter((r) => r.assetUrl)
    .map((r) => ({ mediaUrl: r.thumbnailUrl ?? r.assetUrl, kind: r.kind }));

  // «Проекты» — most-recent work across the three project surfaces, merged by
  // updatedAt (each list is already per-user, updatedAt-desc capped).
  const projects: ProjFrame[] = [
    ...(boards.data?.items ?? []).map((p) => ({
      title: p.title || 'Без названия',
      eyebrow: 'Проект · доска',
      href: `/boards/${p.id}`,
      hashKey: p.id,
      surface: 'board' as const,
      updatedAt: p.updatedAt,
    })),
    ...(scripts.data?.items ?? []).map((p) => ({
      title: p.title || 'Без названия',
      eyebrow: 'Проект · сценарий',
      href: `/scenario/${p.id}`,
      hashKey: p.id,
      surface: 'script' as const,
      updatedAt: p.updatedAt,
    })),
    ...(studio.data?.items ?? []).map((p) => ({
      title: p.title || 'Монтаж',
      eyebrow: 'Проект · монтаж',
      href: `/studio/${p.id}`,
      hashKey: p.id,
      surface: 'studio' as const,
      updatedAt: p.updatedAt,
    })),
  ]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 8);

  // «Тренды» — the trending preset/effect pool the medium tiles rotate through
  // (hardcoded curation via sort order — owner's pick, zero backend work).
  const trending: TrendFrame[] = (packs.data?.items ?? [])
    .filter((p) => p.samplePreviewUrl)
    .slice(0, 8)
    .map((p) => ({
      slug: p.slug,
      title: p.title,
      eyebrow: TREND_EYEBROW[p.category ?? 'scene'] ?? 'Пресет · тренд',
      mediaUrl: p.samplePreviewUrl,
      isVideo: p.samplePreviewUrl.endsWith('.mp4'),
    }));

  const displayName =
    profile.data?.displayName || me.data.user.name || me.data.user.email.split('@')[0] || 'друг';

  return (
    <AppShell
      email={me.data.user.email}
      balance={balance.data?.available ?? 0}
      apiUrl={apiBaseUrl()}
      // A profile error is not proof of a fresh account. Keep the welcome card
      // fail-closed until the server returns a definitive profile value.
      onboardedAt={profile.data?.onboardedAt}
      lang={lang}
    >
      <HomeBoard
        displayName={displayName}
        worksCount={generations.length}
        credits={balance.data?.available ?? 0}
        generations={generations}
        projects={projects}
        trending={trending}
      />
    </AppShell>
  );
}
