// Library audio panel — music + voiceover lines (extracted from
// StudioClient.tsx, split 5g/N). uploadAudio stays in StudioClient (it
// touches project state); audio state/setters + busy injected.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { assetSrc } from '@/lib/asset-src';
import { Check, Loader2, Mic, Music, Pause, Play, Plus, Search, Sparkles, X } from '../_icons';
import { AudioLine } from '../_components/AudioLine';
import { Seg } from '../_kit/controls';
import { mmss } from '../_model';
import type { TAudio } from '../_model';
import { analyzeVoiceoverDucking } from '../../../lib/ducking';

/** «Автодакинг» — one button that analyzes the voiceover and dips the music
 * under speech. Shown only when BOTH lines exist. The detected windows are
 * shifted into project-timeline seconds by the voiceover's own `fromSec`. */
function DuckControl({
  music,
  voiceover,
  setMusic,
}: {
  music: TAudio;
  voiceover: TAudio;
  setMusic: Dispatch<SetStateAction<TAudio | null>>;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const duck = music.duck;
  // Read at completion time (not the `voiceover` prop closed over by `analyze`)
  // so a voiceover edit/swap mid-decode is visible to the async callback below.
  const voiceoverRef = useRef(voiceover);
  voiceoverRef.current = voiceover;

  const analyze = async () => {
    setAnalyzing(true);
    setError(null);
    // Snapshot both lines' identity at the START of the decode — completion
    // only applies if music AND voiceover still match these, otherwise the
    // in-flight result belongs to a track/voiceover that's no longer current.
    const musicUrl = music.url;
    const voUrl = voiceover.url;
    const voFrom = voiceover.fromSec;
    try {
      const result = await analyzeVoiceoverDucking(voUrl);
      const segments = result.segments.map((s) => ({
        fromSec: s.fromSec + voFrom,
        toSec: s.toSec + voFrom,
      }));
      if (segments.length === 0) {
        const vo = voiceoverRef.current;
        if (vo.url === voUrl && vo.fromSec === voFrom) {
          setError('Речь в озвучке не распознана — приглушать нечего.');
        }
        return;
      }
      setMusic((m) => {
        if (!m || m.url !== musicUrl) return m;
        const vo = voiceoverRef.current;
        if (vo.url !== voUrl || vo.fromSec !== voFrom) return m;
        return { ...m, duck: { db: result.db, segments, sourceKey: `${voUrl}@${voFrom}` } };
      });
    } catch (e) {
      console.warn('[ducking] analysis failed', e);
      const vo = voiceoverRef.current;
      if (vo.url === voUrl && vo.fromSec === voFrom) {
        setError('Не удалось разобрать озвучку. Попробуй ещё раз.');
      }
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="glass space-y-2 rounded-[var(--radius-md)] p-3">
      <div className="flex items-center gap-2 text-[13px] text-[color:var(--color-fg)]">
        <span className="text-[color:var(--color-accent)]">
          <Sparkles size={15} />
        </span>
        <span>Приглушать под озвучку</span>
      </div>
      {duck ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] text-[color:var(--color-muted-foreground)]">
            {duck.segments.length} {pluralUchastok(duck.segments.length)} · {duck.db > 0 ? '+' : ''}
            {duck.db} dB
          </span>
          <button
            type="button"
            data-testid="duck-reset"
            onClick={() => setMusic({ ...music, duck: undefined })}
            className="inline-flex items-center gap-1 text-[13px] text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]"
          >
            <X size={13} /> Сбросить
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="duck-analyze"
          disabled={analyzing}
          onClick={() => void analyze()}
          className="glass glass-hover w-full rounded-[var(--radius-sm)] py-2 text-[13px] text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-fg)] disabled:opacity-40"
        >
          {analyzing ? 'Разбираю озвучку…' : 'Разобрать озвучку'}
        </button>
      )}
      {error && <p className="text-[11px] text-[color:var(--color-destructive)]">{error}</p>}
    </div>
  );
}

/** Russian plural for «участок» (1 участок · 2 участка · 5 участков). */
function pluralUchastok(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'участок';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'участка';
  return 'участков';
}

type SoundKind = 'music' | 'sfx';

