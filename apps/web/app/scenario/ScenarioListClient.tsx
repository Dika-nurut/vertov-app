'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Plus, X } from '@/components/ui/icons';
import { displayTitle, formatRecency, type ScriptRow } from './_lib';
import { useProjectContext } from '../_components/ProjectContextProvider';
import { FeatureHint } from '../_components/FeatureHint';
import { withProjectContext } from '@/lib/project-context';
import { appendUniquePage, projectListPageUrl } from '@/lib/project-list-pagination';

interface FidelityIssue {
  code: string;
  message: string;
  detail?: string;
}
interface ImportReport {
  scriptId: string;
  lossless: boolean;
  issues: FidelityIssue[];
}
const ISSUE_LABEL: Record<string, string> = {
  'unsupported-element': 'Неподдерживаемый элемент',
  'formatting-lost': 'Потеряно форматирование',
  'structure-guessed': 'Структура определена приблизительно',
  'metadata-lost': 'Потеряны метаданные',
  'content-skipped': 'Пропущено содержимое',
};

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

export function ScenarioListClient({
  initial,
  initialCursor,
  apiUrl,
  projectContextRequested,
  requestedWorkspaceProjectId,
}: {
  initial: ScriptRow[];
  initialCursor: string | null;
  apiUrl: string;
  projectContextRequested: boolean;
  requestedWorkspaceProjectId: string | null;
}) {
  const router = useRouter();
  const projectContext = useProjectContext();
  const workspaceProject =
    projectContext.mode === 'valid' && projectContext.project.id === requestedWorkspaceProjectId
      ? projectContext.project
      : null;
  const [items, setItems] = useState<ScriptRow[]>(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await fetch(
        projectListPageUrl(apiUrl, '/v1/scripts', workspaceProject?.id ?? null, cursor),
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as {
        items: ScriptRow[];
        nextCursor: string | null;
      };
      setItems((current) => appendUniquePage(current, body.items));
      setCursor(body.nextCursor);
    } catch {
      setError('Не удалось загрузить остальные сценарии.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Удалить сценарий? Это действие необратимо.')) return;
    setItems((xs) => xs.filter((x) => x.id !== id));
    await fetch(`${apiUrl}/v1/scripts/${id}`, { method: 'DELETE', credentials: 'include' }).catch(
      () => {},
    );
  }

  async function onImport(file: File) {
    setBusy(true);
    setError(null);
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const format = IMPORT_EXT[ext] ?? 'txt';
    try {
      const params = new URLSearchParams({
        format,
        title: file.name.replace(/\.[^.]+$/, ''),
      });
      if (workspaceProject) params.set('projectId', workspaceProject.id);
      const res = await fetch(`${apiUrl}/v1/scripts/import?${params.toString()}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) throw new Error('import failed');
      const body = (await res.json()) as {
        script: ScriptRow;
        report: { lossless: boolean; issues: FidelityIssue[] };
      };
      // Lossless → straight in; lossy → show what was approximated first.
      if (body.report.lossless) {
        const href = `/scenario/${body.script.id}`;
        router.push(workspaceProject ? withProjectContext(href, workspaceProject.id) : href);
      } else {
        setReport({ scriptId: body.script.id, ...body.report });
        setBusy(false);
      }
    } catch {
      setError('Не удалось импортировать файл. Проверь формат.');
      setBusy(false);
    }
  }

  if (projectContextRequested && !workspaceProject) {
    return (
      <div className="w-full px-6 py-10" data-testid="scenario-project-blocked">
        <h1 className="font-display text-2xl font-black">Сценарии проекта</h1>
        <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">
          {projectContext.mode === 'loading'
            ? 'Проверяем проект…'
            : 'Контекст проекта недоступен. Сценарии не загружены.'}
        </p>
      </div>
    );
  }

  const newScenarioHref = workspaceProject
    ? withProjectContext('/scenario/new', workspaceProject.id)
    : '/scenario/new';

  return (
    <div className="w-full px-6 py-6 pb-16" data-testid="scenario-page">
      <FeatureHint surface="scenario-list" target="feature-scenario" />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-eyebrow mb-2.5">
            {workspaceProject ? 'Сценарии проекта' : 'Сценарий · Vertov'}
          </p>
          <h1 className="font-display text-[clamp(30px,4vw,44px)] font-black uppercase leading-[0.98] tracking-[-0.02em] text-[color:var(--color-fg)]">
            {workspaceProject ? workspaceProject.title : 'Мои'}{' '}
            <span
              className="box-decoration-clone px-1.5"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-primary-foreground)',
              }}
            >
              сценарии
            </span>
          </h1>
          <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Печатная страница твоего фильма: пиши текст, планируй сцены и советуйся с ассистентом.
            Всё сохраняется автоматически.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".fountain,.spmd,.txt,.md,.markdown,.fdx,.pdf,.docx,.highland"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImport(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="inline-flex h-11 items-center gap-2 border-[2.5px] border-[color:var(--color-line)] bg-transparent px-5 text-[13px] font-bold text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-fg)] disabled:opacity-50"
            data-testid="scenario-import"
          >
            Импорт
          </button>
          <Link
            href={newScenarioHref}
            className="glass-accent inline-flex h-11 items-center gap-2 px-6 text-[13px] font-bold disabled:opacity-50"
            data-testid="scenario-create"
            data-tour-target="feature-scenario"
          >
            <Plus size={16} />
            Новый сценарий
          </Link>
        </div>
      </div>

      {error && (
        <p
          className="mb-4 border-[2.5px] border-[color:var(--color-destructive)] px-3 py-2 text-[13px] text-[color:var(--color-destructive)]"
          data-testid="scenario-error"
        >
          {error}
        </p>
      )}

      <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((s) => (
          <li key={s.id} className="group relative" data-testid="scenario-row">
            <TitlePageCard row={s} workspaceProjectId={workspaceProject?.id ?? null} />
            <button
              onClick={() => remove(s.id)}
              aria-label="Удалить сценарий"
              className="absolute right-2 top-2 z-10 border-[2px] border-[color:var(--color-paper-ink)] bg-[color:var(--color-paper)] px-2 py-0.5 text-[13px] font-bold text-[color:var(--color-paper-ink)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100"
              data-testid="scenario-delete"
            >
              <X size={12} aria-hidden />
            </button>
          </li>
        ))}

        {/* dashed ghost card — always the last cell */}
        <li>
          <Link
            href={newScenarioHref}
            data-testid="scenario-create-ghost"
            className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-2 border-[2.5px] border-dashed border-[color:var(--color-line-soft)] text-center text-[color:var(--color-muted-foreground)] transition-colors hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] disabled:opacity-50"
          >
            <span className="font-mono text-2xl leading-none">+</span>
            <span className="font-mono text-[11px] uppercase tracking-widest">Новый сценарий</span>
          </Link>
        </li>
      </ul>
      {cursor && (
        <button
          type="button"
          data-testid="scenario-load-more"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mx-auto mt-6 flex h-10 items-center gap-2 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-5 text-[13px] font-bold shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-50"
        >
          {loadingMore && <Loader2 size={14} className="seed-spin" />}
          Показать ещё
        </button>
      )}

      {items.length === 0 && (
        <p className="mt-4 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
          Начни с чистого листа или импортируй .fountain · .fdx · .pdf · .docx — выбери путь прямо
          на листе.
        </p>
      )}

      {report && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--color-overlay)] p-4"
          data-testid="scenario-import-report"
        >
          <div className="w-full max-w-lg border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] shadow-[6px_6px_0_0_var(--color-shadow)]">
            <div className="border-b-[2px] border-[color:var(--color-line-soft)] px-5 py-4">
              <p className="label-eyebrow text-[color:var(--color-muted-foreground)]">Импорт</p>
              <h2 className="font-display text-lg font-black">Файл импортирован с оговорками</h2>
              <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
                Ничего не потеряно молча — вот что было определено приблизительно:
              </p>
            </div>
            <ul className="max-h-72 overflow-auto px-5 py-3">
              {report.issues.map((iss, i) => (
                <li
                  key={i}
                  className="border-b-[1.5px] border-[color:var(--color-line-soft)] py-2 last:border-0"
                >
                  <span className="font-mono text-[11px] uppercase tracking-wide text-[color:var(--color-accent2)]">
                    {ISSUE_LABEL[iss.code] ?? iss.code}
                  </span>
                  <p className="text-[13px]">{iss.message}</p>
                  {iss.detail && (
                    <p className="mt-0.5 truncate font-mono text-[13px] text-[color:var(--color-muted-foreground)]">
                      {iss.detail}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2 border-t-[2px] border-[color:var(--color-line-soft)] px-5 py-4">
              <button
                onClick={() => {
                  const href = `/scenario/${report.scriptId}`;
                  router.push(
                    workspaceProject ? withProjectContext(href, workspaceProject.id) : href,
                  );
                }}
                className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2 text-[13px] font-bold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)]"
                data-testid="scenario-import-open"
              >
                Открыть сценарий
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A script as a miniature paper title page (spec §1). */
function TitlePageCard({
  row,
  workspaceProjectId,
}: {
  row: ScriptRow;
  workspaceProjectId: string | null;
}) {
  const firstScene = row.stats?.firstScene ?? null;
  const title = displayTitle(row.title, firstScene);
  const hasTitle = title !== '';
  const pages = row.stats?.pages ?? 0;
  const scenes = row.stats?.scenes ?? 0;

  const meta = [
    pages > 0 ? `${pages} стр` : 'пусто',
    scenes > 0 ? `сцена ${scenes}` : null,
    formatRecency(row.updatedAt),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Link
      href={
        workspaceProjectId
          ? withProjectContext(`/scenario/${row.id}`, workspaceProjectId)
          : `/scenario/${row.id}`
      }
      data-testid="scenario-card"
      className="flex aspect-[3/4] flex-col border-[2px] border-[color:var(--color-paper-ink)] bg-[color:var(--color-paper)] text-[color:var(--color-paper-ink)] shadow-[5px_5px_0_0_var(--color-shadow)] transition-transform hover:-translate-x-0.5 hover:-translate-y-1 hover:shadow-[7px_8px_0_0_var(--color-shadow)] focus-visible:-translate-y-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
    >
      <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
        <p
          className="font-mono text-[13px] font-bold uppercase leading-snug tracking-wide"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {hasTitle ? title : 'Без названия'}
        </p>
        <p className="mt-2 font-mono text-[11px] tracking-wide text-[color:var(--color-paper-ink)]/55">
          {row.author ? `автор: ${row.author}` : 'без названия · рабочее'}
        </p>
      </div>
      <p className="border-t-[1.5px] border-[color:var(--color-paper-ink)]/12 px-4 py-2.5 text-center font-mono text-[11px] tracking-wide text-[color:var(--color-paper-ink)]/55">
        {meta}
      </p>
    </Link>
  );
}
