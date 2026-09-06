import type { Metadata } from 'next';
import {
  fetchCockpit,
  fetchFunnel,
  fetchProviderBalances,
  parseDays,
  n,
  rub,
  pct,
  apiBaseUrl,
} from './_lib';
import { WindowPills, Eyebrow, Panel, Tile, Bar } from './_components/ui';
import { TokenStar } from '@/components/ui/token-star';
import { modelDisplayName } from '@/lib/models';
import { TextTiers } from './TextTiers';

export const metadata: Metadata = { title: 'Vertov' };
export const dynamic = 'force-dynamic';

export default async function CockpitPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const days = parseDays((await searchParams).days);
  const [c, funnel, balances] = await Promise.all([
    fetchCockpit(days),
    fetchFunnel(days),
    fetchProviderBalances(),
  ]);

  if (!c) {
    return <Unavailable />;
  }

  const maxTierCount = Math.max(1, ...c.subscriptions.byTier.map((t) => t.count));
  const funnelBase = Math.max(1, funnel?.steps[0]?.count ?? 1);
  const marginGood = (m: number | null) => m != null && m >= 0.3;
  const cohortPct = (value: number, total: number) => (total > 0 ? pct(value / total, 0) : '—');

  return (
    <>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-black tracking-tight">Кокпит</h1>
          <p className="mt-1 text-xs text-faint">Бизнес-метрики · маржа · окно {days} дней</p>
        </div>
        <WindowPills days={days} basePath="/admin" />
      </header>

      {/* stat tiles */}
      <div className="grid grid-cols-2 gap-3.5 md:grid-cols-5">
        <Tile label="MRR" value={n(c.subscriptions.mrrRub)} unit="₽" />
        <Tile label="ARR" value={n(c.subscriptions.arrRub)} unit="₽" />
        <Tile
          label="Активные подписки"
          value={n(c.subscriptions.activeCount)}
          foot={
            c.subscriptions.trialingCount > 0 ? (
              <span className="font-mono text-[10px] text-faint">
                из них {n(c.subscriptions.trialingCount)} на триале (MRR не учитывает)
              </span>
            ) : undefined
          }
        />
        <Tile label={`Выручка · ${days}д`} value={n(c.revenue.grossRub)} unit="₽" />
        <Tile
          label={`Смешанная маржа${c.margin.blended.approximate ? ' · ≈' : ''}`}
          value={pct(c.margin.blended.marginPct)}
          foot={
            <span className="inline-flex border-2 border-[color:var(--color-line-soft)] px-1.5 py-0.5 font-mono text-[10px] text-faint">
              порог 30%
            </span>
          }
        />
      </div>

      {/* Provider prepaid balances — a drained balance silently fails jobs */}
      <section className="mt-6">
        <Eyebrow>Балансы провайдеров · активный шлюз: {balances?.activeGateway ?? '—'}</Eyebrow>
        {!balances ? (
          <p className="text-sm text-faint">Не удалось загрузить балансы провайдеров.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
            {balances.providers.map((p) => (
              <div
                key={p.provider}
                className={
                  'border-[2.5px] bg-surface p-4 ' +
                  (p.active
                    ? 'border-line shadow-[4px_4px_0_0_var(--color-accent)]'
                    : 'border-[color:var(--color-line-soft)]')
                }
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
                    {p.label}
                  </span>
                  {p.active && (
                    <span className="bg-accent2 px-1.5 font-mono text-[8px] uppercase text-[color:var(--color-accent2-foreground)]">
                      актив
                    </span>
                  )}
                </div>
                <div
                  className={
                    'my-1.5 font-display text-[22px] font-black tracking-tight ' +
                    (p.status === 'ok' && p.low
                      ? 'text-destructive'
                      : p.status === 'ok'
                        ? 'text-positive'
                        : 'text-faint')
                  }
                >
                  {p.status === 'ok' && p.balance != null ? (
                    p.unit === 'usd' ? (
                      `$${p.balance.toFixed(2)}`
                    ) : (
                      <>
                        <TokenStar size={11} />
                        {n(p.balance)}
                      </>
                    )
                  ) : p.status === 'no_api' ? (
                    '—'
                  ) : (
                    'ошибка'
                  )}
                </div>
                <a
                  href={p.dashboardUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[10px] text-faint underline decoration-dotted hover:text-fg"
                >
                  {p.status === 'no_api'
                    ? 'нет API · дашборд ↗'
                    : p.low
                      ? '⚠ низкий · пополнить ↗'
                      : 'дашборд ↗'}
                </a>
              </div>
            ))}
          </div>
        )}
        {/* «Сценарий» text tiers — route badges + the admin ON/OFF switch
            (server-enforced: a disabled tier 409s assist calls) */}
        {balances?.textModels && balances.textModels.length > 0 && (
          <TextTiers items={balances.textModels} apiUrl={apiBaseUrl()} />
        )}
      </section>

      {/* Active payment-provider note */}
      <div className="mt-4 flex items-center gap-2.5 border-[2.5px] border-l-[2.5px] border-line border-l-[color:var(--color-accent2)] bg-[color:var(--color-surface2)] px-4 py-3 text-[13px] text-faint">
        <span className="font-mono text-[11px] text-[color:var(--color-accent2)]">
          {c.revenue.psp === 'tochka' ? 'ТОЧКА БАНК' : 'ЮKASSA'}
        </span>
        <span>{c.revenue.note}</span>
      </div>

      {/* subs-by-tier + funnel */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel>
          <h3 className="mb-4 text-[15px] font-bold">Подписки по тарифам</h3>
          {c.subscriptions.byTier.length === 0 && (
            <p className="text-sm text-faint">Активных подписок пока нет.</p>
          )}
          {c.subscriptions.byTier.map((t, i) => (
            <div key={t.tier} className="mb-3.5 grid grid-cols-[84px_1fr_auto] items-center gap-3">
              <span className="text-[13px] font-semibold capitalize">{t.tier}</span>
              <Bar pctWidth={(t.count / maxTierCount) * 100} lime={i % 2 === 1} />
              <span className="whitespace-nowrap font-mono text-[11px] text-faint">
                {n(t.count)} · {rub(t.mrrRub)}
              </span>
            </div>
          ))}
          <div className="mt-5 grid grid-cols-[84px_1fr_auto] items-center gap-3">
            <span className="font-mono text-[11px] text-faint">ОТТОК·{days}д</span>
            <Bar pctWidth={c.subscriptions.churn.ratePct * 100} danger />
            <span className="whitespace-nowrap font-mono text-[11px] text-faint">
              {pct(c.subscriptions.churn.ratePct)} · прибл.
            </span>
          </div>
        </Panel>

        <Panel>
          <h3 className="mb-4 text-[15px] font-bold">Воронка · {days} дней</h3>
          {funnel?.steps.map((s) => (
            <div key={s.key} className="mb-3 grid grid-cols-[130px_1fr] items-center gap-3">
              <span className="text-[13px]">
                {s.label}
                <b className="block font-display text-lg font-black">{n(s.count)}</b>
                {s.conv != null && (
                  <span className="font-mono text-[10px] text-positive">
                    {pct(s.conv, 0)} от регистраций
                  </span>
                )}
              </span>
              <Bar pctWidth={(s.count / funnelBase) * 100} lime={s.key === 'paid'} />
            </div>
          ))}
          {funnel && (
            <p className="mt-1.5 font-mono text-[9px] uppercase tracking-widest text-faint">
              {funnel.landingVisit.reason}
            </p>
          )}
          {funnel?.wowVideo && funnel.wowVideo.count > 0 && (
            <div className="mt-4 border-t-[2px] border-[color:var(--color-line-soft)] pt-3">
              <span className="text-[13px]">
                <b className="block font-display text-lg font-black">{n(funnel.wowVideo.count)}</b>
                <span className="font-mono text-[10px] text-faint">первый готовый ролик</span>
                {funnel.wowVideo.conv != null && (
                  <span className="ml-1.5 font-mono text-[10px] text-positive">
                    {pct(funnel.wowVideo.conv, 0)} от регистраций
                  </span>
                )}
              </span>
            </div>
          )}
          {funnel?.byChannel && funnel.byChannel.length > 0 && (
            <div className="mt-4 border-t-[2px] border-[color:var(--color-line-soft)] pt-3">
              <p className="mb-2 font-mono text-[9px] uppercase tracking-widest text-faint">
                По каналу
              </p>
              {funnel.byChannel.map((ch) => (
                <div key={ch.channel} className="flex items-center justify-between py-0.5">
                  <span className="font-mono text-[11px]">{ch.channel}</span>
                  <span className="font-mono text-[11px] text-faint">{n(ch.signups)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {funnel?.cohorts && funnel.cohorts.length > 0 && (
        <section className="mt-4">
          <Panel className="overflow-x-auto px-5 py-4">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h3 className="text-[15px] font-bold">Когорты по неделям</h3>
              <span className="font-mono text-[9px] uppercase tracking-widest text-faint">
                DB truth · без анонимных визитов
              </span>
            </div>
            <table className="min-w-[960px] w-full border-collapse text-[11px]">
              <thead>
                <tr className="[&>th]:border-b-[2.5px] [&>th]:border-line [&>th]:px-2 [&>th]:pb-2 [&>th]:font-mono [&>th]:text-[9px] [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-faint">
                  <th className="text-left">Неделя</th>
                  <th className="text-left">Канал</th>
                  <th className="text-right">Рег.</th>
                  <th className="text-right">Попытки</th>
                  <th className="text-right">Активация</th>
                  <th className="text-right">Ролик</th>
                  <th className="text-right">Оплата</th>
                  <th className="text-right">Выручка</th>
                  <th className="text-right">Возврат</th>
                  <th className="text-right">D1 / D7 / D30</th>
                </tr>
              </thead>
              <tbody className="[&>tr>td]:border-b-[1.5px] [&>tr>td]:border-[color:var(--color-line-soft)] [&>tr>td]:px-2 [&>tr>td]:py-2 [&>tr:last-child>td]:border-b-0">
                {funnel.cohorts.map((cohort) => (
                  <tr key={`${cohort.cohort}:${cohort.channel}`}>
                    <td className="font-mono tabular-nums">{cohort.cohort}</td>
                    <td className="font-mono">{cohort.channel}</td>
                    <td className="text-right tabular-nums">{n(cohort.signups)}</td>
                    <td className="text-right tabular-nums">{n(cohort.attempted)}</td>
                    <td className="text-right tabular-nums">
                      {cohortPct(cohort.activated, cohort.signups)}
                    </td>
                    <td className="text-right tabular-nums">
                      {cohortPct(cohort.wowVideo, cohort.signups)}
                    </td>
                    <td className="text-right tabular-nums">
                      {cohortPct(cohort.paid, cohort.signups)}
                    </td>
                    <td className="text-right tabular-nums">{rub(cohort.revenueRub)}</td>
                    <td className="text-right tabular-nums">{rub(cohort.refundedRub)}</td>
                    <td className="text-right font-mono tabular-nums text-faint">
                      {cohortPct(cohort.retention.d1, cohort.signups)} /{' '}
                      {cohortPct(cohort.retention.d7, cohort.signups)} /{' '}
                      {cohortPct(cohort.retention.d30, cohort.signups)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </section>
      )}

      {/* margin table */}
      <section className="mt-8">
        <Eyebrow>
          Маржа по моделям · себестоимость $ × {c.margin.usdToRub.direct.toFixed(2)} direct /
          {c.margin.usdToRub.openrouter.toFixed(2)} OR vs выручка (
          {c.margin.creditRubValue.toFixed(3)} ₽/токен)
        </Eyebrow>
        <Panel className="px-5 py-1.5">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="[&>th]:border-b-[2.5px] [&>th]:border-line [&>th]:px-3 [&>th]:pb-3 [&>th]:font-mono [&>th]:text-[9.5px] [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-faint">
                <th className="text-left">Модель</th>
                <th className="text-left">ID модели</th>
                <th className="text-right">Задачи</th>
                <th className="text-right">Токены</th>
                <th className="text-right">Выручка ₽</th>
                <th className="text-right">Себест. ₽</th>
                <th className="text-right">Маржа</th>
              </tr>
            </thead>
            <tbody className="[&>tr>td]:border-b-[2.5px] [&>tr>td]:border-[color:var(--color-line-soft)] [&>tr>td]:px-3 [&>tr>td]:py-2.5 [&>tr>td]:tabular-nums [&>tr:last-child>td]:border-b-0">
              {c.margin.perModel.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-faint">
                    Нет успешных задач за окно.
                  </td>
                </tr>
              )}
              {c.margin.perModel.map((m) => (
                <tr key={m.modelId}>
                  <td className="text-left">
                    <span className="text-[12px]">{modelDisplayName(m.model)}</span>
                    <span className="ml-2 border-2 border-[color:var(--color-line-soft)] px-1.5 py-0.5 font-mono text-[9px] uppercase text-faint">
                      {m.kind}
                    </span>
                    {m.approximate && (
                      <span className="ml-2 font-mono text-[9px] uppercase text-faint">
                        ≈ приблизительно
                      </span>
                    )}
                    {m.costUnknown.jobs > 0 && (
                      // A leg we cannot price must READ as a hole, not disappear
                      // into the priced total — that silence is the bug being fixed.
                      <span
                        className="ml-2 border-2 border-destructive px-1.5 py-0.5 font-mono text-[9px] uppercase text-destructive"
                        title={`Себестоимость неизвестна для ног: ${m.costUnknown.legs.join(', ')}`}
                      >
                        себест. ? · {n(m.costUnknown.jobs)} задач
                      </span>
                    )}
                  </td>
                  <td className="text-left font-mono text-[11px] text-faint">{m.modelId}</td>
                  <td className="text-right">{n(m.jobs)}</td>
                  <td className="text-right">{n(m.creditsSpent)}</td>
                  <td className="text-right">{n(m.revenueRub)}</td>
                  <td className="text-right">{m.costRub == null ? '—' : n(m.costRub)}</td>
                  <td className="text-right">
                    <MarginPill
                      margin={m.marginPct}
                      priced={m.priced}
                      good={marginGood(m.marginPct)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            {c.margin.perModel.length > 0 && (
              <tfoot>
                <tr className="[&>td]:border-t-[2.5px] [&>td]:border-line [&>td]:px-3 [&>td]:py-3 [&>td]:font-bold [&>td]:tabular-nums">
                  <td className="text-left">
                    Смешанная (по моделям с ценой)
                    {c.margin.blended.approximate && (
                      <span className="ml-2 font-mono text-[9px] uppercase text-faint">
                        ≈ приблизительно
                      </span>
                    )}
                    {c.margin.blended.costUnknownJobs > 0 && (
                      <span className="ml-2 font-mono text-[9px] uppercase text-destructive">
                        вне расчёта: {n(c.margin.blended.costUnknownJobs)} задач без цены ноги
                      </span>
                    )}
                  </td>
                  <td />
                  <td />
                  <td className="text-right">{n(c.margin.blended.revenueRub)}</td>
                  <td className="text-right">{n(c.margin.blended.costRub)}</td>
                  <td className="text-right">
                    <MarginPill
                      margin={c.margin.blended.marginPct}
                      priced
                      good={marginGood(c.margin.blended.marginPct)}
                    />
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </Panel>
      </section>
    </>
  );
}

function MarginPill({
  margin,
  priced,
  good,
}: {
  margin: number | null;
  priced: boolean;
  good: boolean;
}) {
  if (!priced || margin == null) {
    return <span className="font-mono text-faint">нет цены</span>;
  }
  return (
    <span
      className={
        'inline-block px-2 py-0.5 font-mono font-bold ' +
        (good
          ? 'bg-positive text-[color:var(--color-positive-foreground)]'
          : 'bg-destructive text-[color:var(--color-destructive-foreground)]')
      }
    >
      {pct(margin, 0)}
    </span>
  );
}

function Unavailable() {
  return (
    <div className="flex h-64 items-center justify-center border-[2.5px] border-dashed border-[color:var(--color-line-soft)] text-sm text-faint">
      Не удалось загрузить метрики (API недоступен).
    </div>
  );
}
