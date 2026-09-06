'use client';

import { useEffect, useRef, useState } from 'react';
import { File, Upload } from '@/components/ui/icons';
import { CANON_MANUAL_NOTES_ENABLED } from '../canon-flags';
import type { MaterialsList, MemoryNote } from '../_lib';

interface MirProektaProps {
  notes: MemoryNote[];
  materials: MaterialsList;
  canonCount: number;
  onAddNote: (text: string) => Promise<void> | void;
  onRemoveNote: (id: string) => Promise<void> | void;
  onToggleNoteContext: (id: string) => Promise<void> | void;
  onUploadFile: (file: File) => Promise<string | null>;
  onRemoveMaterial: (id: string) => void;
  onToggleMaterialContext: (id: string, includeInAi: boolean) => Promise<void> | void;
  persistenceError?: string | null;
  onRetryPersistence?: () => Promise<void> | void;
  /** External request to open the write box pre-filled (suggestion «Записать»). */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
}

const ACCEPT = '.txt,.md,.markdown,.fountain,.spmd,.docx,.pdf,.highland';

function tokenLabel(chars: number): string {
  return `≈${Math.round(chars / 3 / 100) / 10}k токенов`;
}

/**
 * МИР ПРОЕКТА — the Claude-Projects canon plaque (spec §4b): a flat list of
 * free-text записи + whole files, exactly two actions, no types or rubrics.
 * The редактор reads it before every answer.
 */
export function MirProekta(props: MirProektaProps) {
  const {
    notes,
    materials,
    onAddNote,
    onRemoveNote,
    onToggleNoteContext,
    onUploadFile,
    onRemoveMaterial,
    onToggleMaterialContext,
    persistenceError,
    onRetryPersistence,
    prefill,
    onPrefillConsumed,
  } = props;
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState('');

  // A suggestion's «Записать» opens the write box pre-filled (spec §5).
  useEffect(() => {
    if (prefill != null) {
      setDraft(prefill);
      setWriting(true);
      onPrefillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  const empty = notes.length === 0 && materials.items.length === 0;
  const maxFilesError =
    materials.maxFiles != null
      ? `Достигнут предел: не более ${materials.maxFiles} материалов.`
      : null;
  const fileLimitReached =
    materials.maxFiles != null && materials.items.length >= materials.maxFiles;

  useEffect(() => {
    if (maxFilesError != null && !fileLimitReached && error === maxFilesError) setError(null);
  }, [error, fileLimitReached, maxFilesError]);

  const submitNote = async () => {
    const t = draft.trim();
    if (!t || busy) return;
    setBusy(true);
    await onAddNote(t);
    setBusy(false);
    setDraft('');
    setWriting(false);
  };

  const upload = async (file: File) => {
    if (busyRef.current) return;
    if (fileLimitReached) {
      setError(maxFilesError);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const err = await onUploadFile(file);
    busyRef.current = false;
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)]"
      data-testid="scenario-mir"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) void upload(f);
      }}
    >
      <div className="flex items-center gap-2 border-b-[2px] border-[color:var(--color-line-soft)] px-3 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted-foreground)]">
          Мир проекта
        </span>
        {props.canonCount > 0 && (
          <span
            className="border-[2px] border-[color:var(--color-line-soft)] px-1 font-mono text-[11px] leading-4 text-[color:var(--color-muted-foreground)]"
            data-testid="scenario-mir-count"
          >
            {props.canonCount}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-3">
        <p className="text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          Память редактора — он читает её перед каждым ответом.
        </p>

        {empty ? (
          <div
            className={`flex flex-col items-center gap-1 border-[2.5px] border-dashed px-3 py-5 text-center ${
              dragOver
                ? 'border-[color:var(--color-accent)] bg-[color:var(--color-muted)]'
                : 'border-[color:var(--color-accent)]'
            }`}
            data-testid="scenario-mir-dropzone"
          >
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-fg)]">
              <Upload size={14} aria-hidden />
              Брось файл сюда
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5" data-testid="scenario-mir-entries">
            {notes.map((n) => (
              <div
                key={n.id}
                className="group flex items-start gap-2 bg-[color:var(--color-surface2)] px-2.5 py-1.5"
                data-testid="scenario-note"
              >
                <div className="min-w-0 flex-1">
                  <span className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[color:var(--color-fg)]">
                    {n.content}
                  </span>
                  {!n.includeInAi && <MemoryStatus />}
                </div>
                <MemoryActions
                  includeInAi={n.includeInAi}
                  onToggle={() => void onToggleNoteContext(n.id)}
                  onRemove={() => void onRemoveNote(n.id)}
                  removeLabel="Удалить запись"
                  testId="scenario-note-memory"
                />
              </div>
            ))}
            {materials.items.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 bg-[color:var(--color-surface2)] px-2.5 py-1.5"
                data-testid="scenario-file"
              >
                <File size={14} aria-hidden />

                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-[color:var(--color-fg)]">
                    {m.name}
                  </span>
                  <span className="sr-only">{tokenLabel(m.chars)}</span>
                  {!m.includeInAi && <MemoryStatus />}
                </div>
                <MemoryActions
                  includeInAi={Boolean(m.includeInAi)}
                  onToggle={() => void onToggleMaterialContext(m.id, !m.includeInAi)}
                  onRemove={() => onRemoveMaterial(m.id)}
                  removeLabel={`Удалить ${m.name}`}
                  testId="scenario-file-memory"
                />
              </div>
            ))}
          </div>
        )}

        {writing && (
          <div className="flex flex-col gap-2 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] p-2">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Персонаж, правило мира, тон, референс…"
              rows={3}
              data-testid="scenario-note-input"
              className="resize-none bg-transparent text-[13px] leading-relaxed text-[color:var(--color-fg)] placeholder:text-[color:var(--color-muted-foreground)] focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setWriting(false);
                  setDraft('');
                }}
                className="sp-btn-ghost px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]"
              >
                Отмена
              </button>
              <button
                onClick={submitNote}
                disabled={busy || draft.trim() === ''}
                data-testid="scenario-note-save"
                className="sp-btn border-[2px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-primary-foreground)]"
              >
                Записать
              </button>
            </div>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          Синопсис, описания персонажей, правила мира, референсы — файлом. Редактор прочитает их
          перед каждым ответом.
        </p>

        {error && (
          <p className="font-mono text-[11px] text-[color:var(--color-destructive)]">{error}</p>
        )}
        {persistenceError && (
          <div
            className="border-[2px] border-[color:var(--color-destructive)] p-2 text-[11px] text-[color:var(--color-destructive)]"
            data-testid="scenario-mir-save-error"
          >
            {persistenceError}
            <button
              onClick={() => void onRetryPersistence?.()}
              className="ml-2 font-bold underline"
              data-testid="scenario-mir-save-retry"
            >
              Повторить
            </button>
          </div>
        )}
      </div>

      <div className="border-t-[2px] border-[color:var(--color-line-soft)]">
        <div className="flex gap-2 p-2.5">
          {CANON_MANUAL_NOTES_ENABLED && (
            <button
              onClick={() => setWriting(true)}
              disabled={busy}
              data-testid="scenario-mir-write"
              className="sp-btn flex-1 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-2 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-primary-foreground)]"
            >
              + Записать
            </button>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            data-testid="scenario-mir-file"
            className="sp-btn-ghost inline-flex flex-1 items-center justify-center gap-1.5 border-[2.5px] border-dashed border-[color:var(--color-line-soft)] px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]"
          >
            <Upload size={14} aria-hidden />
            Файл
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </div>

        <div className="flex flex-col gap-1 px-3 pb-2">
          <p className="font-mono text-[11px] tracking-wide text-[color:var(--color-muted-foreground)]">
            {ACCEPT.replaceAll(',', ' · ')}
          </p>

          {materials.maxFiles != null && materials.maxTotalChars != null && (
            <p
              className="font-mono text-[11px] tracking-wide text-[color:var(--color-muted-foreground)]"
              data-testid="scenario-mir-limits"
            >
              Файлы: {materials.items.length} / {materials.maxFiles} · Объём:{' '}
              {materials.totalChars.toLocaleString('ru-RU')} /{' '}
              {materials.maxTotalChars.toLocaleString('ru-RU')} знаков
            </p>
          )}
        </div>

        <div className="border-t-[2px] border-[color:var(--color-line-soft)] px-3 py-2 text-[11px] text-[color:var(--color-muted-foreground)]">
          Не забывается между сессиями.
        </div>
      </div>
    </section>
  );
}

