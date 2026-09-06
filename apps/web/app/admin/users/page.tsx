import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchUsers, dt } from '../_lib';
import { Panel } from '../_components/ui';

export const metadata: Metadata = { title: 'Вертов · Админ · Пользователи' };
export const dynamic = 'force-dynamic';

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const q = ((await searchParams).q ?? '').trim();
  const data = q ? await fetchUsers(q) : null;

  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-3xl font-black tracking-tight">Пользователи</h1>
        <p className="mt-1 text-xs text-faint">Поиск по email или точному id · баланс · история</p>
      </header>

      <form method="get" className="mb-5 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="email или id пользователя"
          className="w-full max-w-md border-[2.5px] border-line bg-[color:var(--color-surface2)] px-4 py-2.5 text-sm outline-none placeholder:text-faint focus:shadow-[3px_3px_0_0_var(--color-accent)]"
        />
        <button
          type="submit"
          className="border-[2.5px] border-line bg-accent px-5 py-2.5 text-sm font-bold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-line)] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none"
        >
          Найти
        </button>
      </form>

      {/* A failed fetch (data === null) must not read as "user not found" — an
          operator could re-grant credits believing the account doesn't exist. */}
      {q && !data && (
        <div className="flex h-32 items-center justify-center border-[2.5px] border-dashed border-[color:var(--color-line-soft)] text-sm text-faint">
          Не удалось выполнить поиск (API недоступен).
        </div>
      )}
      {q && data && (
        <Panel className="px-5 py-1.5">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="[&>th]:border-b-[2.5px] [&>th]:border-line [&>th]:px-3 [&>th]:pb-3 [&>th]:text-left [&>th]:font-mono [&>th]:text-[9.5px] [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-faint">
                <th>Email</th>
                <th>Имя</th>
                <th>Тариф</th>
                <th>Статус</th>
                <th>Регистрация</th>
              </tr>
            </thead>
            <tbody className="[&>tr>td]:border-b-[2.5px] [&>tr>td]:border-[color:var(--color-line-soft)] [&>tr>td]:px-3 [&>tr>td]:py-2.5 [&>tr:last-child>td]:border-b-0">
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-faint">
                    Ничего не найдено.
                  </td>
                </tr>
              )}
              {data.rows.map((u) => (
                <tr key={u.id} className="hover:bg-[color:var(--color-muted)]">
                  <td>
                    <Link href={`/admin/users/${u.id}`} className="text-accent hover:underline">
                      {u.email ?? '—'}
                    </Link>
                    <div className="font-mono text-[10px] text-faint">{u.id}</div>
                  </td>
                  <td>{u.displayName ?? '—'}</td>
                  <td className="font-mono text-[11px] capitalize">{u.tier}</td>
                  <td className="font-mono text-[11px]">{u.status}</td>
                  <td className="font-mono text-[11px] text-faint">{dt(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      {!q && <p className="text-sm text-faint">Введи email или id, чтобы найти пользователя.</p>}
    </>
  );
}
