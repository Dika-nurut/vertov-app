import Link from 'next/link';
import { BalanceWidget } from './BalanceWidget';
import { ProfileMenu, type ProfilePlan } from './ProfileMenu';
import { ProjectChromeContext } from './ProjectChromeContext';
import { SearchLauncher } from '@/components/search/SearchLauncher';
import { Mark } from '@/components/ui/mark';
import type { ParsedProjectContext } from '@/lib/project-context';
import styles from './ProjectChrome.module.css';

/**
 * The in-project OS bar. The server owns its fixed 46px frame and account
 * services; the client child resolves only the project-dependent controls.
 */
export function ProjectChrome({
  projectContext,
  email,
  balance,
  apiUrl,
  plan,
  isAnonymous = false,
}: {
  projectContext: ParsedProjectContext;
  email: string;
  balance: number;
  apiUrl: string;
  plan: ProfilePlan | null;
  isAnonymous?: boolean;
}) {
  return (
    <header className={styles.bar}>
      {/* Owner ruling 2026-07-27: inside Среда the wordmark is identity, not a
          door. There is exactly one way out and it is the desk's «ВЫЙТИ» — a
          logo that quietly left the project was a second, invisible exit. */}
      <span className={styles.brand}>
        <Mark variant="plate" size={22} aria-hidden />
        <span className={styles.wordmark}>ВЕРТОВ</span>
      </span>
      <span className={styles.separator} aria-hidden="true" />

      <ProjectChromeContext projectContext={projectContext} />

      <div className={styles.account}>
        <SearchLauncher apiUrl={apiUrl} className={styles.search} />
        {!isAnonymous && (
          <Link href="/pricing" className={styles.upgrade}>
            Апгрейд
          </Link>
        )}
        {/* CSS-module classes type as `string | undefined`; BalanceWidget wants a
            string, so the fallback is load-bearing, not defensive noise. */}
        <BalanceWidget initial={balance} apiUrl={apiUrl} className={styles.balance ?? ''} />
        <div className={styles.profile}>
          <ProfileMenu
            email={email}
            balance={balance}
            apiUrl={apiUrl}
            plan={plan}
            isAnonymous={isAnonymous}
          />
        </div>
      </div>
    </header>
  );
}
