import type { Metadata } from 'next';
import { fetchGeneration, parseDays, n, pct, ms } from '../_lib';
import { WindowPills, Eyebrow, Panel } from '../_components/ui';
import { modelDisplayName } from '@/lib/models';

export const metadata: Metadata = { title: 'Вертов · Админ · Генерация' };
export const dynamic = 'force-dynamic';

export default async function GenerationPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  // Default to 30 — a value that exists in WINDOWS so a pill highlights (14 would
  // leave every pill unselected and be unreachable via the selector).
  const days = parseDays((await searchParams).days, 30);
  const g = await fetchGeneration(days);
  if (!g) {
    return (
      <div className="flex h-64 items-center justify-center border-[2.5px] border-dashed border-[color:var(--color-line-soft)] text-sm text-faint">
        Не удалось загрузить аналитику (API недоступен).
      </div>
    );
  }

  // Pivot daily rows into per-day {image,video} totals for the stacked chart.
  const byDay = new Map<string, { image: number; video: number }>();
  for (const r of g.daily) {
    const slot = byDay.get(r.day) ?? { image: 0, video: 0 };
    if (r.kind === 'video') slot.video += r.total;
    else slot.image += r.total; // image | image-edit both read as "image" here
    byDay.set(r.day, slot);
  }
  const cols = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const maxCol = Math.max(1, ...cols.map(([, v]) => v.image + v.video));

  return (
    <>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-black tracking-tight">Генерация</h1>
          <p className="mt-1 text-xs text-faint">
            Задачи · успех · латентность vs ожидание · окно {days} дней
          </p>
        </div>
        <WindowPills days={days} basePath="/admin/generation" />
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* jobs/day stacked bars */}
        <Panel>
          <h3 className="mb-4 text-[15px] font-bold">Задачи в день</h3>
          {cols.length === 0 ? (
            <p className="text-sm text-faint">Нет задач за окно.</p>
          ) : (
            <>
              <div className="flex h-[150px] items-end gap-1.5 pt-2.5">
                {cols.map(([day, v]) => (
                  <div key={day} className="flex flex-1 flex-col-reverse gap-0.5" title={day}>
                    <div
                      className="w-full bg-accent"
                      style={{ height: `${(v.image / maxCol) * 130}px` }}
                    />
                    <div
                      className="w-full bg-accent2"
                      style={{ height: `${(v.video / maxCol) * 130}px` }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-3.5 flex gap-4 font-mono text-[10px] text-faint">
                <span className="flex items-center gap-1.5">
                  <i className="inline-block size-2.5 border-2 border-line bg-accent" />
                  Изображения
                </span>
                <span className="flex items-center gap-1.5">
                  <i className="inline-block size-2.5 border-2 border-line bg-accent2" />
                  Видео
                </span>
              </div>
            </>
          )}
        </Panel>

        {/* success rate by kind */}
        <Panel>
          <h3 className="mb-4 text-[15px] font-bold">Доля успеха по типу</h3>
          <div className="flex flex-wrap gap-7">
            {g.successRate.map((r) => (
              <div key={r.kind} className="text-center">
                <div
                  className={
                    'font-display text-[34px] font-black ' +
                    (r.successPct != null && r.successPct >= 0.95
                      ? 'text-positive'
                      : 'text-[color:var(--color-accent2)]')
                  }
                >
                  {pct(r.successPct)}
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase text-faint">
                  {r.kind} · {n(r.total)}
                </div>
              </div>
            ))}
            {g.successRate.length === 0 && <p className="text-sm text-faint">Нет данных.</p>}
          </div>
          <div className="mt-5 text-[12px] text-faint">
            Провалы: <b className="text-fg">{n(g.successRate.reduce((s, r) => s + r.failed, 0))}</b>{' '}
            · возвраты токенов:{' '}
            <b className="text-fg">{n(g.successRate.reduce((s, r) => s + r.refunded, 0))}</b>
          </div>
        </Panel>
      </div>

      {/* latency table */}
      <section className="mt-6">
        <Eyebrow>Латентность · измеренная vs ожидаемая (мс)</Eyebrow>
        <p className="mb-3 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
          Для каждой модели — фактическая скорость выполнения задач (от старта до готового
          результата): <b className="text-fg">p50</b> — типичное время (медиана),{' '}
          <b className="text-fg">p95</b> — «долгий хвост» (95% задач укладываются в него) — рядом с{' '}
          <b className="text-fg">ожидаемыми</b> значениями, заявленными для модели.{' '}
          <span className="text-fg">На что смотреть:</span> если измеренный p95 выше ожидаемого
          (подсвечен красным) — модель или её провайдер работают медленнее нормы (перегрузка,
          деградация провайдера, проблемы сети). Единичные всплески — норма; устойчивое превышение
          p95 — повод проверить провайдера или временно отключить модель во вкладке «Модели». Строки
          с малым числом замеров статистически шумны.
        </p>
        <Panel className="px-5 py-1.5">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="[&>th]:border-b-[2.5px] [&>th]:border-line [&>th]:px-3 [&>th]:pb-3 [&>th]:font-mono [&>th]:text-[9.5px] [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-faint">
                <th className="text-left">Модель</th>
                <th className="text-left">ID модели</th>
                <th className="text-right">Замеры</th>
                <th className="text-right">p50</th>
                <th className="text-right">p95</th>
                <th className="text-right">ожид. p50</th>
                <th className="text-right">ожид. p95</th>
              </tr>
            </thead>
            <tbody className="[&>tr>td]:border-b-[2.5px] [&>tr>td]:border-[color:var(--color-line-soft)] [&>tr>td]:px-3 [&>tr>td]:py-2.5 [&>tr>td]:tabular-nums [&>tr:last-child>td]:border-b-0">
              {g.latency.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-faint">
                    Нет завершённых задач с таймингом за окно.
                  </td>
                </tr>
              )}
              {g.latency.map((l) => {
                const breach = l.p95Ms != null && l.p95Ms > l.expectedP95Ms;
                return (
                  <tr key={l.modelId}>
                    <td className="text-left text-[12px]">{modelDisplayName(l.model)}</td>
                    <td className="text-left font-mono text-[11px] text-faint">{l.modelId}</td>
                    <td className="text-right">{n(l.samples)}</td>
                    <td className="text-right">{ms(l.p50Ms)}</td>
                    <td className={'text-right' + (breach ? ' font-bold text-destructive' : '')}>
                      {ms(l.p95Ms)}
                    </td>
                    <td className="text-right text-faint">{n(l.expectedP50Ms)}</td>
                    <td className="text-right text-faint">{n(l.expectedP95Ms)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      </section>

      {/* pending-instrumentation + fallback health cards */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PendingCard title="Лидерборд пресетов" reason={g.presetLeaderboard.reason} />
        {g.fallback.available ? (
          <Panel>
            <Eyebrow>Срабатывания фолбэка</Eyebrow>
            <p className="mt-2 font-mono text-2xl font-black">
              {n(g.fallback.fellBack)}
              <span className="text-sm font-normal text-faint"> / {n(g.fallback.total)} задач</span>
            </p>
            <p className="mt-2 text-[13px] text-faint">{g.fallback.reason}</p>
            <p className="mt-2 text-[13px] text-faint">
              Настройка резервного шлюза по модели — на странице{' '}
              <a href="/admin/models" className="underline">
                Модели
              </a>
              .
            </p>
          </Panel>
        ) : (
          <PendingCard title="Срабатывания фолбэка" reason={g.fallback.reason} />
        )}
      </div>
    </>
  );
}

function PendingCard({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="border-[2.5px] border-dashed border-[color:var(--color-line-soft)] px-4 py-4 text-[13px] text-faint">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-[color:var(--color-accent2)]">
        ⧗ Ожидает инструментации
      </div>
      <b className="text-fg">{title}</b> — {reason}
    </div>
  );
}
