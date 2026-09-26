'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useProjectContext } from './ProjectContextProvider';
import {
  PROJECT_CONTEXT_STORAGE_KEY,
  type ParsedProjectContext,
  type ProjectContextState,
} from '@/lib/project-context';
import {
  PROJECT_PRODUCT_DESTINATIONS,
  projectListHref,
  projectResolverHref,
  type ProjectProduct,
  type ResolvableProjectProduct,
} from '@/lib/project-product-destinations';
import { withLocale, type Locale } from '@/lib/locale';
import styles from './ProjectChrome.module.css';

const PRODUCTS = Object.keys(PROJECT_PRODUCT_DESTINATIONS) as ProjectProduct[];

function productIsActive(pathname: string, product: ProjectProduct): boolean {
  const destination = PROJECT_PRODUCT_DESTINATIONS[product];
  // A product may declare where it really lives when that is not its list —
  // see Студия. Everything else is "the list, or anything under it".
  const href = 'activePrefix' in destination ? destination.activePrefix : destination.listHref;
  if (href === '/generate') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Arrow({
  href,
  label,
  destructive = false,
  locale = 'ru',
}: {
  href: string;
  label: string;
  destructive?: boolean;
  locale?: Locale;
}) {
  return (
    <Link
      href={withLocale(href, locale)}
      aria-label={label}
      data-testid="desk-return"
      onClick={() => window.sessionStorage.removeItem(PROJECT_CONTEXT_STORAGE_KEY)}
      className={destructive ? `${styles.deskArrow} ${styles.deskArrowInvalid}` : styles.deskArrow}
    >
      ←
    </Link>
  );
}

function ProductRow({ projectId, locale }: { projectId: string; locale: Locale }) {
  const pathname = usePathname() ?? '';
  return (
    <nav className={styles.products} aria-label="Продукты проекта">
      {PRODUCTS.map((product) => {
        const destination = PROJECT_PRODUCT_DESTINATIONS[product];
        const className = productIsActive(pathname, product)
          ? `${styles.product} ${styles.productActive}`
          : styles.product;
        if ('resolverPath' in destination) {
          return (
            <form
              action={withLocale(
                projectResolverHref(product as ResolvableProjectProduct, projectId),
                locale,
              )}
              method="post"
              className={styles.dockForm}
              key={product}
            >
              <button type="submit" className={className}>
                {destination.name}
              </button>
            </form>
          );
        }
        return (
          <Link
            key={product}
            href={withLocale(projectListHref(product, projectId), locale)}
            className={className}
          >
            {destination.name}
          </Link>
        );
      })}
    </nav>
  );
}

function Loading({ projectId, locale }: { projectId: string; locale: Locale }) {
  return (
    <div
      className={styles.context}
      data-testid="project-context-loading"
      // The skeletons are decorative, so without this a screen reader is told
      // nothing at all while the project resolves — it hears only the arrow and
      // has no way to know the name and product row are still coming.
      role="status"
      aria-busy="true"
      aria-label="Загружаем проект"
    >
      <Arrow
        href={`/workspace/${encodeURIComponent(projectId)}`}
        label="На стол проекта"
        locale={locale}
      />
      <span className={`${styles.name} ${styles.skeletonName}`} aria-hidden="true" />
      <span className={styles.skeletonProducts} aria-hidden="true" />
    </div>
  );
}

function Invalid({ locale }: { locale: Locale }) {
  // The alert is the MESSAGE only. A role="alert" region is an assertive status
  // announcement, not a container for controls: wrapping the escape link in it
  // makes a reader read the link as part of the error and then again on focus.
  return (
    <div className={`${styles.context} ${styles.invalid}`} data-testid="project-context-invalid">
      <Arrow href="/workspace" label="К проектам" destructive locale={locale} />
      <span className={styles.name} role="alert">
        Проект недоступен — работаем без него
      </span>
    </div>
  );
}

function Valid({
  project,
  locale,
}: {
  project: Extract<ProjectContextState, { mode: 'valid' }>['project'];
  locale: Locale;
}) {
  return (
    <div className={styles.context} data-testid="project-context-valid">
      <Arrow
        href={project.returnHref}
        label={`На стол проекта «${project.title}»`}
        locale={locale}
      />
      <span className={styles.name} title={project.title}>
        {project.title}
      </span>
      <ProductRow projectId={project.id} locale={locale} />
    </div>
  );
}

export function ProjectChromeContext({
  projectContext,
  locale = 'ru',
}: {
  projectContext: ParsedProjectContext;
  locale?: Locale;
}) {
  const context = useProjectContext();
  if (projectContext.mode === 'invalid' || context.mode === 'invalid') {
    return <Invalid locale={locale} />;
  }
  if (context.mode === 'valid') return <Valid project={context.project} locale={locale} />;
  // The provider begins in loading state; the server-parsed ID supplies the
  // real desk target before asynchronous validation completes. With no id to
  // aim at — a caller that mounted the bar outside project context — the arrow
  // goes to the project list rather than to `/workspace/`, which is a 404.
  if (projectContext.mode !== 'project') return <Invalid locale={locale} />;
  return <Loading projectId={projectContext.projectId} locale={locale} />;
}
