import type { Metadata } from 'next';
import { fetchAudit, dt } from '../_lib';
import { Panel } from '../_components/ui';

export const metadata: Metadata = { title: 'Вертов · Админ · Аудит' };
export const dynamic = 'force-dynamic';

// Action → короткий русский ярлык (остальные показываем как есть).
const LABELS: Record<string, string> = {
  'admin.credit_grant': 'Начисление токенов',
  'admin.model_update': 'Изменение модели',
  'gallery.takedown': 'Снятие из галереи',
  'content.report': 'Жалоба на контент',
};

export default async function AuditPage() {
  const data = await fetchAudit(150);
  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-3xl font-black tracking-tight">Аудит</h1>
        <p className="mt-1 text-xs text-faint">Журнал действий · только чтение · последние 150</p>
      </header>
      {/* Distinguish an API outage from a genuinely empty log — an operator must not
          read "не удалось загрузить" as "ничего не произошло". */}
      {!data ? (
        <div className="flex h-48 items-center justify-center border-[2.5px] border-dashed border-[color:var(--color-line-soft)] text-sm text-faint">
          Не удалось загрузить журнал (API недоступен).
        </div>
      ) : (
        <Panel className="px-5 py-1.5">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="[&>th]:border-b-[2.5px] [&>th]:border-line [&>th]:px-3 [&>th]:pb-3 [&>th]:text-left [&>th]:font-mono [&>th]:text-[9.5px] [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-faint">
                <th>Когда</th>
                <th>Действие</th>
                <th>Кто</th>
                <th>Детали</th>
              </tr>
            </thead>
            <tbody className="[&>tr>td]:border-b-[2.5px] [&>tr>td]:border-[color:var(--color-line-soft)] [&>tr>td]:px-3 [&>tr>td]:py-2.5 [&>tr>td]:align-top [&>tr:last-child>td]:border-b-0">
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center text-faint">
                    Записей нет.
                  </td>
                </tr>
              )}
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap font-mono text-[11px] text-faint">
                    {dt(r.createdAt)}
                  </td>
                  <td>
                    <span className="border-2 border-[color:var(--color-line-soft)] px-2 py-0.5 font-mono text-[10px]">
                      {LABELS[r.action] ?? r.action}
                    </span>
                  </td>
                  <td className="font-mono text-[11px] text-faint">{r.userId ?? '—'}</td>
                  <td className="font-mono text-[11px] text-faint">
                    <code className="line-clamp-2 break-all">{JSON.stringify(r.payload)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      {/* Phase 4 "auth failure log": investigated — Better Auth persists no failed
          attempts and auth-throttle.ts keeps only Redis counters, so there is nothing
          to surface. Flagged (not faked) rather than adding new capture on the auth path. */}
      <p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-faint">
        ⧗ Неудачные входы отдельно не логируются (только Redis-счётчики троттлинга) — сбор не
        подключён
      </p>
    </>
  );
}
