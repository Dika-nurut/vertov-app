'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createWorkspaceProject,
  deleteWorkspaceProject,
  permanentlyDeleteWorkspaceProject,
  ProjectLifecycleError,
  projectLifecycleErrorCopy,
  renameWorkspaceProject,
  restoreWorkspaceProject,
  selectedProjectKeyAction,
  type ProjectRecoveryCounts,
  type ProjectRestoreResult,
} from './project-lifecycle';
import { SearchLauncher } from '@/components/search/SearchLauncher';
import { handleModalKeyDown } from '@/lib/modal-focus';
import styles from './workspace.module.css';

export interface WorkspaceProject {
  id: string;
  title: string;
  productionFormat: { aspect: string };
  rooms: { scenario: number; boards: number; studio: number; assets: number };
}

interface TrashedProject extends WorkspaceProject {
  deletedAt: string;
  purgeAfter: string;
}

interface TrashInspection {
  recovery: {
    expected: ProjectRecoveryCounts;
    restored: ProjectRecoveryCounts;
    unavailable: ProjectRecoveryCounts;
    partial: boolean;
  };
}

type DialogMode = 'create' | 'rename' | 'delete' | 'restore-collision' | 'permanent' | null;
type ViewMode = 'projects' | 'trash';

const PROJECT_GUIDANCE_DISMISSED_KEY = 'sreda:project-guidance-dismissed';

function sceneCopy(count: number): string {
  if (count === 0) return 'пусто';
  if (count % 10 === 1 && count % 100 !== 11) return `${count} сцена`;
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) {
    return `${count} сцены`;
  }
  return `${count} сцен`;
}

function unavailableCopy(counts: ProjectRecoveryCounts): string {
  const total = counts.scripts + counts.boards + counts.studio + counts.media;
  if (total === 0) return '';
  const parts = [
    counts.scripts > 0 ? `сценарии: ${counts.scripts}` : null,
    counts.boards > 0 ? `борды: ${counts.boards}` : null,
    counts.studio > 0 ? `монтажи: ${counts.studio}` : null,
    counts.media > 0 ? `медиа: ${counts.media}` : null,
  ].filter(Boolean);
  return parts.join(', ');
}

function restoreSuccessCopy(result: ProjectRestoreResult): string {
  if (!result.recovery.partial) {
    return `Проект «${result.project.title}» восстановлен полностью.`;
  }
  return `Проект «${result.project.title}» восстановлен частично. Недоступно: ${unavailableCopy(
    result.recovery.unavailable,
  )}.`;
}