function MemoryActions({
  includeInAi,
  onToggle,
  onRemove,
  removeLabel,
  testId,
}: {
  includeInAi: boolean;
  onToggle: () => void;
  onRemove: () => void;
  removeLabel: string;
  testId: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <details className="group/menu relative">
        <summary
          aria-label="Действия с материалом"
          data-testid={`${testId}-menu`}
          className="sp-btn-ghost flex h-6 w-7 cursor-pointer list-none items-center justify-center border-[2px] border-[color:var(--color-line-soft)] font-mono text-[13px] leading-none text-[color:var(--color-muted-foreground)] marker:content-none"
        >
          ···
        </summary>
        <div className="absolute right-0 top-full z-30 mt-1 flex min-w-[210px] flex-col border-[2px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-1 shadow-[3px_3px_0_0_var(--color-line)]">
          <button
            type="button"
            onClick={onToggle}
            data-testid={testId}
            className="cursor-pointer px-2.5 py-2 text-left text-[13px] text-[color:var(--color-fg)] hover:bg-[color:var(--color-muted)] focus-visible:bg-[color:var(--color-muted)] focus-visible:outline-none"
          >
            {includeInAi ? 'Не учитывать в ответах' : 'Учитывать в ответах'}
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label={removeLabel}
            data-testid={testId.replace('memory', 'remove')}
            className="cursor-pointer px-2.5 py-2 text-left text-[13px] text-[color:var(--color-destructive)] hover:bg-[color:var(--color-muted)] focus-visible:bg-[color:var(--color-muted)] focus-visible:outline-none"
          >
            Удалить
          </button>
        </div>
      </details>
    </div>
  );
}

function MemoryStatus() {
  return (
    <span className="block font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
      Не учитывается
    </span>
  );
}
