import { LandingNav } from './LandingNav';
import { Hero } from './Hero';
import { FeatureTabs } from './FeatureTabs';
import { VitrinaMosaic } from './VitrinaMosaic';
import { CtaBand } from './CtaBand';
import { LandingFooter } from './LandingFooter';
import type { PresetRow } from '../../generate/GenerateClient';
import type { LandingModel } from './HeroPromptBar';
import { serializeJsonLd } from '@/lib/json-ld';

const API_URL =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function getPresetPacks(): Promise<PresetRow[]> {
  try {
    const res = await fetch(`${API_URL}/v1/preset-packs?lang=ru`, { next: { revalidate: 300 } });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: PresetRow[] };
    return body.items ?? [];
  } catch {
    return [];
  }
}

/** The kinobar lists EVERY commercial video engine (owner, 2026-07-10) in a
 *  fixed editorial order — the only exclusions are reference-to-video
 *  variants, which need reference images and make no sense from a text-only
 *  prompt bar. Intersected with the ACTIVE rows from the public /v1/models,
 *  so the landing never advertises an engine we can't run. */
const KINOBAR_MODEL_IDS = [
  'seedance-2-0',
  'seedance-2-0-fast',
  'seedance-1-0-pro-fast',
  'veo-3-1',
  'veo-3-1-fast',
  'veo-3-1-lite',
  'sora-2-pro',
  'gemini-omni-flash',
  'grok-imagine-video',
  'happyhorse-1-0',
  'happyhorse-1-1',
];

/** Legacy Seedance rows declare no discrete duration list (the full picker
 *  gives them a continuous 4…max slider) — the kinobar needs a short menu. */
const SEEDANCE_FALLBACK_DURATIONS = [5, 10, 15];

interface CatalogModelRow extends LandingModel {
  kind?: string;
  maxDurationSeconds?: number | null;
  capabilities?: { durations?: unknown } | null;
}

/** Per-model «Сек» options: the catalog's discrete capability list (Veo
 *  4/6/8, Sora 4…20), else the Seedance fallback clamped to the model cap. */
function modelDurations(row: CatalogModelRow): number[] {
  const declared = row.capabilities?.durations;
  if (Array.isArray(declared)) {
    const list = declared.filter((d): d is number => typeof d === 'number' && d > 0);
    if (list.length > 0) return list;
  }
  const cap = row.maxDurationSeconds ?? 15;
  return SEEDANCE_FALLBACK_DURATIONS.filter((d) => d <= cap);
}

/** On any fetch failure the bar simply renders without the model control. */
async function getVideoModels(): Promise<LandingModel[]> {
  try {
    const res = await fetch(`${API_URL}/v1/models`, { next: { revalidate: 300 } });
    if (!res.ok) return [];
    const rows = (await res.json()) as CatalogModelRow[];
    const active = new Map(rows.filter((m) => m.kind === 'video').map((m) => [m.id, m]));
    return KINOBAR_MODEL_IDS.flatMap((id) => {
      const m = active.get(id);
      return m
        ? [
            {
              id: m.id,
              family: m.family,
              variant: m.variant,
              ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
              durations: modelDurations(m),
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

/** Public landing (v13 structure; витрина slice swapped to the LOCKED
 *  marginless mosaic 2026-07-10): nav → centered hero with the prompt bar →
 *  periwinkle FeatureTabs chapter (seamless continuation of the hero's violet
 *  floor) → tape-gallery витрина (VitrinaMosaic — editorial layout and the
 *  off-landing utilitarian-pack rule live inside it) → CTA band → footer.
 *  The витрина self-hides while its content is thin (empty-marketplace
 *  guard), so the narrative page is the floor, never a page of holes. */
export async function Landing() {
  const [packs, videoModels] = await Promise.all([getPresetPacks(), getVideoModels()]);

  return (
    <div className="seed-landing-root">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Vertov',
            url: 'https://vertov.space/',
            applicationCategory: 'MultimediaApplication',
            operatingSystem: 'Web',
            inLanguage: 'ru',
            description:
              'Сервис для создания сценариев, изображений, видео, раскадровок и монтажа с помощью ИИ.',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'RUB' },
          }),
        }}
      />
      <LandingNav />
      <main>
        <Hero models={videoModels} />
        <FeatureTabs />
        <VitrinaMosaic packs={packs} />
        <CtaBand />
      </main>
      <LandingFooter />
    </div>
  );
}
