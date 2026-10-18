import { renderCsv } from '../../cli/render.mjs';

const tuple = decision => JSON.stringify([
  decision.action,
  decision.left_id ?? null,
  decision.right_id ?? null,
  decision.reason ?? '',
]);

export function buildCumulativeCsv(applied, pending) {
  const rows = [...applied, ...pending].map(decision => [
    decision.action ?? '',
    decision.left_id ?? '',
    decision.right_id ?? '',
    decision.reason ?? '',
  ]);
  return renderCsv(['action', 'left_id', 'right_id', 'reason'], rows);
}

export function assertCumulativeDecisions(parent, child) {
  const childTuples = new Set(child.map(tuple));
  if (parent.some(decision => !childTuples.has(tuple(decision)))) {
    const error = new Error('The new Result dropped or changed an applied decision');
    Object.assign(error, { code: 'noncumulative_decisions', status: 409 });
    throw error;
  }
}
