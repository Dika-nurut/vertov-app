import { withProjectContext } from './project-context';

export const PROJECT_PRODUCT_DESTINATIONS = {
  scenario: {
    name: 'Сценарий',
    icon: 'pen',
    listHref: '/scenario',
    resolverPath: '/workspace/resolve/scenario',
    documentHref: (id: string) => `/scenario/${encodeURIComponent(id)}`,
  },
  boards: {
    name: 'Борды',
    icon: 'network',
    listHref: '/boards',
    resolverPath: '/workspace/resolve/boards',
    documentHref: (id: string) => `/boards/${encodeURIComponent(id)}`,
  },
  studio: {
    name: 'Студия',
    icon: 'video',
    listHref: '/studio/projects',
    // Студия is the one product whose list lives BELOW its documents:
    // the list is /studio/projects but a монтаж opens at /studio/:id. Deriving
    // "am I here" from listHref therefore never lights it while you are editing.
    activePrefix: '/studio',
    resolverPath: '/workspace/resolve/studio',
    documentHref: (id: string) => `/studio/${encodeURIComponent(id)}`,
  },
  generate: {
    name: 'Генерация',
    icon: 'sparkles',
    listHref: '/generate',
  },
  gallery: {
    name: 'Элементы',
    icon: 'users',
    listHref: '/gallery',
  },
} as const;

export type ProjectProduct = keyof typeof PROJECT_PRODUCT_DESTINATIONS;
export type ResolvableProjectProduct = Extract<ProjectProduct, 'scenario' | 'boards' | 'studio'>;

export function isResolvableProjectProduct(product: string): product is ResolvableProjectProduct {
  return product === 'scenario' || product === 'boards' || product === 'studio';
}

export function projectListHref(product: ProjectProduct, projectId: string): string {
  return withProjectContext(PROJECT_PRODUCT_DESTINATIONS[product].listHref, projectId);
}

export function projectResolverHref(product: ResolvableProjectProduct, projectId: string): string {
  return withProjectContext(PROJECT_PRODUCT_DESTINATIONS[product].resolverPath, projectId);
}

export function projectDocumentHref(
  product: ResolvableProjectProduct,
  id: string,
  projectId: string,
): string {
  return withProjectContext(PROJECT_PRODUCT_DESTINATIONS[product].documentHref(id), projectId);
}
