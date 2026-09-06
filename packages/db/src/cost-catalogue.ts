import { costLegFile } from './cost-legs-data';
import { buildCatalogue, type CatalogueEntry } from './price-catalogue';

let cached: readonly CatalogueEntry[] | undefined;

/** The generated finance catalogue, built once per process. */
export function costCatalogue(): readonly CatalogueEntry[] {
  cached ??= buildCatalogue(costLegFile);
  return cached;
}
