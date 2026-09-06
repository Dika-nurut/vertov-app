import type { SredaFolder } from '@seed/shared/sreda-folders';

export type FolderPayload = SredaFolder;

export function folderChildren(folders: FolderPayload[], parentId: string | null): FolderPayload[] {
  return folders
    .filter((folder) => (folder.parentId ?? null) === parentId)
    .sort(
      (left, right) =>
        left.ord - right.ord ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

export function folderBreadcrumbs(folders: FolderPayload[], folderId: string): FolderPayload[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: FolderPayload[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export function folderDescendantIds(folders: FolderPayload[], folderId: string): Set<string> {
  const result = new Set<string>();
  const pending = [folderId];
  while (pending.length > 0) {
    const parentId = pending.pop()!;
    for (const folder of folders) {
      if (folder.parentId !== parentId || result.has(folder.id)) continue;
      result.add(folder.id);
      pending.push(folder.id);
    }
  }
  return result;
}

export function folderMoveTargets(
  folders: FolderPayload[],
  folderId: string,
): Array<FolderPayload | null> {
  const excluded = folderDescendantIds(folders, folderId);
  excluded.add(folderId);
  return [
    null,
    ...folders
      .filter((folder) => !excluded.has(folder.id))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru')),
  ];
}

export function folderMutationError(error: string | undefined): string {
  if (error === 'folder_name_exists') return 'В этой папке уже есть папка с таким названием';
  if (error === 'folder_cycle' || error === 'self_parent')
    return 'Папку нельзя переместить внутрь самой себя';
  if (error === 'cross_project_parent') return 'Папки нельзя переносить между проектами';
  if (error === 'stale_folder')
    return 'Папка уже изменилась. Данные обновлены — повторите действие';
  if (error === 'folder_not_empty') return 'В папке есть материалы или вложенные папки';
  if (error === 'not_found') return 'Папка уже удалена или недоступна';
  return 'Не удалось изменить папку';
}
