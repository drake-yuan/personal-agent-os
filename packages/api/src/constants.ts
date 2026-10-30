/**
 * Mapping of each CockpitSummary distribution field to the canonical enum that
 * seeds its keys. This is the single source of truth for:
 *   - the drift guard (the CLI builder must initialise exactly these keys), and
 *   - UI legends (which status/risk/state labels to show).
 *
 * Imported from `@paos/contracts`, the package that owns the enums, so there is
 * no second copy to drift.
 */
import {
  TASK_STATUS,
  RISK_LEVEL,
  WORKFLOW_RUN_STATUS,
  DISPATCH_STATE,
} from '@paos/contracts';

export const COCKPIT_DISTRIBUTION_ENUMS = {
  tasksByStatus: TASK_STATUS,
  tasksByRisk: RISK_LEVEL,
  runsByStatus: WORKFLOW_RUN_STATUS,
  dispatchByState: DISPATCH_STATE,
} as const;

export type CockpitDistributionField = keyof typeof COCKPIT_DISTRIBUTION_ENUMS;
