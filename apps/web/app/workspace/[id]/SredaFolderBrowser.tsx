'use client';

import { useState, type DragEvent, type ReactNode } from 'react';
import { DeskIcon } from './DeskIcons';
import { folderBreadcrumbs, folderChildren, type FolderPayload } from './folder-model';
import styles from './desk.module.css';

const FOLDER_OVERFLOW_THRESHOLD = 12;

export function SredaFolderBrowser({
  projectTitle,
  folder,
  folders,
  loading,
  error,
  hasAssets,
  activeTarget,
  onProjectRoot,
  onNavigate,
  onCreate,
  onRename,
  onMove,
  onDelete,
  onRetry,
  onFolderDragStart,
  onFolderDragEnd,
  onFolderDragEnter,
  onFolderDrop,
  children,
}: {
  projectTitle: string;
  folder: FolderPayload;
  folders: FolderPayload[];
  loading: boolean;
  error: string | null;
  hasAssets: boolean;
  activeTarget: string | null;
  onProjectRoot: () => void;
  onNavigate: (folder: FolderPayload) => void;
  onCreate: () => void;
  onRename: (folder: FolderPayload) => void;
  onMove: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onFolderDragStart: (event: DragEvent, folder: FolderPayload) => void;
  onFolderDragEnd: () => void;
  onFolderDragEnter: (folder: FolderPayload) => void;
  onFolderDrop: (event: DragEvent, target: FolderPayload) => void;
  children: ReactNode;
}) {
  const breadcrumbs = folderBreadcrumbs(folders, folder.id);
  const nested = folderChildren(folders, folder.id);
  const overflow = Math.max(0, nested.length - FOLDER_OVERFLOW_THRESHOLD);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  return (
    <>
      <nav className={styles.folderBreadcrumbs} aria-label="Путь к папке">
        <button type="button" onClick={onProjectRoot} data-testid="folder-breadcrumb-root">
          <DeskIcon name="folderOpen" />
          <span>{projectTitle}</span>
        </button>
        {breadcrumbs.map((crumb) => (
          <span key={crumb.id}>
            <span aria-hidden="true">/</span>
            <button
              type="button"
              aria-current={crumb.id === folder.id ? 'page' : undefined}
              onClick={() => onNavigate(crumb)}
              data-testid={`folder-breadcrumb-${crumb.id}`}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>
      <div className={styles.folderToolbar} aria-label="Действия с папкой">
        <button type="button" onClick={onCreate}>
          <DeskIcon name="folder" /> Новая вложенная
        </button>
        <button type="button" onClick={() => onRename(folder)}>
          Переименовать
        </button>
        <button type="button" onClick={onMove}>
          Переместить…
        </button>
        <button type="button" onClick={onDelete}>
          Удалить…
        </button>
      </div>
      {error ? (
        <div className={styles.folderError} role="alert" data-testid="folder-window-error">
          <b>Не удалось открыть папку</b>
          <span>{error}</span>
          <button type="button" onClick={onRetry}>
            Повторить
          </button>
        </div>
      ) : loading ? (
        <div className={styles.windowEmpty} aria-busy="true" data-testid="folder-window-loading">
          ЧИТАЕМ ПАПКУ…
        </div>
      ) : (
        <>
          {nested.length > 0 && (
            <div
              className={styles.nestedFolderGrid}
              aria-label={`Вложенные папки: ${folder.name}`}
              data-testid={`nested-folders-${folder.id}`}
            >
              {nested.map((child) => (
                <button
                  type="button"
                  key={child.id}
                  draggable
                  className={
                    activeTarget === child.id
                      ? `${styles.nestedFolderTile} ${styles.targetHot}`
                      : selectedFolderId === child.id
                        ? `${styles.nestedFolderTile} ${styles.nestedFolderSelected}`
                        : styles.nestedFolderTile
                  }
                  aria-pressed={selectedFolderId === child.id}
                  onClick={() => setSelectedFolderId(child.id)}
                  onDoubleClick={() => onNavigate(child)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onNavigate(child);
                    } else if (event.key === 'F2') {
                      event.preventDefault();
                      onRename(child);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSelectedFolderId(child.id);
                    onRename(child);
                  }}
                  onDragStart={(event) => onFolderDragStart(event, child)}
                  onDragEnd={onFolderDragEnd}
                  onDragEnter={() => onFolderDragEnter(child)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => onFolderDrop(event, child)}
                  data-testid={`nested-folder-${child.id}`}
                >
                  <span className={styles.nestedFolderIcon}>
                    <DeskIcon name="folder" />
                  </span>
                  <b>{child.name}</b>
                  <small>
                    {child.childCount} папок · {child.count} файлов
                  </small>
                </button>
              ))}
            </div>
          )}
          {overflow > 0 && (
            <p className={styles.folderOverflow} data-testid="folder-overflow">
              Прокрутите ниже · ещё {overflow}
            </p>
          )}
          {nested.length === 0 && !hasAssets && (
            <div className={styles.windowEmpty} data-testid="folder-window-empty">
              Папка пуста · создайте вложенную папку или перетащите материал
            </div>
          )}
          {children}
        </>
      )}
    </>
  );
}
