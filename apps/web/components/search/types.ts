export type SearchResultType = 'project' | 'script' | 'board' | 'studio' | 'media';

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  href: string;
  mediaKind: 'image' | 'video' | 'audio' | null;
  thumbnailUrl: string | null;
  projects: Array<{ id: string; title: string }>;
  projectCount: number;
  association: 'project' | 'standalone' | 'single' | 'multiple';
  updatedAt: string;
}

export interface SearchGroup {
  type: SearchResultType;
  items: SearchResult[];
}

export interface SearchResponse {
  query: string;
  groups: SearchGroup[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export const SEARCH_TYPE_LABELS: Record<SearchResultType, string> = {
  project: 'Проекты',
  script: 'Сценарии',
  board: 'Доски',
  studio: 'Документы студии',
  media: 'Медиа',
};
