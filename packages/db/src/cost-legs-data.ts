import data from '../seed/cost-legs.generated.json';
import type { CostLegFile } from './cost-legs';

export const costLegFile = data as CostLegFile;
export const COST_LEG_FILE = costLegFile;
