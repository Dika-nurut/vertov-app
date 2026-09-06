// Library captions panel — auto (Deepgram) / manual / .srt upload (extracted
// from StudioClient.tsx, split 5h/N). autoCaption/onSrtUpload/addText stay in
// StudioClient (touch project + network); injected with timeline + captioning.
import type React from 'react';
import { Captions, Download, Loader2, Plus, X } from '../_icons';
import type { TClip, TText } from '../_model';
import type { CaptionEngine } from '../useStudioMedia';
import type { AsrProgress } from '../../../lib/local-asr/service';

export function CaptionsPanel({
  autoCaption,
  autoCaptionWords,
  engine,
  setEngine,
  localSupported,
  asrProgress,
  popMode,
  setPopMode,
  popWordCount,
  onClearPop,
  timeline,
  captioning,
  addText,
  onSrtUpload,
}: {
  autoCaption: () => void;
  autoCaptionWords: () => void;
  engine: CaptionEngine;
  setEngine: (v: CaptionEngine) => void;
  localSupported: boolean;
  asrProgress: AsrProgress | null;
  popMode: boolean;
  setPopMode: (v: boolean) => void;
  popWordCount: number;
  onClearPop: () => void;
  timeline: TClip[];
  captioning: boolean;
  addText: (opts?: {
    text?: string;
    position?: TText['position'];
    font?: TText['font'];
    sizeFrac?: number;
    fade?: boolean;
  }) => void;
  onSrtUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const segButton =
    'press-inset flex-1 rounded-[var(--radius-sm)] px-2 py-1.5 text-[11px] font-semibold ring-1 ring-inset ';
  const segOn =
    'bg-[rgba(var(--accent-rgb),0.15)] text-[color:var(--color-accent)] ring-[color:var(--color-accent)]/40';
  const segOff =
    'bg-[color:var(--color-surface2)] text-[color:var(--color-muted-foreground)] ring-[color:var(--color-line)]/15 hover:bg-[color:var(--color-surface)]';
  return (
    <section data-testid="lib-captions" className="space-y-2">
      <p className="label-eyebrow mb-3">Субтитры</p>
      {/* Engine: server (Deepgram) vs whisper running locally in the browser. The
          local option only appears where WebAssembly + Worker are available. */}
      {localSupported && (
        <div className="flex items-stretch gap-1.5" role="group" aria-label="Движок распознавания">
          <button
            type="button"
            data-testid="cap-engine-server"
            aria-pressed={engine === 'server'}
            disabled={captioning}
            onClick={() => setEngine('server')}
            className={segButton + (engine === 'server' ? segOn : segOff) + ' disabled:opacity-40'}
          >
            Сервер
          </button>
          <button
            type="button"
            data-testid="cap-engine-local"
            aria-pressed={engine === 'local'}
            disabled={captioning}
            onClick={() => setEngine('local')}
            className={segButton + (engine === 'local' ? segOn : segOff) + ' disabled:opacity-40'}
          >
            Локально (бета)
          </button>
        </div>
      )}
      {localSupported && engine === 'local' && (
        <p
          data-testid="cap-local-hint"
          className="text-[11px] leading-relaxed text-[color:var(--color-faint)]"
        >
          Речь распознаётся в браузере — бесплатно и приватно. Модель ~250 МБ скачается один раз.
        </p>
      )}
      {/* «По словам»: word-pop mode. One word at a time, its own dedicated lane. */}
      <div className="flex items-stretch gap-1.5" role="group" aria-label="Режим авто-субтитров">
        <button
          type="button"
          data-testid="cap-mode-lines"
          aria-pressed={!popMode}
          onClick={() => setPopMode(false)}
          className={segButton + (!popMode ? segOn : segOff)}
        >
          Строками
        </button>
        <button
          type="button"
          data-testid="cap-mode-pop"
          aria-pressed={popMode}
          onClick={() => setPopMode(true)}
          className={segButton + (popMode ? segOn : segOff)}
        >
          По словам
        </button>
      </div>
      <button
        type="button"
        data-testid="cap-auto"
        onClick={() => (popMode ? void autoCaptionWords() : void autoCaption())}
        disabled={timeline.length === 0 || captioning}
        className="press-inset flex w-full items-center gap-3 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-3 text-left ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:bg-[color:var(--color-surface)] disabled:opacity-40"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[rgba(var(--accent-rgb),0.15)] text-[color:var(--color-accent)]">
          {captioning ? <Loader2 size={15} className="seed-spin" /> : <Captions size={15} />}
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-[color:var(--color-fg)]">
            {popMode ? 'Субтитры по словам' : 'Авто-субтитры'}
          </span>
          <span className="block text-[11px] text-[color:var(--color-faint)]">
            {popMode
              ? 'Каждое слово по очереди, крупно по центру'
              : 'Распознать речь выбранного клипа'}
          </span>
        </span>
      </button>
      {captioning && engine === 'local' && asrProgress && (
        <p
          data-testid="cap-local-progress"
          className="px-1 text-[11px] font-semibold text-[color:var(--color-accent)]"
        >
          {asrProgress.phase === 'download' ? `Скачиваю модель… ${asrProgress.pct}%` : 'Распознаю…'}
        </p>
      )}
      {popWordCount > 0 && (
        <div
          data-testid="cap-pop-summary"
          className="flex items-center gap-3 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-3 ring-1 ring-inset ring-[color:var(--color-line)]/15"
        >
          <span className="min-w-0 flex-1 text-[11px] text-[color:var(--color-muted-foreground)]">
            Субтитры по словам: <span className="font-semibold">{popWordCount}</span>
          </span>
          <button
            type="button"
            data-testid="cap-pop-clear"
            onClick={onClearPop}
            className="press-inset flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-[color:var(--color-surface)] px-2 py-1 text-[11px] font-semibold text-[color:var(--color-muted-foreground)] ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:text-[color:var(--color-fg)]"
          >
            <X size={12} />
            Очистить
          </button>
        </div>
      )}
      <button
        type="button"
        data-testid="cap-manual"
        onClick={() => addText()}
        disabled={timeline.length === 0}
        className="press-inset flex w-full items-center gap-3 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-3 text-left ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:bg-[color:var(--color-surface)] disabled:opacity-40"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)]">
          <Plus size={15} />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-[color:var(--color-fg)]">
            Добавить вручную
          </span>
          <span className="block text-[11px] text-[color:var(--color-faint)]">
            Пустой блок субтитра
          </span>
        </span>
      </button>
      <label
        data-testid="cap-upload"
        className="press-inset flex w-full cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-3 text-left ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:bg-[color:var(--color-surface)]"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)]">
          <Download size={15} />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-[color:var(--color-fg)]">
            Загрузить .srt
          </span>
          <span className="block text-[11px] text-[color:var(--color-faint)]">
            Импорт готовых субтитров
          </span>
        </span>
        <input type="file" accept=".srt,.vtt,.ass" onChange={onSrtUpload} className="hidden" />
      </label>
      <p className="pt-1 text-[11px] leading-relaxed text-[color:var(--color-faint)]">
        Субтитры — блоки на дорожке «Текст»: правь их в инспекторе, они впечатываются в видео.
      </p>
    </section>
  );
}
