'use client';

import { useState } from 'react';
import { Check, FileText, Loader2, Sparkles, X } from '@/components/ui/icons';

export type PromptImprovementModel = 'claude' | 'gpt' | 'gemini';

const TEXT_MODELS: { id: PromptImprovementModel; label: string }[] = [
  { id: 'claude', label: 'Claude Sonnet 5' },
  { id: 'gpt', label: 'GPT-5.6 Terra' },
  { id: 'gemini', label: 'Gemini 3 Flash' },
];

export function BoardPromptInspector({
  node,
  generationMode,
  generationModel,
  unresolvedAssets,
  hasProject,
  onClose,
  onPatch,
  onImprove,
  onResolveAsset,
}: {
  node: { id: string; data: Record<string, unknown> } | null;
  generationMode: 'image' | 'video' | null;
  generationModel: string | null;
  unresolvedAssets: string[];
  hasProject: boolean;
  onClose: () => void;
  onPatch: (id: string, data: Record<string, unknown>) => void;
  onImprove: (id: string, model: PromptImprovementModel) => Promise<boolean>;
  onResolveAsset: (targetId: string, asset: string, action: 'project' | 'media' | 'visual') => void;
}) {
  const [model, setModel] = useState<PromptImprovementModel>('claude');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!node) return null;
  const promptNode = node;

  const text = typeof promptNode.data['text'] === 'string' ? promptNode.data['text'] : '';
  const result = typeof promptNode.data['result'] === 'string' ? promptNode.data['result'] : '';
  const hasResult = Boolean(result.trim());
  const view = node.data['view'] === 'result' && hasResult ? 'result' : 'draft';
  const mode = generationMode ?? 'video';

  async function improve(): Promise<void> {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const ok = await onImprove(promptNode.id, model);
    if (!ok) setError('Не удалось улучшить промпт. Попробуйте ещё раз.');
    setBusy(false);
  }

  return (
    <aside
      aria-label="Инспектор промпта"
      className="glass-menu seed-scroll pointer-events-auto absolute bottom-3 right-3 top-3 z-30 flex w-[min(360px,calc(100vw-1.5rem))] flex-col overflow-y-auto rounded-[var(--radius-md)] p-4"
      data-testid="board-prompt-inspector"
    >
      <div className="flex items-start gap-2">
        <FileText size={17} className="mt-1 shrink-0 text-[color:var(--color-accent)]" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-faint)]">
            Board · Inspector
          </p>
          <h2 className="mt-1 font-display text-[19px] text-[color:var(--color-fg)]">Промпт</h2>
        </div>
        <button type="button" aria-label="Закрыть инспектор" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2.5 py-2">
          <span className="block font-mono text-[10px] uppercase text-[color:var(--color-faint)]">
            Режим
          </span>
          <strong className="mt-1 block text-[13px] text-[color:var(--color-fg)]">
            {mode === 'image' ? 'Кадр · изображение' : 'Кадр · видео'}
          </strong>
        </div>
        <div className="border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2.5 py-2">
          <span className="block font-mono text-[10px] uppercase text-[color:var(--color-faint)]">
            Генерация
          </span>
          <strong className="mt-1 block truncate text-[13px] text-[color:var(--color-fg)]">
            {generationModel ?? 'Модель не выбрана'}
          </strong>
        </div>
      </div>

      <label className="mt-4 block text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-faint)]">
        Текстовая модель
        <select
          value={model}
          onChange={(event) => setModel(event.target.value as PromptImprovementModel)}
          className="mt-1.5 h-9 w-full border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-2 text-[13px] font-normal normal-case tracking-normal text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
          data-testid="prompt-inspector-model"
        >
          {TEXT_MODELS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {hasResult && (
        <div
          className="mt-4 flex gap-1 border-b-2 border-[color:var(--color-line)] pb-2"
          role="tablist"
        >
          {(['draft', 'result'] as const).map((nextView) => (
            <button
              key={nextView}
              type="button"
              role="tab"
              aria-selected={view === nextView}
              onClick={() => onPatch(promptNode.id, { view: nextView })}
              className={`border-[1.5px] px-2 py-1 text-[11px] font-semibold ${view === nextView ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]' : 'border-[color:var(--color-line-soft)] text-[color:var(--color-muted-foreground)]'}`}
              data-testid={`prompt-inspector-view-${nextView}`}
            >
              {nextView === 'draft' ? 'Черновик' : 'Результат'}
            </button>
          ))}
        </div>
      )}

      {unresolvedAssets.length > 0 && (
        <section
          className="mt-4 border-2 border-[color:var(--color-destructive)]/60 bg-[color:var(--color-surface2)] p-2.5"
          data-testid="prompt-inspector-unresolved"
        >
          <p className="font-mono text-[10px] font-bold uppercase tracking-wide text-[color:var(--color-destructive)]">
            Нужно решить
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Объект есть в сцене, но пока не привязан к проекту. Кадр можно запустить и без него.
          </p>
          <div className="mt-2 space-y-2">
            {unresolvedAssets.map((asset) => (
              <div
                key={asset}
                className="border-t border-[color:var(--color-line-soft)] pt-2 first:border-0 first:pt-0"
              >
                <strong
                  className="block truncate text-[12px] text-[color:var(--color-fg)]"
                  title={asset}
                >
                  {asset}
                </strong>
                <div className="mt-1.5 grid gap-1">
                  <button
                    type="button"
                    disabled={!hasProject}
                    onClick={() => onResolveAsset(promptNode.id, asset, 'project')}
                    className="nodrag border-[1.5px] border-[color:var(--color-line-soft)] px-2 py-1.5 text-left text-[11px] text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid="prompt-inspector-use-project-asset"
                  >
                    Взять ассет проекта
                    <span className="mt-0.5 block text-[10px] text-[color:var(--color-faint)]">
                      {hasProject
                        ? 'Только материалы этого проекта'
                        : 'Сначала привяжите борд к проекту'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onResolveAsset(promptNode.id, asset, 'media')}
                    className="nodrag border-[1.5px] border-[color:var(--color-line-soft)] px-2 py-1.5 text-left text-[11px] text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-fg)]"
                    data-testid="prompt-inspector-create-media"
                  >
                    Создать карточку Медиа
                    <span className="mt-0.5 block text-[10px] text-[color:var(--color-faint)]">
                      Загрузите свой снимок объекта
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onResolveAsset(promptNode.id, asset, 'visual')}
                    className="nodrag border-[1.5px] border-[color:var(--color-accent)] px-2 py-1.5 text-left text-[11px] text-[color:var(--color-accent)] hover:bg-[color:var(--color-accent)] hover:text-[color:var(--color-primary-foreground)]"
                    data-testid="prompt-inspector-create-visual"
                  >
                    Создать визуальный референс
                    <span className="mt-0.5 block text-[10px] text-current/70">
                      Обычная карточка изображения, запуск вручную
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {view === 'result' ? (
        <div
          data-testid="prompt-inspector-result"
          className="seed-scroll mt-3 min-h-[150px] flex-1 overflow-y-auto border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] p-2.5 text-[13px] leading-relaxed text-[color:var(--color-fg)]"
        >
          {result}
        </div>
      ) : (
        <textarea
          value={text}
          onChange={(event) => onPatch(promptNode.id, { text: event.target.value, view: 'draft' })}
          placeholder="Текст промпта…"
          className="nodrag mt-3 min-h-[150px] flex-1 resize-y border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] p-2.5 text-[13px] leading-relaxed text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
          data-testid="prompt-inspector-text"
        />
      )}

      {error && (
        <p role="alert" className="mt-3 text-[11px] text-[color:var(--color-destructive)]">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy || !text.trim()}
        onClick={() => void improve()}
        className="press mt-4 inline-flex h-9 items-center justify-center gap-2 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-40"
        data-testid="prompt-inspector-improve"
      >
        {busy ? <Loader2 size={14} className="seed-spin" /> : <Sparkles size={14} />}
        Улучшить промпт
      </button>
      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-[color:var(--color-faint)]">
        <Check size={12} className="mt-0.5 shrink-0" /> Результат вернётся в эту же карточку;
        исходный текст останется в «Черновик».
      </p>
    </aside>
  );
}
