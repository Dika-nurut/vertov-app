import type { Metadata } from 'next';
import { fetchModels, apiBaseUrl } from '../_lib';
import { Panel, Eyebrow } from '../_components/ui';
import { ModelsTable } from './ModelsTable';

export const metadata: Metadata = { title: 'Вертов · Админ · Модели' };
export const dynamic = 'force-dynamic';

export default async function ModelsPage() {
  const data = await fetchModels();
  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-3xl font-black tracking-tight">Модели</h1>
        <p className="mt-1 text-xs text-faint">
          Переключатели активности и цены · каждое изменение — в аудит-лог
        </p>
      </header>
      {!data ? (
        <div className="flex h-48 items-center justify-center border-[2.5px] border-dashed border-[color:var(--color-line-soft)] text-sm text-faint">
          Не удалось загрузить каталог.
        </div>
      ) : (
        <>
          <Eyebrow>
            Маржа при худшем курсе токена ({data.creditRubValue.toFixed(3)} ₽/токен · $×
            {data.usdToRub.direct.toFixed(2)} direct / {data.usdToRub.openrouter.toFixed(2)} OR)
          </Eyebrow>
          <Panel className="px-5 py-1.5">
            <ModelsTable data={data} apiUrl={apiBaseUrl()} />
          </Panel>
        </>
      )}
    </>
  );
}
