'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileText, Loader2 } from '@/components/ui/icons';
import { STRUCTURIZE_CREDITS, type ScenarioStructurizeResult } from '@seed/shared';
import {
  analyticsErrorBucket,
  countBucket,
  trackEvent,
  PlausibleEvent,
} from '../../_components/PlausibleEvents';
import { withProjectContext } from '@/lib/project-context';

const IMPORT_EXT: Record<string, string> = {
  fountain: 'fountain',
  spmd: 'spmd',
  txt: 'txt',
  md: 'md',
  markdown: 'markdown',
  fdx: 'fdx',
  pdf: 'pdf',
  docx: 'docx',
  highland: 'highland',
};

const FORMAT_LABEL: Record<ScenarioStructurizeResult['format'], string> = {
  film: 'Фильм',
  social: 'Соцвидео',
  ad: 'Реклама',
  sketch: 'Скетч',
};

type ApiError = { error?: string; reason?: string; message?: string };

function stableKey(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readError(response: Response): Promise<ApiError> {
  return (await response.json().catch(() => ({}))) as ApiError;
}

function errorCopy(
  error: ApiError,
  phase: 'create' | 'structure' | 'import',
  isAnonymous: boolean,
): string {
  if (phase === 'import' || error.error === 'import_failed') {
    return 'Не удалось разобрать файл. Проверь формат и попробуй ещё раз.';
  }
  if (error.error === 'insufficient_credits') {
    return `Для структуры нужно ${STRUCTURIZE_CREDITS} кредита. Пополни баланс и повтори — черновик уже сохранён.`;
  }
  if (error.error === 'signup_required') {
    // Authed viewers never get a login CTA — point at pricing/balance instead.
    if (!isAnonymous) {
      return 'Пробный разбор уже использован. Проверь баланс или выбери тариф — черновик уже сохранён.';
    }
    if (error.reason === 'free_structurize_in_progress') {
      return 'Разбор уже выполняется на этом устройстве. Дождись завершения или войди, чтобы продолжить без потери черновика.';
    }
    return 'Бесплатный пробный разбор уже использован на этом устройстве. Войди, чтобы продолжить без потери черновика.';
  }
  if (error.error === 'structurize_rate_limited') {
    return 'Слишком много попыток подряд. Подожди немного и повтори.';
  }
  if (error.error === 'daily_spend_cap_exceeded') {
    return 'Редактор временно занят. Черновик сохранён — попробуй собрать структуру позже.';
  }
  if (error.error === 'structurize_unusable' || error.error === 'structurize_failed') {
    return 'Не удалось собрать устойчивую структуру. Черновик сохранён — попробуй ещё раз.';
  }
  if (phase === 'create') return 'Не удалось сохранить черновик. Попробуй ещё раз.';
  return error.message || 'Что-то пошло не так. Черновик сохранён, попробуй ещё раз.';
}

function destination(id: string, projectId: string | null): string {
  const href = `/scenario/${encodeURIComponent(id)}`;
  return projectId ? withProjectContext(href, projectId) : href;
}

function BriefPreview({ result }: { result: ScenarioStructurizeResult }) {
  const { brief } = result;
  const rows = [
    brief.goal ? ['Цель', brief.goal] : null,
    brief.audience ? ['Аудитория', brief.audience] : null,
    brief.tone ? ['Тон', brief.tone] : null,
    brief.cta ? ['CTA', brief.cta] : null,
  ].filter((row): row is [string, string] => Boolean(row));

  return (
    <section
      className="border-[2px] border-[color:var(--color-paper-ink)] bg-white shadow-[4px_4px_0_0_var(--color-accent)]"
      data-testid="scenario-brief-preview"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--color-paper-ink)]/20 px-3 py-2.5">
        <span className="bg-[color:var(--color-accent2)] px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-paper-ink)]">
          Предположение Вертова
        </span>
        <span className="font-mono text-[11px] text-[color:var(--color-paper-ink)]/55">
          черновик брифа — всё можно поправить
        </span>
      </div>
      <div className="flex flex-wrap gap-0 px-3 pt-3">
        <span className="border-[2px] border-[color:var(--color-paper-ink)] px-2.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.05em] text-[color:var(--color-paper-ink)]">
          {FORMAT_LABEL[result.format]}
        </span>
        {brief.durationSeconds && (
          <span className="-ml-[2px] border-[2px] border-[color:var(--color-paper-ink)] px-2.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.05em] text-[color:var(--color-paper-ink)]">
            {brief.durationSeconds} сек
          </span>
        )}
        {brief.platform && (
          <span className="-ml-[2px] border-[2px] border-[color:var(--color-paper-ink)] px-2.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.05em] text-[color:var(--color-paper-ink)]">
            {brief.platform}
          </span>
        )}
      </div>
      {rows.length > 0 && (
        <dl className="space-y-1 px-3 pb-3 pt-2.5 text-[13px] leading-relaxed text-[color:var(--color-paper-ink)]/70">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="inline font-semibold text-[color:var(--color-paper-ink)]">{label}:</dt>{' '}
              <dd className="inline">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function ResultSheet({
  result,
  onOpen,
}: {
  result: ScenarioStructurizeResult;
  onOpen: () => void;
}) {
  return (
    <div
      className="w-full max-w-3xl bg-[color:var(--color-paper)] px-5 py-8 text-[color:var(--color-paper-ink)] shadow-[7px_7px_0_0_var(--color-accent)] sm:px-10 sm:py-10"
      data-testid="scenario-structure-result"
    >
      <p className="mb-5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-paper-ink)]/45">
        Структура готова
      </p>
      <BriefPreview result={result} />
      <div className="mt-7">
        <p className="mb-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-paper-ink)]/50">
          Структура · {result.outline.beats.length}{' '}
          {result.outline.beats.length === 1 ? 'бит' : 'битов'}
        </p>
        <ol className="space-y-0" data-testid="scenario-beats-preview">
          {result.outline.beats.map((beat, index) => (
            <li
              key={beat.id}
              className="flex gap-2.5 border-[2px] border-[color:var(--color-paper-ink)] bg-white px-3 py-2.5 [&+li]:-mt-[2px]"
              data-testid="scenario-beat"
            >
              <span className="w-5 shrink-0 pt-0.5 font-mono text-[11px] text-[color:var(--color-paper-ink)]/45">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block font-mono text-[11px] uppercase tracking-[0.06em]">
                  {beat.title}
                </strong>
                <span className="mt-1 block text-[13px] leading-relaxed text-[color:var(--color-paper-ink)]/70">
                  {beat.summary || 'Структурный ход без дополнительного описания.'}
                </span>
              </span>
              {beat.durationSeconds && (
                <span className="shrink-0 pt-0.5 font-mono text-[11px] text-[color:var(--color-paper-ink)]/45">
                  {beat.durationSeconds} с
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
      {result.question && (
        <p
          className="mt-4 border-l-[3px] border-[color:var(--color-accent)] px-3 text-[13px] leading-relaxed text-[color:var(--color-paper-ink)]/70"
          data-testid="scenario-clarifying-question"
        >
          <strong className="mr-1">Один вопрос:</strong>
          {result.question}
        </p>
      )}
      <div className="mt-7 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center gap-2 border-[2px] border-[color:var(--color-paper-ink)] bg-[color:var(--color-paper-ink)] px-4 py-2.5 text-[13px] font-extrabold text-[color:var(--color-paper)] shadow-[4px_4px_0_0_var(--color-accent)]"
          data-testid="scenario-open-editor"
        >
          Начать писать <ArrowRight size={14} />
        </button>
        <span className="text-[13px] text-[color:var(--color-paper-ink)]/50">
          Бриф и биты уже сохранены в проекте.
        </span>
      </div>
    </div>
  );
}

export function ScenarioIntentStart({
  apiUrl,
  projectId,
  isAnonymous,
}: {
  apiUrl: string;
  projectId: string | null;
  isAnonymous: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const createKeyRef = useRef(stableKey('scenario-create'));
  const structurizeKeyRef = useRef(stableKey('scenario-structurize'));
  const [idea, setIdea] = useState('');
  const [directMode, setDirectMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'structuring' | 'importing'>('idle');
  const [error, setError] = useState<ApiError | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [result, setResult] = useState<ScenarioStructurizeResult | null>(null);

  const routeToScript = (id: string) => {
    router.replace(destination(id, projectId));
  };

  async function createDraft(source: string): Promise<string | null> {
    const response = await fetch(`${apiUrl}/v1/scripts`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: createKeyRef.current,
        fountain: source,
        ...(projectId ? { projectId } : {}),
      }),
    });
    if (!response.ok) {
      setError(await readError(response));
      return null;
    }
    const row = (await response.json()) as { id?: string };
    if (!row.id) {
      setError({ error: 'invalid_create_response' });
      return null;
    }
    setCreatedId(row.id);
    return row.id;
  }

  async function structurize(id: string, source: string): Promise<void> {
    setPhase('structuring');
    const response = await fetch(`${apiUrl}/v1/scripts/${encodeURIComponent(id)}/structurize`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: source, idempotencyKey: structurizeKeyRef.current }),
    });
    if (!response.ok) {
      const body = await readError(response);
      setError(body);
      trackEvent(PlausibleEvent.scenarioStructurizeFailed, {
        result: analyticsErrorBucket(body.error ?? 'http_error'),
        free: isAnonymous,
      });
      return;
    }
    const body = (await response.json()) as ScenarioStructurizeResult;
    if (!body.format || !body.brief || !body.outline?.beats?.length) {
      setError({ error: 'structurize_unusable' });
      trackEvent(PlausibleEvent.scenarioStructurizeFailed, {
        result: analyticsErrorBucket('structurize_unusable'),
        free: isAnonymous,
      });
      return;
    }
    setResult(body);
    trackEvent(PlausibleEvent.scenarioStructurizeCompleted, {
      format: body.format,
      beats: countBucket(body.outline.beats.length),
      free: isAnonymous,
    });
  }

  async function submit(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const source = idea.trim();
    if (!source || busy) return;
    setBusy(true);
    setError(null);
    setPhase('saving');
    trackEvent(PlausibleEvent.scenarioIntentSubmitted, {
      direct: directMode,
      free: isAnonymous,
    });
    const id = await createDraft(source);
    if (!id) {
      setBusy(false);
      setPhase('idle');
      return;
    }
    if (!directMode) await structurize(id, source);
    else routeToScript(id);
    setBusy(false);
    if (directMode) setPhase('idle');
  }

  async function onImport(file: File): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPhase('importing');
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const format = IMPORT_EXT[ext] ?? 'txt';
    const params = new URLSearchParams({
      format,
      title: file.name.replace(/\.[^.]+$/, ''),
    });
    if (projectId) params.set('projectId', projectId);
    const response = await fetch(`${apiUrl}/v1/scripts/import?${params.toString()}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    }).catch(() => null);
    if (!response || !response.ok) {
      setError(response ? await readError(response) : { error: 'import_failed' });
      setBusy(false);
      setPhase('idle');
      return;
    }
    const body = (await response.json()) as { script?: { id?: string } };
    if (!body.script?.id) {
      setError({ error: 'import_failed' });
      setBusy(false);
      setPhase('idle');
      return;
    }
    routeToScript(body.script.id);
  }

  const copy = error
    ? errorCopy(
        error,
        phase === 'importing' ? 'import' : phase === 'saving' ? 'create' : 'structure',
        isAnonymous,
      )
    : null;
  const loginHref = `/login?next=${encodeURIComponent(destination(createdId ?? '', projectId))}`;

  return (
    <div className="w-full px-4 py-8 pb-16 sm:px-6 sm:py-12" data-testid="scenario-new-page">
      <div className="mx-auto flex min-h-[min(760px,calc(100dvh-150px))] w-full max-w-5xl items-center justify-center">
        {result ? (
          <ResultSheet result={result} onOpen={() => createdId && routeToScript(createdId)} />
        ) : (
          <section className="w-full max-w-3xl bg-[color:var(--color-paper)] px-5 py-10 text-[color:var(--color-paper-ink)] shadow-[7px_7px_0_0_var(--color-accent)] sm:px-16 sm:py-16">
            <p className="mb-6 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-paper-ink)]/45">
              Вёртов · Сценарий
            </p>
            <h1 className="font-mono text-[clamp(28px,5vw,42px)] font-bold leading-tight tracking-[-0.03em]">
              {directMode ? 'Начните с первой сцены' : 'Что снимаем?'}
            </h1>
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[color:var(--color-paper-ink)]/65">
              {directMode
                ? 'Пишите как в обычном сценарии. Вертов сохранит лист, а структуру можно собрать позже.'
                : 'Опишите замысел своими словами — Вертов определит формат, соберёт структуру и поможет дописать до готового сценария.'}
            </p>
            <form onSubmit={(event) => void submit(event)} className="mt-7">
              <div className="border-[2px] border-[color:var(--color-paper-ink)] bg-white shadow-[5px_5px_0_0_var(--color-accent)]">
                <textarea
                  value={idea}
                  onChange={(event) => {
                    setIdea(event.target.value);
                    // A changed idea is a new logical structurize — rotate so a
                    // retry can't replay the previous text under the old key.
                    structurizeKeyRef.current = stableKey('scenario-structurize');
                  }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  autoFocus
                  rows={7}
                  maxLength={8000}
                  placeholder={
                    directMode
                      ? 'ИНТ. МЕСТО — ВРЕМЯ\n\nНачните сцену…'
                      : 'Например: реклама сервиса доставки, секунд 30, для соцсетей — смешно и без пафоса, в конце промокод.\n\nИли: короткометражка на десять минут, тихая драма — отец и сын за одним ужином говорят о разном.'
                  }
                  className="min-h-[180px] w-full resize-y bg-transparent px-4 py-4 font-mono text-[13px] leading-relaxed text-[color:var(--color-paper-ink)] outline-none placeholder:text-[color:var(--color-paper-ink)]/35"
                  data-testid="scenario-intent"
                  aria-label="Опишите замысел сценария"
                />
                <div className="flex flex-wrap items-center gap-3 border-t border-[color:var(--color-paper-ink)]/20 px-3 py-2.5">
                  <button
                    type="submit"
                    disabled={busy || !idea.trim()}
                    className="inline-flex items-center gap-2 border-[2px] border-[color:var(--color-paper-ink)] bg-[color:var(--color-paper-ink)] px-3.5 py-2 text-[13px] font-extrabold text-[color:var(--color-paper)] shadow-[3px_3px_0_0_var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="scenario-structurize"
                  >
                    {busy ? <Loader2 size={15} className="seed-spin" /> : <ArrowRight size={15} />}
                    {directMode ? 'Открыть редактор' : 'Собрать структуру'}
                    {!directMode && (
                      <span className="font-mono text-[11px] font-normal opacity-60">
                        {isAnonymous ? 'бесплатно' : `${STRUCTURIZE_CREDITS} кр.`}
                      </span>
                    )}
                  </button>
                  <span className="text-[13px] text-[color:var(--color-paper-ink)]/45">
                    Ctrl+Enter
                  </span>
                </div>
              </div>
            </form>
            {copy && (
              <div
                className="mt-5 border-[2px] border-[color:var(--color-destructive)] px-3 py-3 text-[13px] leading-relaxed text-[color:var(--color-destructive)]"
                data-testid="scenario-new-error"
              >
                <p>{copy}</p>
                {error?.error === 'signup_required' && isAnonymous && (
                  <Link className="mt-2 inline-block font-semibold underline" href={loginHref}>
                    Войти и продолжить →
                  </Link>
                )}
                {error?.error === 'signup_required' && !isAnonymous && (
                  <Link className="mt-2 inline-block font-semibold underline" href="/pricing">
                    Выбрать тариф →
                  </Link>
                )}
              </div>
            )}
            <div className="mt-5 border-[2px] border-dashed border-[color:var(--color-paper-ink)]/25 px-3.5 py-3 text-[13px] leading-relaxed text-[color:var(--color-paper-ink)]/65">
              <b className="text-[color:var(--color-paper-ink)]">Уже есть сценарий?</b>{' '}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="underline decoration-dotted underline-offset-4"
                data-testid="scenario-import"
              >
                Загрузите файл
              </button>{' '}
              или вставьте текст в поле выше.
              <span className="mt-1 block font-mono text-[11px] uppercase tracking-[0.05em] text-[color:var(--color-paper-ink)]/40">
                Fountain · FDX · PDF · DOCX · TXT · MD · Highland
              </span>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-[color:var(--color-paper-ink)]/45">
              {!directMode ? (
                <button
                  type="button"
                  onClick={() => setDirectMode(true)}
                  className="underline decoration-dotted underline-offset-4"
                  data-testid="scenario-direct-start"
                >
                  или просто начните печатать сценарий на листе
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setDirectMode(false)}
                  className="underline decoration-dotted underline-offset-4"
                >
                  Вернуться к сборке структуры
                </button>
              )}
              {projectId && (
                <Link
                  href={withProjectContext('/scenario', projectId)}
                  className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-4"
                >
                  К сценариям проекта <FileText size={12} />
                </Link>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".fountain,.spmd,.txt,.md,.markdown,.fdx,.pdf,.docx,.highland"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onImport(file);
                event.target.value = '';
              }}
            />
            {busy && (
              <p
                className="mt-4 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-[color:var(--color-paper-ink)]/45"
                data-testid="scenario-new-status"
              >
                <Loader2 size={13} className="seed-spin" />
                {phase === 'importing'
                  ? 'Разбираем файл…'
                  : phase === 'structuring'
                    ? 'Собираем структуру…'
                    : 'Сохраняем черновик…'}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
