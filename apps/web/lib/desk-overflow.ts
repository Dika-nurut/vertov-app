export interface DeskTruncation {
  media: boolean;
  scenario: boolean;
  boards: boolean;
  studio: boolean;
}

export function deskOverflowLinks(truncated: DeskTruncation, projectId: string) {
  const suffix = `?projectId=${encodeURIComponent(projectId)}`;
  return [
    truncated.media ? { key: 'media', label: 'Элементы', href: `/gallery${suffix}` } : null,
    truncated.scenario ? { key: 'scenario', label: 'Сценарий', href: `/scenario${suffix}` } : null,
    truncated.boards ? { key: 'boards', label: 'Борды', href: `/boards${suffix}` } : null,
    truncated.studio ? { key: 'studio', label: 'Студия', href: `/studio/projects${suffix}` } : null,
  ].filter((link): link is { key: string; label: string; href: string } => link !== null);
}
