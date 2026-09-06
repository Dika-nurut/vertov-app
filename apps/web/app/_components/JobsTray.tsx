'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, CheckCircle2, Clock3, XCircle } from '@/components/ui/icons';
import { modelDisplayNameFromId } from '../../lib/models';
import { assetSrc } from '@/lib/asset-src';
import { BALANCE_INVALIDATE_EVENT } from './BalanceWidget';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Header jobs tray: live view of the user's recent generations so firing a
 * job never blocks the rest of the app. Status updates arrive over SSE
 * (GET /v1/jobs/events); a slow poll only runs while something is active,
 * as a fallback for dropped connections.
 *
 * Other surfaces can listen for the re-dispatched `seed:job-event`
 * CustomEvent instead of opening their own EventSource, and should fire
 * `seed:job-submitted` after POST /v1/jobs so the tray picks the new job
 * up immediately.
 */
export const JOB_EVENT = 'seed:job-event';
export const JOB_SUBMITTED_EVENT = 'seed:job-submitted';

interface TrayJob {
  id: string;
  status: string;
  modelId: string;
  modelDisplayName: string | null;
  resultAssets: string[];
  errorCode: string | null;
  createdAt: string;
}

const ACTIVE = new Set(['queued', 'running']);
const STATUS_LABEL: Record<string, string> = {
  queued: 'В очереди',
  running: 'Генерируем…',
  succeeded: 'Готово',
  failed: 'Ошибка',
  refunded: 'Возврат',
};

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

/**
 * Data-only hook (extracted 2026-07-07 header redesign): the SSE + poll
 * logic, with no popover/trigger opinion, so ProfileMenu can embed the same
 * live job list as a dropdown section instead of its own header icon.
 */
