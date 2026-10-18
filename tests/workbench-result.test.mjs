import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCumulativeDecisions, buildCumulativeCsv } from '../workbench/public/review-model.mjs';

test('cumulative decision CSV preserves four columns, reason text and exact tuple order', () => {
  const applied = [{ action: 'reject', left_id: 'a|b', right_id: null, reason: 'review, retained' }];
  const pending = [{ action: 'accept', left_id: 'L1', right_id: 'R1', reason: 'manual "choice"' }];
  assert.equal(buildCumulativeCsv(applied, pending), 'action,left_id,right_id,reason\nreject,a|b,,"review, retained"\naccept,L1,R1,"manual ""choice"""\n');
});

test('decision subset identity is collision free for delimiter-containing tuple values', () => {
  const parent = [{ action: 'accept', left_id: 'L|x', right_id: 'R', reason: 'ok' }];
  const collision = [{ action: 'accept', left_id: 'L', right_id: 'x|R', reason: 'ok' }];
  assert.throws(() => assertCumulativeDecisions(parent, collision), error => error.code === 'noncumulative_decisions');
  assert.doesNotThrow(() => assertCumulativeDecisions(parent, [...parent]));
});