interface SoundItem {
  id: string;
  title: string;
  author: string;
  durSec: number;
  previewUrl: string;
  license: string;
  source: string;
}

/** Mood chips → Freesound search terms (English catalog, Russian UI). */
const MOOD_CHIPS: { label: string; term: string }[] = [
  { label: 'Энергия', term: 'energetic' },
  { label: 'Спокойно', term: 'calm' },
  { label: 'Бит', term: 'beat' },
  { label: 'Кино', term: 'cinematic' },
  { label: 'Лофай', term: 'lofi' },
];

const SEARCH_DEBOUNCE_MS = 350;

export function AudioLibraryPanel({
  music,
  setMusic,
  voiceover,
  setVoiceover,
  addSfx,
  busy,
  uploadAudio,
  apiUrl,
}: {
  music: TAudio | null;
  setMusic: Dispatch<SetStateAction<TAudio | null>>;
  voiceover: TAudio | null;
  setVoiceover: (value: TAudio | null) => void;
  /** Drop a sound-effect clip at the playhead. */
  addSfx: (url: string, name: string, durSec?: number) => void;
  busy: boolean;
  uploadAudio: (file: File) => Promise<TAudio | null>;
  apiUrl: string;
}) {
  const [kind, setKind] = useState<SoundKind>('music');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [items, setItems] = useState<SoundItem[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<'unconfigured' | 'network' | null>(null);
  // Picked ids are namespaced by kind (`music:123` / `sfx:123`) since the two
  // catalogs share the same provider id space.
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const [pickingKeys, setPickingKeys] = useState<Set<string>>(new Set());
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  // ONE shared preview element — switching rows tears down the old one so two
  // previews never overlap.
  const previewRef = useRef<HTMLAudioElement | null>(null);
  // Bumped per fired search request (and on kind switch); a response only
  // applies state if its generation is still current — guards against an
  // older slow response overwriting newer results.
  const searchGenRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const runSearch = useCallback(
    async (pageNum: number, append: boolean) => {
      const gen = ++searchGenRef.current;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setItems([]);
        setNextPage(null);
      }
      setError(null);
      try {
        const params = new URLSearchParams({ kind, page: String(pageNum) });
        const q = debouncedQuery.trim();
        if (q) params.set('q', q);
        const res = await fetch(`${apiUrl}/v1/studio/sounds/search?${params}`, {
          credentials: 'include',
        });
        if (gen !== searchGenRef.current) return; // stale — a newer search superseded this one
        if (res.status === 503) {
          setError('unconfigured');
          return;
        }
        if (!res.ok) {
          setError('network');
          return;
        }
        const body = (await res.json()) as { items?: SoundItem[]; nextPage?: number | null };
        if (gen !== searchGenRef.current) return;
        setItems((prev) => (append ? [...prev, ...(body.items ?? [])] : (body.items ?? [])));
        setNextPage(body.nextPage ?? null);
      } catch {
        if (gen === searchGenRef.current) setError('network');
      } finally {
        if (gen === searchGenRef.current) {
          if (append) setLoadingMore(false);
          else setLoading(false);
        }
      }
    },
    [apiUrl, kind, debouncedQuery],
  );

  // Switching Музыка/Эффекты stops whatever preview was playing — it no
  // longer belongs to the visible list — and bumps the generation so any
  // in-flight search for the old kind can't overwrite the new tab's state.
  // Declared (and thus run) before the search-trigger effect below so its
  // bump precedes runSearch's own bump for the same kind change.
  useEffect(() => {
    searchGenRef.current++;
    previewRef.current?.pause();
    setPlayingId(null);
    setProgress(0);
  }, [kind]);

  useEffect(() => {
    void runSearch(1, false);
  }, [runSearch]);

  useEffect(() => () => previewRef.current?.pause(), []);

  function togglePreview(item: SoundItem) {
    if (playingId === item.id) {
      previewRef.current?.pause();
      setPlayingId(null);
      return;
    }
    previewRef.current?.pause();
    const audio = new Audio(assetSrc(item.previewUrl));
    previewRef.current = audio;
    setProgress(0);
    audio.addEventListener('timeupdate', () => {
      setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
    });
    audio.addEventListener('ended', () => {
      setPlayingId(null);
      setProgress(0);
    });
    audio.addEventListener('error', () => setPlayingId(null));
    setPlayingId(item.id);
    void audio.play().catch(() => setPlayingId(null));
  }

  async function pickItem(item: SoundItem) {
    const key = `${kind}:${item.id}`;
    if (addedKeys.has(key) || pickingKeys.has(key)) return;
    setPickingKeys((prev) => new Set(prev).add(key));
    try {
      const res = await fetch(`${apiUrl}/v1/studio/sounds/pick`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, id: item.id }),
      });
      if (res.status === 403) {
        const body = await res.json().catch(() => null);
        if ((body as { error?: string } | null)?.error === 'signup_required') {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
      }
      if (!res.ok) return;
      const picked = (await res.json()) as { url: string; name: string; durSec: number };
      if (kind === 'music') {
        setMusic({
          url: picked.url,
          name: picked.name,
          gainDb: 0,
          fromSec: 0,
          fadeIn: false,
          fadeOut: false,
        });
      } else {
        addSfx(picked.url, picked.name, picked.durSec);
      }
      setAddedKeys((prev) => new Set(prev).add(key));
    } catch {
      /* network blip — the add button just returns to idle so the user can retry */
    } finally {
      setPickingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <section data-testid="lib-audio" className="space-y-3">
      <p className="label-eyebrow mb-1">Аудио</p>
      <AudioLine
        label="Музыка"
        icon={<Music size={15} />}
        value={music}
        accept="audio/*"
        busy={busy}
        onPick={(f) => void uploadAudio(f).then((a) => a && setMusic(a))}
        onChange={setMusic}
        onRemove={() => setMusic(null)}
      />
      {/* Auto-ducking needs both a music bed and a voiceover to duck under. */}
      {music && voiceover && (
        <DuckControl music={music} voiceover={voiceover} setMusic={setMusic} />
      )}
      <AudioLine
        label="Озвучка"
        icon={<Mic size={15} />}
        value={voiceover}
        accept="audio/*"
        busy={busy}
        onPick={(f) => void uploadAudio(f).then((a) => a && setVoiceover(a))}
        onChange={setVoiceover}
        onRemove={() => setVoiceover(null)}
      />

      <hr className="my-4 h-[2px] border-0 bg-[color:var(--color-line)] opacity-55" />

      <section className="space-y-2.5">
        <p className="label-eyebrow mb-1">Каталог</p>

        <div data-testid="catalog-tabs">
          <Seg
            options={[
              { id: 'music', label: 'Музыка' },
              { id: 'sfx', label: 'Эффекты' },
            ]}
            value={kind}
            onChange={setKind}
          />
        </div>

        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--color-faint)]"
          />
          <input
            type="search"
            data-testid="catalog-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={kind === 'music' ? 'Найти музыку…' : 'Найти звук…'}
            className="h-[34px] w-full rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] pl-[30px] pr-2 text-[13px] text-[color:var(--color-fg)] outline-none ring-1 ring-inset ring-[color:var(--color-line)]/15 placeholder:text-[color:var(--color-faint)] focus:border-[color:var(--color-accent)]"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {MOOD_CHIPS.map((c) => {
            const active = query.trim().toLowerCase() === c.term;
            return (
              <button
                key={c.term}
                type="button"
                onClick={() => setQuery(c.term)}
                className={
                  'rounded-[var(--radius-sm)] border-[1.5px] px-2.5 py-1 text-[11px] transition-colors ' +
                  (active
                    ? 'border-[color:var(--color-accent)] bg-[rgba(var(--accent-rgb),0.1)] text-[color:var(--color-accent)]'
                    : 'border-[color:var(--color-line)]/28 text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                }
              >
                {c.label}
              </button>
            );
          })}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-6 text-[color:var(--color-faint)]">
            <Loader2 size={16} className="seed-spin" />
          </div>
        ) : error === 'unconfigured' ? (
          <p className="rounded-[var(--radius-sm)] border-[1.5px] border-dashed border-[color:var(--color-line)]/55 p-3 text-[11px] leading-relaxed text-[color:var(--color-faint)]">
            Каталог не настроен — добавь ключ Freesound на сервере (FREESOUND_API_KEY).
          </p>
        ) : error === 'network' ? (
          <div className="rounded-[var(--radius-sm)] border-[1.5px] border-dashed border-[color:var(--color-line)]/55 p-3 text-[11px] leading-relaxed text-[color:var(--color-faint)]">
            Не удалось загрузить каталог.{' '}
            <button
              type="button"
              onClick={() => void runSearch(1, false)}
              className="text-[color:var(--color-accent)] hover:underline"
            >
              Повторить
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="py-2 text-[11px] text-[color:var(--color-faint)]">Ничего не нашлось.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {items.map((item) => {
              const key = `${kind}:${item.id}`;
              const isPlaying = playingId === item.id;
              const isAdded = addedKeys.has(key);
              const isPicking = pickingKeys.has(key);
              return (
                <div
                  key={item.id}
                  data-testid="catalog-row"
                  className={
                    'relative flex items-center gap-2 rounded-[var(--radius-sm)] border-[1.5px] px-2 py-1.5 pb-2 ' +
                    (isPlaying
                      ? 'border-[color:var(--color-accent)] bg-[color:var(--color-surface2)]'
                      : 'border-[color:var(--color-line)]/55') +
                    (isAdded ? ' opacity-70' : '')
                  }
                >
                  <button
                    type="button"
                    data-testid="catalog-play"
                    aria-label={isPlaying ? 'Пауза' : 'Прослушать'}
                    onClick={() => togglePreview(item)}
                    className={
                      'grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[var(--radius-xs)] border-[1.5px] transition-colors ' +
                      (isPlaying
                        ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                        : 'border-[color:var(--color-line)] bg-[color:var(--color-surface2)] text-[color:var(--color-accent)]')
                    }
                  >
                    {isPlaying ? <Pause size={10} /> : <Play size={10} />}
                  </button>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[13px] text-[color:var(--color-fg)]">
                      {item.title}
                    </span>
                    <span className="truncate text-[11px] text-[color:var(--color-faint)]">
                      {item.author} · {mmss(item.durSec)}
                      {isAdded ? ' · в проекте' : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid="catalog-add"
                    disabled={isAdded || isPicking}
                    aria-label={isAdded ? 'Уже добавлено' : 'Добавить'}
                    onClick={() => void pickItem(item)}
                    className={
                      'grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-xs)] border-[1.5px] transition-colors ' +
                      (isAdded
                        ? 'border-[rgba(119,215,153,0.45)] text-[color:var(--color-positive)]'
                        : 'border-[color:var(--color-line)] text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]')
                    }
                  >
                    {isPicking ? (
                      <Loader2 size={12} className="seed-spin" />
                    ) : isAdded ? (
                      <Check size={12} />
                    ) : (
                      <Plus size={12} />
                    )}
                  </button>
                  {isPlaying && (
                    <span className="absolute bottom-[3px] left-2 right-2 h-[2px] bg-[rgba(141,118,246,0.22)]">
                      <span
                        className="block h-full bg-[color:var(--color-accent)]"
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {nextPage != null && !loading && (
          <button
            type="button"
            data-testid="catalog-more"
            disabled={loadingMore}
            onClick={() => void runSearch(nextPage, true)}
            className="press-inset w-full rounded-[var(--radius-sm)] border-[1.5px] border-[color:var(--color-line)]/40 py-1.5 text-[11px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-fg)] disabled:opacity-50"
          >
            {loadingMore ? 'Загрузка…' : 'Ещё'}
          </button>
        )}

        {items.length > 0 && (
          <p className="mt-0.5 border-t border-[color:var(--color-line-soft)] pt-2 text-[11px] text-[color:var(--color-faint)]">
            Freesound (CC0) · бесплатно · без атрибуции
          </p>
        )}
      </section>

      {/* AI voice generation is parked; manual upload remains available above. */}
      <p className="text-[11px] leading-relaxed text-[color:var(--color-faint)]">
        Не нашёл нужное — загрузи свой файл выше. AI-озвучка временно отключена.
      </p>
    </section>
  );
}