export function useJobsTray(apiUrl: string): { jobs: TrayJob[]; activeCount: number } {
  const [jobs, setJobs] = useState<TrayJob[]>([]);
  const jobsRef = useRef<TrayJob[]>([]);
  jobsRef.current = jobs;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/v1/jobs?limit=12`, { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { rows: TrayJob[] };
      const rows = data.rows ?? [];
      // Heal the event bus when SSE is down. The SSE handler below is the only
      // thing that re-dispatches JOB_EVENT, but the trycloudflare tunnel keeps
      // dropping that stream — leaving the poll as our one resilient channel.
      // So mirror SSE here: re-dispatch JOB_EVENT for any job whose status
      // changed since the last snapshot, so bus listeners (the Generate stage)
      // resolve even when the stream is gone. Untracked jobs are ignored by the
      // consumer, so a first-load burst is harmless.
      const prev = jobsRef.current;
      for (const r of rows) {
        const before = prev.find((p) => p.id === r.id);
        if (!before || before.status !== r.status) {
          window.dispatchEvent(
            new CustomEvent(JOB_EVENT, {
              detail: { jobId: r.id, status: r.status, source: 'generation' },
            }),
          );
        }
      }
      setJobs(rows);
    } catch {
      // transient — next event or poll retries
    }
  }, [apiUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // SSE: update in place; unknown job ids mean something was submitted
  // elsewhere (another tab, generate screen) — refetch the page once.
  // The browser auto-reconnects an EventSource on a clean drop, but a
  // proxy/server restart can land it in CLOSED with no retry — so we
  // reconnect ourselves with capped backoff and refetch on every (re)open
  // to catch anything missed while disconnected.
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      es = new EventSource(`${apiUrl}/v1/jobs/events`, { withCredentials: true });
      es.onopen = () => {
        attempt = 0;
        // Reconcile state we may have missed while the stream was down.
        void refresh();
      };
      es.addEventListener('job', (e) => {
        let evt: { jobId: string; status: string; source: string };
        try {
          evt = JSON.parse((e as MessageEvent).data);
        } catch {
          return;
        }
        window.dispatchEvent(new CustomEvent(JOB_EVENT, { detail: evt }));
        if (evt.source !== 'generation') return;
        const known = jobsRef.current.some((j) => j.id === evt.jobId);
        if (!known) {
          void refresh();
          return;
        }
        setJobs((prev) => prev.map((j) => (j.id === evt.jobId ? { ...j, status: evt.status } : j)));
        if (evt.status === 'succeeded' || evt.status === 'failed') {
          window.dispatchEvent(new Event(BALANCE_INVALIDATE_EVENT));
          // Terminal events carry no assets — pull the row to show the thumb.
          void refresh();
        }
      });
      es.onerror = () => {
        // EventSource fires onerror on transient blips too; only act when it
        // has actually given up (CLOSED). Otherwise let the browser retry.
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          const delay = Math.min(30_000, 1_000 * 2 ** attempt);
          attempt += 1;
          retry = setTimeout(connect, delay);
        }
      };
    };

    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [apiUrl, refresh]);

  // New submissions from this tab land instantly.
  useEffect(() => {
    const onSubmitted = () => void refresh();
    window.addEventListener(JOB_SUBMITTED_EVENT, onSubmitted);
    return () => window.removeEventListener(JOB_SUBMITTED_EVENT, onSubmitted);
  }, [refresh]);

  // Polling safety net, only while something is in flight.
  const activeCount = jobs.filter((j) => ACTIVE.has(j.status)).length;
  useEffect(() => {
    if (activeCount === 0) return;
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [activeCount, refresh]);

  return { jobs, activeCount };
}

/**
 * The recent-generations list — pure presentation, extracted so ProfileMenu
 * can embed it as a dropdown section. `onNavigate` closes the host popover
 * when a finished job is clicked through to /gallery.
 */
export function JobsTrayPanel({
  jobs,
  onNavigate = () => {},
}: {
  jobs: TrayJob[];
  onNavigate?: () => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-[color:var(--color-muted-foreground)]">
        Пока ничего не генерировали
      </div>
    );
  }
  return (
    <ul className="max-h-[320px] overflow-y-auto seed-scroll">
      {jobs.map((job) => {
        const active = ACTIVE.has(job.status);
        const thumb = job.resultAssets[0];
        const row = (
          <div className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-[color:var(--color-surface2)]">
            <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)]">
              {job.status === 'succeeded' && thumb ? (
                isVideoUrl(thumb) ? (
                  <video
                    src={thumb}
                    muted
                    preload="metadata"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetSrc(thumb)} alt="" className="h-full w-full object-cover" />
                )
              ) : active ? (
                <Clock3
                  size={16}
                  className="text-[color:var(--color-muted-foreground)]"
                  aria-hidden
                />
              ) : job.status === 'failed' ? (
                <XCircle size={16} className="text-destructive/80" aria-hidden />
              ) : (
                <CheckCircle2
                  size={16}
                  className="text-[color:var(--color-muted-foreground)]"
                  aria-hidden
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-[color:var(--color-fg)]">
                {job.modelDisplayName ?? modelDisplayNameFromId(job.modelId)}
              </div>
              <div className="flex items-center gap-1.5 text-[12px] text-[color:var(--color-muted-foreground)]">
                {active && (
                  <span
                    aria-hidden
                    className="seed-pulse-dot h-1.5 w-1.5 bg-[color:var(--color-accent)]"
                  />
                )}
                {STATUS_LABEL[job.status] ?? job.status}
              </div>
            </div>
          </div>
        );
        return (
          <li key={job.id}>
            {job.status === 'succeeded' ? (
              <Link href={`/gallery/${job.id}`} onClick={onNavigate}>
                {row}
              </Link>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Self-contained popover version (hook + panel + trigger). No longer wired
 * into AppShell's header (2026-07-07: the jobs list moved into ProfileMenu),
 * kept as a standalone unit in case another surface wants a dedicated tray.
 */
export function JobsTray({ apiUrl }: { apiUrl: string }) {
  const { jobs, activeCount } = useJobsTray(apiUrl);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="jobs-tray-button"
          aria-label="Задачи генерации"
          className="press relative flex h-9 items-center gap-2 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 text-sm text-[color:var(--color-muted-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] hover:text-[color:var(--color-fg)]"
        >
          <Activity size={15} aria-hidden />
          {activeCount > 0 && (
            <>
              <span className="tnum text-[13px] font-bold text-[color:var(--color-fg)]">
                {activeCount}
              </span>
              <span
                aria-hidden
                className="seed-pulse-dot absolute -top-1 -right-1 h-2.5 w-2.5 border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)]"
              />
            </>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        data-testid="jobs-tray-panel"
        align="end"
        className="w-[320px] overflow-hidden p-1.5"
      >
        <div className="px-2.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-faint)]">
          Генерации
        </div>
        <JobsTrayPanel jobs={jobs} onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