export function ProjectDesktop({ apiUrl }: { apiUrl: string }) {
  const router = useRouter();
  const [view, setView] = useState<ViewMode>('projects');
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [trash, setTrash] = useState<TrashedProject[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspection, setInspection] = useState<TrashInspection | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showProjectGuidance, setShowProjectGuidance] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const topCreateRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const base = apiUrl.replace(/\/$/, '');
  const selectedProject = projects.find((project) => project.id === selected) ?? null;
  const selectedTrash = trash.find((project) => project.id === selected) ?? null;

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      setShowProjectGuidance(window.localStorage.getItem(PROJECT_GUIDANCE_DISMISSED_KEY) !== '1');
    } catch {
      // Guidance remains available if browser storage is unavailable.
      setShowProjectGuidance(true);
    }
  }, []);

  function dismissProjectGuidance() {
    setShowProjectGuidance(false);
    try {
      window.localStorage.setItem(PROJECT_GUIDANCE_DISMISSED_KEY, '1');
    } catch {
      // Dismissal still applies to this visit when storage is unavailable.
    }
  }

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${base}/v1/projects`, { credentials: 'include' });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const payload = (await response.json()) as { items: WorkspaceProject[] };
      setProjects(payload.items);
    } catch {
      setError('Не удалось загрузить проекты. Проверьте соединение и попробуйте ещё раз.');
    } finally {
      setLoading(false);
    }
  }, [base]);

  const loadTrash = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${base}/v1/projects/trash`, { credentials: 'include' });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const payload = (await response.json()) as {
        retentionDays: number;
        items: TrashedProject[];
      };
      setTrash(payload.items);
      setRetentionDays(payload.retentionDays);
    } catch {
      setError('Не удалось загрузить Корзину. Проверьте соединение и попробуйте ещё раз.');
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (view !== 'trash' || !selectedTrash) {
      setInspection(null);
      return;
    }
    const controller = new AbortController();
    setInspectionLoading(true);
    fetch(`${base}/v1/projects/trash/${encodeURIComponent(selectedTrash.id)}`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`http_${response.status}`);
        return (await response.json()) as TrashInspection;
      })
      .then((payload) => setInspection(payload))
      .catch((cause: unknown) => {
        if (!(cause instanceof Error && cause.name === 'AbortError')) {
          setInspection(null);
          setError('Не удалось проверить состав проекта.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setInspectionLoading(false);
      });
    return () => controller.abort();
  }, [base, selectedTrash, view]);

  useEffect(() => {
    if (
      dialog === 'create' ||
      dialog === 'rename' ||
      dialog === 'restore-collision' ||
      dialog === 'permanent'
    ) {
      titleRef.current?.focus();
    }
    if (dialog === 'delete') cancelDeleteRef.current?.focus();
  }, [dialog]);

  function rememberDialogOpener(opener?: HTMLElement) {
    dialogOpenerRef.current =
      opener ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : topCreateRef.current);
  }

  function restoreDialogFocus() {
    window.requestAnimationFrame(() => {
      const opener = dialogOpenerRef.current;
      if (opener?.isConnected) opener.focus();
      else topCreateRef.current?.focus();
      dialogOpenerRef.current = null;
    });
  }

  function closeDialog() {
    if (saving) return;
    setDialog(null);
    setTitle('');
    setError(null);
    restoreDialogFocus();
  }

  function openCreate() {
    rememberDialogOpener();
    setTitle('');
    setError(null);
    setDialog('create');
  }

  function openRename() {
    if (!selectedProject) return;
    rememberDialogOpener();
    setTitle(selectedProject.title);
    setError(null);
    setDialog('rename');
  }

  function openDelete() {
    if (!selectedProject) return;
    rememberDialogOpener();
    setError(null);
    setDialog('delete');
  }

  function openPermanent() {
    if (!selectedTrash) return;
    rememberDialogOpener();
    setTitle('');
    setError(null);
    setDialog('permanent');
  }

  async function switchView(next: ViewMode) {
    setView(next);
    setSelected(null);
    setInspection(null);
    setError(null);
    if (next === 'trash') await loadTrash();
    else await loadProjects();
  }

  async function saveTitle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (dialog === 'create') {
        const id = await createWorkspaceProject(fetch, base, title);
        await loadProjects();
        setSelected(id);
        setNotice(`Проект «${title.trim()}» создан.`);
      } else if (dialog === 'rename' && selectedProject) {
        await renameWorkspaceProject(fetch, base, selectedProject.id, title);
        setProjects((current) =>
          current.map((project) =>
            project.id === selectedProject.id ? { ...project, title: title.trim() } : project,
          ),
        );
        setNotice(`Проект переименован в «${title.trim()}».`);
      } else if (dialog === 'restore-collision' && selectedTrash) {
        const result = await restoreWorkspaceProject(fetch, base, selectedTrash.id, title);
        setTrash((current) => current.filter((project) => project.id !== selectedTrash.id));
        setSelected(null);
        setNotice(restoreSuccessCopy(result));
      }
      setDialog(null);
      setTitle('');
      restoreDialogFocus();
    } catch (cause) {
      setError(projectLifecycleErrorCopy(cause));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!selectedProject) return;
    setSaving(true);
    setError(null);
    try {
      await deleteWorkspaceProject(fetch, base, selectedProject.id);
      setProjects((current) => current.filter((project) => project.id !== selectedProject.id));
      setNotice(`Проект «${selectedProject.title}» перемещён в Корзину на ${retentionDays} дней.`);
      setSelected(null);
      setDialog(null);
      restoreDialogFocus();
    } catch (cause) {
      setError(projectLifecycleErrorCopy(cause));
    } finally {
      setSaving(false);
    }
  }

  async function restoreSelected() {
    if (!selectedTrash) return;
    setSaving(true);
    setError(null);
    try {
      const result = await restoreWorkspaceProject(fetch, base, selectedTrash.id);
      setTrash((current) => current.filter((project) => project.id !== selectedTrash.id));
      setSelected(null);
      setNotice(restoreSuccessCopy(result));
    } catch (cause) {
      if (cause instanceof ProjectLifecycleError && cause.code === 'name_collision') {
        rememberDialogOpener();
        setTitle(cause.suggestedTitle ?? `${selectedTrash.title} (восстановлен)`);
        setDialog('restore-collision');
      } else {
        setError(projectLifecycleErrorCopy(cause));
      }
    } finally {
      setSaving(false);
    }
  }

  async function confirmPermanentDelete() {
    if (!selectedTrash) return;
    setSaving(true);
    setError(null);
    try {
      await permanentlyDeleteWorkspaceProject(fetch, base, selectedTrash.id, title);
      setTrash((current) => current.filter((project) => project.id !== selectedTrash.id));
      setNotice(`Проект «${selectedTrash.title}» удалён навсегда.`);
      setSelected(null);
      setDialog(null);
      setTitle('');
      restoreDialogFocus();
    } catch (cause) {
      setError(projectLifecycleErrorCopy(cause));
    } finally {
      setSaving(false);
    }
  }

  const visibleItems = view === 'projects' ? projects : trash;

  return (
    <main className={styles.home} data-testid="workspace-home">
      <header className={styles.topbar}>
        <Link className={styles.wordmark} href="/" aria-label="На главную Vertov">
          VERTOV
        </Link>
        <nav className={styles.actions} aria-label="Действия с проектами">
          <SearchLauncher apiUrl={apiUrl} />
          {view === 'projects' ? (
            <>
              <button ref={topCreateRef} type="button" onClick={openCreate}>
                + Новый проект
              </button>
              <button type="button" onClick={openRename} disabled={!selectedProject}>
                Переименовать
              </button>
              <button type="button" onClick={openDelete} disabled={!selectedProject}>
                Удалить
              </button>
              <button type="button" onClick={() => void switchView('trash')}>
                Корзина
              </button>
            </>
          ) : (
            <>
              <button ref={topCreateRef} type="button" onClick={() => void switchView('projects')}>
                ← К проектам
              </button>
              <button
                type="button"
                onClick={() => void restoreSelected()}
                disabled={!selectedTrash || saving}
              >
                Восстановить
              </button>
              <button type="button" onClick={openPermanent} disabled={!selectedTrash || saving}>
                Удалить навсегда
              </button>
            </>
          )}
        </nav>
        <time suppressHydrationWarning>
          {new Intl.DateTimeFormat('ru-RU', {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          }).format(clock)}
        </time>
      </header>

      {notice && (
        <p className={styles.notice} role="status" onClick={(event) => event.stopPropagation()}>
          {notice}
          <button type="button" aria-label="Закрыть сообщение" onClick={() => setNotice(null)}>
            ×
          </button>
        </p>
      )}

      <section
        className={styles.projectPlane}
        aria-label={view === 'projects' ? 'Проекты' : 'Корзина проектов'}
        onClick={() => setSelected(null)}
      >
        {view === 'trash' && (
          <header className={styles.trashHeader}>
            <h1>Корзина</h1>
            <p>
              Проекты хранятся {retentionDays} дней, затем удаляются навсегда. Медиа с собственным
              сроком хранения может стать недоступно раньше.
            </p>
          </header>
        )}
        <div className={styles.projectGrid}>
          {visibleItems.map((project) => {
            const trashed = view === 'trash' ? (project as TrashedProject) : null;
            return (
              <button
                type="button"
                key={project.id}
                className={selected === project.id ? styles.selected : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelected(project.id);
                  setError(null);
                }}
                onDoubleClick={() => {
                  if (view === 'projects') router.push(`/workspace/${project.id}`);
                }}
                onKeyDown={(event) => {
                  if (view === 'trash') {
                    if (event.key === 'Escape') setSelected(null);
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      setSelected(project.id);
                    }
                    return;
                  }
                  const action = selectedProjectKeyAction(event.key);
                  if (!action) return;
                  event.preventDefault();
                  if (action === 'open') router.push(`/workspace/${project.id}`);
                  if (action === 'rename') {
                    rememberDialogOpener(event.currentTarget);
                    setSelected(project.id);
                    setTitle(project.title);
                    setError(null);
                    setDialog('rename');
                  }
                  if (action === 'delete') {
                    rememberDialogOpener(event.currentTarget);
                    setSelected(project.id);
                    setError(null);
                    setDialog('delete');
                  }
                  if (action === 'clear') setSelected(null);
                }}
                aria-pressed={selected === project.id}
                aria-label={`${project.title}, ${project.productionFormat.aspect}, ${sceneCopy(
                  project.rooms.scenario,
                )}`}
                data-testid={
                  view === 'projects'
                    ? `workspace-project-${project.id}`
                    : `trash-project-${project.id}`
                }
              >
                <span className={styles.projectArt} aria-hidden="true" />
                <b>{project.title}</b>
                <small>
                  {project.productionFormat.aspect} · {sceneCopy(project.rooms.scenario)}
                </small>
                {trashed && (
                  <small>
                    до{' '}
                    {new Intl.DateTimeFormat('ru-RU', {
                      day: '2-digit',
                      month: 'short',
                    }).format(new Date(trashed.purgeAfter))}
                  </small>
                )}
              </button>
            );
          })}
        </div>

        {!loading && view === 'projects' && projects.length > 0 && showProjectGuidance && (
          <aside
            className={styles.guidance}
            aria-label="Как открыть проект"
            data-testid="workspace-project-guide"
            onClick={(event) => event.stopPropagation()}
          >
            <p>
              Один клик выбирает проект. Двойной клик или <kbd>Enter</kbd> открывает его стол.
            </p>
            <button type="button" onClick={dismissProjectGuidance}>
              Понятно
            </button>
          </aside>
        )}

        {!loading && visibleItems.length === 0 && (
          <div className={styles.empty}>
            {view === 'projects' ? (
              <>
                <p>Проектов пока нет.</p>
                <p className={styles.firstRun} data-testid="workspace-first-run">
                  Среда — место для работы над фильмом. В проекте живут сценарии, борды, монтажи и
                  материалы.
                </p>
                <button type="button" onClick={openCreate}>
                  Создать первый проект
                </button>
              </>
            ) : (
              <p>Корзина пуста.</p>
            )}
          </div>
        )}
        {loading && <p className={styles.empty}>Собираем проекты…</p>}
        {!loading && error && dialog === null && (
          <div className={styles.loadError} role="alert">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => void (view === 'projects' ? loadProjects() : loadTrash())}
            >
              Повторить
            </button>
          </div>
        )}

        {view === 'trash' && selectedTrash && (
          <aside
            className={styles.trashInspection}
            aria-label={`Состав проекта ${selectedTrash.title}`}
            onClick={(event) => event.stopPropagation()}
            data-testid="trash-inspection"
          >
            <h2>{selectedTrash.title}</h2>
            <p>
              Удалён {new Intl.DateTimeFormat('ru-RU').format(new Date(selectedTrash.deletedAt))}
            </p>
            {inspectionLoading && <p>Проверяем материалы…</p>}
            {inspection && (
              <>
                <dl>
                  <div>
                    <dt>Сценарии</dt>
                    <dd>
                      {inspection.recovery.restored.scripts}/{inspection.recovery.expected.scripts}
                    </dd>
                  </div>
                  <div>
                    <dt>Борды</dt>
                    <dd>
                      {inspection.recovery.restored.boards}/{inspection.recovery.expected.boards}
                    </dd>
                  </div>
                  <div>
                    <dt>Монтажи</dt>
                    <dd>
                      {inspection.recovery.restored.studio}/{inspection.recovery.expected.studio}
                    </dd>
                  </div>
                  <div>
                    <dt>Медиа</dt>
                    <dd>
                      {inspection.recovery.restored.media}/{inspection.recovery.expected.media}
                    </dd>
                  </div>
                </dl>
                {inspection.recovery.partial ? (
                  <p className={styles.partialWarning}>
                    Восстановление будет частичным. Недоступно:{' '}
                    {unavailableCopy(inspection.recovery.unavailable)}.
                  </p>
                ) : (
                  <p>Все сохранённые материалы доступны для восстановления.</p>
                )}
              </>
            )}
          </aside>
        )}
      </section>
      <small className={styles.attribution}>HackerNoon Pixel Icons · CC BY 4.0</small>

      {dialog && (
        <div
          className={styles.dialogBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          <section
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-dialog-title"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => handleModalKeyDown(event, dialogRef.current, closeDialog)}
          >
            <h1 id="project-dialog-title">
              {dialog === 'create'
                ? 'Новый проект'
                : dialog === 'rename'
                  ? 'Переименовать проект'
                  : dialog === 'delete'
                    ? 'Переместить в Корзину?'
                    : dialog === 'restore-collision'
                      ? 'Название уже занято'
                      : 'Удалить навсегда?'}
            </h1>

            {dialog === 'delete' ? (
              <>
                <p>
                  Стол «{selectedProject?.title}» исчезнет из проектов, но его структура и участия
                  материалов будут храниться {retentionDays} дней.
                </p>
                <p>
                  Медиа с отдельным сроком хранения может стать недоступно раньше. Проект можно
                  восстановить из Корзины до указанной даты.
                </p>
                {error && <p role="alert">{error}</p>}
                <div className={styles.dialogButtons}>
                  <button
                    ref={cancelDeleteRef}
                    type="button"
                    onClick={closeDialog}
                    disabled={saving}
                  >
                    Отмена
                  </button>
                  <button type="button" onClick={() => void confirmDelete()} disabled={saving}>
                    {saving ? 'Перемещаем…' : 'В Корзину'}
                  </button>
                </div>
              </>
            ) : dialog === 'permanent' ? (
              <>
                <p>
                  Это действие нельзя отменить. Сценарии, борды и документы Студии не удалятся:
                  после очистки проекта они станут самостоятельными документами без связи с
                  проектом. Структура стола и участия материалов будут удалены.
                </p>
                <label htmlFor="permanent-project-title">
                  Введите «{selectedTrash?.title}» для подтверждения
                </label>
                <input
                  ref={titleRef}
                  id="permanent-project-title"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setError(null);
                  }}
                  autoComplete="off"
                  aria-invalid={Boolean(error)}
                />
                {error && <p role="alert">{error}</p>}
                <div className={styles.dialogButtons}>
                  <button
                    ref={cancelDeleteRef}
                    type="button"
                    onClick={closeDialog}
                    disabled={saving}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmPermanentDelete()}
                    disabled={saving || title !== selectedTrash?.title}
                  >
                    {saving ? 'Удаляем…' : 'Удалить навсегда'}
                  </button>
                </div>
              </>
            ) : (
              <form onSubmit={(event) => void saveTitle(event)} noValidate>
                {dialog === 'restore-collision' && (
                  <p>
                    Активный проект уже использует это название. Укажите новое — содержимое Корзины
                    пока не изменится.
                  </p>
                )}
                <label htmlFor="project-title">
                  {dialog === 'restore-collision' ? 'Новое название' : 'Название проекта'}
                </label>
                <input
                  ref={titleRef}
                  id="project-title"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setError(null);
                  }}
                  maxLength={120}
                  autoComplete="off"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'project-title-error' : undefined}
                />
                {error && (
                  <p id="project-title-error" role="alert">
                    {error}
                  </p>
                )}
                <div className={styles.dialogButtons}>
                  <button type="button" onClick={closeDialog} disabled={saving}>
                    Отмена
                  </button>
                  <button type="submit" disabled={saving}>
                    {saving
                      ? 'Сохраняем…'
                      : dialog === 'create'
                        ? 'Создать'
                        : dialog === 'restore-collision'
                          ? 'Восстановить'
                          : 'Сохранить'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
