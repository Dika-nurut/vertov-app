import type { Metadata } from 'next';
import { fetchModels, apiBaseUrl } from '../_lib';
import { Panel, Eyebrow } from '../_components/ui';
import { ModelsTable } from './ModelsTable';
import { ErrorState } from '../../_components/states/ErrorState';

export const metadata: Metadata = { title: 'АДМИН · Модели' };
export const dynamic = 'force-dynamic';

export default async function ModelsPage() {
  const data = await fetchModels();
  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-3xl font-black tracking-tight">АДМИН · Модели</h1>
        <p className="mt-1 text-xs text-faint">
          Переключатели активности и цены · каждое изменение — в аудит-лог
        </p>
      </header>
      {!data ? (
        <ErrorState message="Не удалось загрузить каталог. Попробуйте обновить страницу." />
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
