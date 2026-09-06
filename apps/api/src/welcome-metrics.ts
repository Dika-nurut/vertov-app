import type { WelcomeGrantResult } from '@seed/credits';

/** Daily grants have durable per-date detail in free_grant_events, not Prometheus labels. */
export function welcomeMetricLevel(level: WelcomeGrantResult['level']): string {
  return level.startsWith('DAILY:') ? 'DAILY' : level;
}
