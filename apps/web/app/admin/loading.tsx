import { Skeleton } from '@/components/ui/skeleton';

export default function AdminLoading() {
  return (
    <div className="grid min-h-screen grid-cols-[232px_1fr] bg-bg text-fg">
      <aside
        className="border-r-[2.5px] border-line bg-surface shadow-[var(--offset)]"
        aria-hidden
      />
      <main className="max-w-[1180px] px-8 py-7 pb-16" aria-busy="true">
        <Skeleton className="mb-6 h-8 w-48" />
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-5">
          {[1, 2, 3, 4, 5].map((item) => (
            <Skeleton key={item} className="h-24" />
          ))}
        </div>
      </main>
    </div>
  );
}
