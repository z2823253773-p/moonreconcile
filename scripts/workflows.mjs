import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'cli/main.mjs');
const requiredFiles = [
  'manifest.json', 'input/left.csv', 'input/right.csv', 'config.json',
  'report.json', 'pairs.csv', 'fields.csv', 'candidates.csv',
  'decisions.csv', 'unresolved.csv', 'summary.md',
];
const csvSchemas = {
  pairs: ['left_id', 'right_id', 'source', 'reason', 'override'],
  fields: [
    'left_id', 'right_id', 'field', 'type', 'left_raw', 'right_raw',
    'left_transformed', 'right_transformed', 'left_canonical', 'right_canonical',
    'status', 'rules', 'difference', 'tolerance', 'explanation', 'evidence',
  ],
  candidates: ['left_id', 'right_id', 'score', 'component_id', 'suggested', 'field_scores', 'diagnostics', 'evidence'],
  decisions: ['action', 'left_id', 'right_id', 'reason'],
  unresolved: ['side', 'id', 'record', 'status', 'reason'],
};
const examples = ['orders', 'migration', 'catalog'];
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moonreconcile-workflows-'));

function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') { quoted = true; started = true; }
    else if (ch === ',') { row.push(cell); cell = ''; started = true; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; started = false; }
    else { cell += ch; started = true; }
  }
  if (started || cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  assert.equal(quoted, false, 'exported CSV must have balanced quoting');
  return rows;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixtureRows(bytes) {
  const rows = parseCsv(bytes.toString('utf8'));
  return rows.slice(1);
}

function expectedRecordIds(side, originalBytes) {
  return fixtureRows(originalBytes).map((_, index) => `${side === 'left' ? 'L' : 'R'}${index + 1}`);
}

function normalizeExpectedSemantics(sourceConfig, normalized) {
  assert.equal(normalized.schema_version, sourceConfig.schema_version);
  assert.equal(normalized.draft, false);
  assert.deepEqual(normalized.key, sourceConfig.key ?? []);
  assert.deepEqual(normalized.ignore_left, sourceConfig.ignore_left ?? []);
  assert.deepEqual(normalized.ignore_right, sourceConfig.ignore_right ?? []);
  assert.equal(normalized.fields.length, sourceConfig.fields.length);
  for (let i = 0; i < sourceConfig.fields.length; i += 1) {
    const declared = sourceConfig.fields[i];
    const actual = normalized.fields[i];
    for (const key of ['name', 'left', 'right', 'type']) assert.equal(actual[key], declared[key], `normalized field ${i}.${key}`);
    assert.equal(actual.compare, declared.compare ?? true);
    assert.deepEqual(actual.left_values, declared.left_values ?? {});
    assert.deepEqual(actual.right_values, declared.right_values ?? {});
    assert.deepEqual(actual.missing, declared.missing ?? []);
    assert.equal(actual.both_missing, declared.both_missing ?? 'equal');
    assert.equal(actual.trim_ascii, declared.trim_ascii ?? false);
    assert.equal(actual.lower_ascii, declared.lower_ascii ?? false);
    assert.equal(actual.abs_tol, declared.abs_tol ?? '0');
    assert.equal(actual.rel_tol, declared.rel_tol ?? '0');
    assert.equal(actual.days_tol, declared.days_tol ?? 0);
  }
  if (sourceConfig.candidates === undefined) assert.equal(normalized.candidates, null);
  else assert.deepEqual(normalized.candidates, sourceConfig.candidates);
}

function assertFixtureSummary(report, expected) {
  assert.deepEqual(report.computation.status, expected.computationStatus);
  assert.equal(report.exit_code, expected.exitCode);
  assert.deepEqual(report.summary.per_side, expected.perSide);
  assert.deepEqual(report.summary.fields, expected.fieldCounts);
  assert.equal(report.summary.candidate_count, expected.candidateCount);
  assert.equal(report.summary.unresolved_count, expected.unresolvedCount);
  assert.equal(report.summary.structural_issue_count, expected.structuralIssueCount);
  assert.equal(report.summary.key_issue_count, expected.keyIssueCount);
}

function assertRecordContract(report, expected) {
  for (const side of ['left', 'right']) {
    const ids = expected.ids[side];
    const actual = report.records.filter((record) => record.side === side);
    assert.deepEqual(actual.map((record) => record.id), ids, `${side} IDs must cover original input in order`);
    assert.equal(new Set(actual.map((record) => record.id)).size, ids.length, `${side} IDs must be unique`);
    const statusCounts = { paired: 0, unmatched: 0, pending_review: 0, unprocessed: 0 };
    for (const record of actual) {
      assert.ok(Object.hasOwn(statusCounts, record.status), `unexpected status ${record.status}`);
      statusCounts[record.status] += 1;
      assert.equal(record.status, expected.statuses[record.id], `${record.id} state`);
      assert.equal(record.reason, expected.reasons[record.id], `${record.id} reason`);
    }
    assert.deepEqual(statusCounts, Object.fromEntries(Object.keys(statusCounts).map((key) => [key, expected.perSide[side][key]])));
    const total = actual.length;
    assert.equal(statusCounts.paired + statusCounts.unmatched + statusCounts.pending_review + statusCounts.unprocessed, total);
    assert.equal(report.summary.per_side[side].total, total);
    for (const status of Object.keys(statusCounts)) assert.equal(report.summary.per_side[side][status], statusCounts[status]);
  }
  assert.equal(new Set(report.records.map((record) => record.id)).size, report.records.length);
  assert.deepEqual(report.records.map((record) => record.id), [...expected.ids.left, ...expected.ids.right]);
}

function assertPairContract(report, expected) {
  const pairs = report.pairs.map((pair) => ({
    left_id: pair.left_id, right_id: pair.right_id, source: pair.source,
    reason: pair.reason, override: pair.override,
  }));
  assert.deepEqual(pairs, expected.pairs);
  assert.equal(new Set(pairs.map((pair) => pair.left_id)).size, pairs.length, 'left pair endpoints are unique');
  assert.equal(new Set(pairs.map((pair) => pair.right_id)).size, pairs.length, 'right pair endpoints are unique');
  const pairedIds = new Set(pairs.flatMap((pair) => [pair.left_id, pair.right_id]));
  assert.deepEqual(report.records.filter((record) => record.status === 'paired').map((record) => record.id).sort(), [...pairedIds].sort());
}

function assertFieldContract(report, expected) {
  const actual = report.fields.map((field) => [
    field.left_id, field.right_id, field.field, field.left_raw, field.right_raw,
    field.status, field.difference, field.tolerance,
  ]);
  assert.deepEqual(actual, expected.fieldOutcomes);
  const counts = { equal: 0, equivalent_by_rule: 0, different: 0, invalid_value: 0 };
  for (const field of report.fields) counts[field.status] += 1;
  assert.deepEqual(counts, report.summary.fields);
}

function reportCsvValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function assertExportMatchesReport(exportName, rows, report) {
  const schema = csvSchemas[exportName];
  assert.deepEqual(rows[0], schema, `${exportName}.csv header`);
  const body = rows.slice(1);
  if (exportName === 'pairs') {
    assert.deepEqual(body, report.pairs.map((pair) => schema.map((key) => reportCsvValue(pair[key]))), 'pairs.csv values must match report pair identities and decisions');
  } else if (exportName === 'fields') {
    assert.deepEqual(body, report.fields.map((field) => schema.map((key) => {
      if (key === 'rules') return JSON.stringify(field.rules);
      if (key === 'evidence') return JSON.stringify(field);
      return reportCsvValue(field[key]);
    })), 'fields.csv values and evidence must match report');
  } else if (exportName === 'candidates') {
    assert.deepEqual(body, report.candidates.map((candidate) => schema.map((key) => {
      if (key === 'field_scores' || key === 'diagnostics' || key === 'evidence') return JSON.stringify(key === 'evidence' ? candidate : candidate[key]);
      return reportCsvValue(candidate[key]);
    })), 'candidates.csv values and evidence must match report');
  } else if (exportName === 'unresolved') {
    const records = report.records.filter((record) => record.status === 'pending_review' || record.status === 'unprocessed');
    assert.deepEqual(body, records.map((record) => [record.side, record.id, String(record.record), record.status, record.reason]));
  } else if (exportName === 'decisions') {
    for (const decision of report.decisions) {
      const wanted = [decision.action, decision.left_id ?? '', decision.right_id ?? '', decision.reason ?? ''];
      assert.ok(body.some((row) => JSON.stringify(row) === JSON.stringify(wanted)), `decisions.csv omitted ${decision.action} for ${decision.left_id ?? decision.right_id}`);
    }
    for (const candidate of report.candidates.filter((item) => item.suggested)) {
      const alreadyDecided = report.decisions.some((decision) => decision.left_id === candidate.left_id && decision.right_id === candidate.right_id);
      if (!alreadyDecided) assert.ok(body.some((row) => row[0] === '' && row[1] === candidate.left_id && row[2] === candidate.right_id), `decisions.csv omitted suggested pair row ${candidate.left_id}/${candidate.right_id}`);
    }
    for (const record of report.records.filter((item) => item.status === 'pending_review' || item.status === 'unprocessed')) {
      assert.ok(body.some((row) => row[0] === '' && (record.side === 'left' ? row[1] === record.id : row[2] === record.id)), `decisions.csv omitted blank review row for ${record.id}`);
    }
  }
}

function assertMarkdown(report, markdown) {
  assert.ok(markdown.startsWith('# Reconciliation summary\n'));
  assert.ok(markdown.includes(`- computation status: ${report.computation.status}\n`));
  assert.ok(markdown.includes(`- unresolved records: ${report.summary.unresolved_count}\n`));
  assert.ok(markdown.includes(`- candidates: ${report.summary.candidate_count}\n`));
  assert.ok(markdown.includes(`- exit code: ${report.exit_code}\n`));
  for (const section of ['## Computation coverage', '## Record accounting', '## Field comparison', '## Structure and key issues', '## Review']) assert.ok(markdown.includes(section), `summary.md missing ${section}`);
  for (const side of ['left', 'right']) {
    const s = report.summary.per_side[side];
    assert.ok(markdown.includes(`| ${side} | ${s.total} | ${s.paired} | ${s.unmatched} | ${s.pending_review} | ${s.unprocessed} |`));
  }
  for (const [status, count] of Object.entries(report.summary.fields)) assert.ok(markdown.includes(`| ${status} | ${count} |`));
  for (const issue of report.computation.issues) assert.ok(markdown.includes(issue.code));
  assert.ok(markdown.includes(`- structure issues: ${report.summary.structural_issue_count}`));
  assert.ok(markdown.includes(`- key issues: ${report.summary.key_issue_count}`));
  assert.ok(markdown.includes(`- applied decisions: ${report.decisions.length}`));
}

async function validateRun(directory, context) {
  for (const file of requiredFiles) assert.ok((await fs.stat(path.join(directory, file))).isFile(), `${file} missing`);
  const report = await readJson(path.join(directory, 'report.json'));
  assert.equal(report.schema_version, 1);
  assert.equal(report.engine_version, '0.1.0');
  assertFixtureSummary(report, context.expected);
  assertRecordContract(report, context.expected);
  assertPairContract(report, context.expected);
  assertFieldContract(report, context.expected);
  assert.deepEqual(report.structure, context.expected.structure);
  assert.deepEqual(report.key_issues.map((issue) => [issue.code, issue.side, issue.record, issue.field]), context.expected.keyIssues);
  assert.deepEqual(report.candidates.map((candidate) => ({ left_id: candidate.left_id, right_id: candidate.right_id, score: candidate.score, suggested: candidate.suggested, component_id: candidate.component_id })), context.expected.candidates);

  const manifest = await readJson(path.join(directory, 'manifest.json'));
  const leftSnapshot = await fs.readFile(path.join(directory, 'input/left.csv'));
  const rightSnapshot = await fs.readFile(path.join(directory, 'input/right.csv'));
  assert.deepEqual(leftSnapshot, context.leftBytes, 'left snapshot must equal original fixture bytes');
  assert.deepEqual(rightSnapshot, context.rightBytes, 'right snapshot must equal original fixture bytes');
  assert.equal(manifest.left_bytes, context.leftBytes.length);
  assert.equal(manifest.right_bytes, context.rightBytes.length);
  assert.equal(manifest.left_sha256, sha256(context.leftBytes));
  assert.equal(manifest.right_sha256, sha256(context.rightBytes));
  assert.equal(manifest.engine_version, report.engine_version);

  const configBytes = await fs.readFile(path.join(directory, 'config.json'));
  assert.equal(manifest.config_bytes, configBytes.length, 'config byte size must match the run manifest');
  assert.equal(manifest.config_sha256, sha256(configBytes), 'config digest must match the run manifest');
  const normalizedConfig = JSON.parse(configBytes.toString('utf8'));
  normalizeExpectedSemantics(context.sourceConfig, normalizedConfig);
  const csvReports = {};
  for (const name of ['pairs', 'fields', 'candidates', 'decisions', 'unresolved']) {
    const rows = parseCsv(await fs.readFile(path.join(directory, `${name}.csv`), 'utf8'));
    assertExportMatchesReport(name, rows, report);
    csvReports[name] = rows;
  }
  const summary = await fs.readFile(path.join(directory, 'summary.md'), 'utf8');
  assertMarkdown(report, summary);
  return { report, csvReports, summary };
}

function exactReference(name, leftBytes, rightBytes, config) {
  // Independent fixture-only exact join with explicit transforms and comparison rules.
  const decode = (bytes) => {
    const [header, ...lines] = bytes.toString('utf8').trimEnd().split('\n');
    const keys = header.split(',');
    return lines.map((line) => Object.fromEntries(keys.map((key, index) => [key, line.split(',')[index]])));
  };
  const left = decode(leftBytes);
  const right = decode(rightBytes);
  const keyName = config.key?.[0];
  if (!keyName) return { pairs: [], pendingLeft: left.length, pendingRight: right.length, fields: [] };
  const keyField = config.fields.find((field) => field.name === keyName);
  const leftKey = (row) => row[keyField.left];
  const rightKey = (row) => row[keyField.right];
  const leftCounts = new Map();
  const rightCounts = new Map();
  for (const row of left) leftCounts.set(leftKey(row), (leftCounts.get(leftKey(row)) ?? 0) + 1);
  for (const row of right) rightCounts.set(rightKey(row), (rightCounts.get(rightKey(row)) ?? 0) + 1);
  const pairs = [];
  for (let i = 0; i < left.length; i += 1) {
    const key = leftKey(left[i]);
    if (key && leftCounts.get(key) === 1 && rightCounts.get(key) === 1) {
      pairs.push([`L${i + 1}`, `R${right.findIndex((row) => rightKey(row) === key) + 1}`]);
    }
  }
  const fields = [];
  for (const [leftId, rightId] of pairs) {
    const lrow = left[Number(leftId.slice(1)) - 1];
    const rrow = right[Number(rightId.slice(1)) - 1];
    for (const field of config.fields.filter((entry) => entry.compare !== false)) {
      const a = lrow[field.left];
      const rawB = rrow[field.right];
      const b = field.right_values?.[rawB] ?? rawB;
      let status;
      let difference = null;
      let tolerance = null;
      if (field.type === 'decimal') {
        const scaled = (text) => { const [whole, fraction = ''] = text.split('.'); return [BigInt(whole + fraction), fraction.length]; };
        const [ac, as] = scaled(a); const [bc, bs] = scaled(b); const [tc, ts] = scaled(field.abs_tol ?? '0');
        const scale = Math.max(as, bs, ts);
        const delta = ac * 10n ** BigInt(scale - as) - bc * 10n ** BigInt(scale - bs);
        const limit = tc * 10n ** BigInt(scale - ts);
        difference = decimalString(delta, scale);
        tolerance = decimalString(limit, scale);
        status = (delta < 0n ? -delta : delta) <= limit ? (a === b ? 'equal' : 'equivalent_by_rule') : 'different';
      } else if (field.type === 'date') {
        const days = (text) => {
          const [year, month, day] = text.split('-').map(Number);
          const date = new Date(Date.UTC(year, month - 1, day));
          if (date.toISOString().slice(0, 10) !== text) throw new Error(`invalid fixture date ${text}`);
          return date.getTime() / 86400000;
        };
        difference = String(days(a) - days(b));
        tolerance = String(field.days_tol ?? 0);
        status = difference === '0' ? 'equal' : Math.abs(Number(difference)) <= Number(tolerance) ? 'equivalent_by_rule' : 'different';
      } else {
        status = a === b ? (a === rawB ? 'equal' : 'equivalent_by_rule') : 'different';
      }
      fields.push({ left_id: leftId, right_id: rightId, field: field.name, left_raw: a, right_raw: rawB, status, difference, tolerance });
    }
  }
  return { pairs, pendingLeft: left.length - pairs.length, pendingRight: right.length - pairs.length, fields };
}

function decimalString(coefficient, scale) {
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
  }
  return `${negative ? '-' : ''}${digits}`;
}

function expectedFor(name, stage, ids) {
  const defaults = {
    computationStatus: 'complete', exitCode: 1, candidateCount: 0, unresolvedCount: 0,
    structuralIssueCount: 0, keyIssueCount: 0, pairs: [], fieldOutcomes: [], candidates: [], decisions: [],
    structure: { unmapped_left: [], unmapped_right: [], ignored_left: [], ignored_right: [] }, keyIssues: [],
  };
  if (name === 'orders') {
    const resolved = stage !== 'compare';
    const statuses = { L1: 'paired', L2: 'paired', L3: resolved ? 'unmatched' : 'pending_review', R1: 'paired', R2: 'paired' };
    const reasons = { L1: 'exact_key', L2: 'exact_key', L3: resolved ? 'human_unmatched' : 'review_required', R1: 'exact_key', R2: 'exact_key' };
    return { ...defaults, ids, statuses, reasons,
      perSide: { left: { total: 3, paired: 2, unmatched: resolved ? 1 : 0, pending_review: resolved ? 0 : 1, unprocessed: 0 }, right: { total: 2, paired: 2, unmatched: 0, pending_review: 0, unprocessed: 0 } },
      fieldCounts: { equal: 1, equivalent_by_rule: 2, different: 3, invalid_value: 0 }, keyIssueCount: 1, unresolvedCount: resolved ? 0 : 1, keyIssues: [['key_not_found','left',3,null]],
      decisions: resolved ? [['left_unmatched','L3',null,'source-system audit confirms missing sync',false]] : [],
      pairs: [
        { left_id: 'L1', right_id: 'R1', source: 'exact_key', reason: 'unique_canonical_key', override: false },
        { left_id: 'L2', right_id: 'R2', source: 'exact_key', reason: 'unique_canonical_key', override: false },
      ],
      fieldOutcomes: [
        ['L1','R1','status','paid','已支付','equivalent_by_rule',null,null],
        ['L1','R1','amount','100.00','100.01','equivalent_by_rule','-0.01','0.02'],
        ['L1','R1','day','2026-09-01','2026-09-01','equal','0','0'],
        ['L2','R2','status','pending','paid','different',null,null],
        ['L2','R2','amount','10','11','different','-1','0.02'],
        ['L2','R2','day','2026-09-02','2026-09-03','different','-1','0'],
      ],
    };
  }
  if (name === 'migration') {
    const resolved = stage !== 'compare';
    const statuses = { L1: 'paired', L2: resolved ? 'paired' : 'pending_review', L3: resolved ? 'paired' : 'pending_review', L4: resolved ? 'paired' : 'pending_review', R1: 'paired', R2: resolved ? 'paired' : 'pending_review', R3: resolved ? 'paired' : 'pending_review', R4: resolved ? 'paired' : 'pending_review' };
    const reasons = Object.fromEntries(Object.entries(statuses).map(([id, state]) => [id, state === 'paired' && id !== 'L1' && id !== 'R1' ? 'human_review' : state === 'paired' ? 'exact_key' : 'review_required']));
    const pairs = [{ left_id: 'L1', right_id: 'R1', source: 'exact_key', reason: 'unique_canonical_key', override: false }];
    const fieldOutcomes = [['L1','R1','status','active','old','equivalent_by_rule',null,null],['L1','R1','amount','1.00','1','equivalent_by_rule','0','0']];
    if (resolved) for (const [n, value] of [[2,'2'],[3,'3'],[4,'4']]) {
      pairs.push({ left_id: `L${n}`, right_id: `R${n}`, source: 'human_review', reason: 'synthetic migration sample verified', override: true });
      fieldOutcomes.push([`L${n}`,`R${n}`,'status','active','active','equal',null,null]);
      fieldOutcomes.push([`L${n}`,`R${n}`,'amount',value,value,'equal','0','0']);
    }
    return { ...defaults, ids, statuses, reasons,
      perSide: { left: { total: 4, paired: resolved ? 4 : 1, unmatched: 0, pending_review: resolved ? 0 : 3, unprocessed: 0 }, right: { total: 4, paired: resolved ? 4 : 1, unmatched: 0, pending_review: resolved ? 0 : 3, unprocessed: 0 } },
      fieldCounts: resolved ? { equal: 6, equivalent_by_rule: 2, different: 0, invalid_value: 0 } : { equal: 0, equivalent_by_rule: 2, different: 0, invalid_value: 0 },
      candidateCount: 0, unresolvedCount: resolved ? 0 : 6, structuralIssueCount: 1, keyIssueCount: 6,
      structure: { unmapped_left: ['legacy_note'], unmapped_right: [], ignored_left: [], ignored_right: ['export_stamp'] },
      keyIssues: [['invalid_or_missing_key','left',4,null],['duplicate_key','right',2,null],['duplicate_key','right',3,null],['invalid_or_missing_key','right',4,null],['duplicate_key','left',2,null],['duplicate_key','left',3,null]],
      decisions: resolved ? [[ 'accept','L2','R2','synthetic migration sample verified',true ],[ 'accept','L3','R3','synthetic migration sample verified',true ],[ 'accept','L4','R4','synthetic migration sample verified',true ]] : [], pairs, fieldOutcomes,
    };
  }
  const resolved = stage !== 'compare';
  return { ...defaults, ids,
    statuses: { L1: resolved ? 'paired' : 'pending_review', R1: resolved ? 'paired' : 'pending_review', R2: resolved ? 'unmatched' : 'pending_review' },
    reasons: { L1: resolved ? 'human_review' : 'review_required', R1: resolved ? 'human_review' : 'review_required', R2: resolved ? 'human_unmatched' : 'review_required' },
    perSide: { left: { total: 1, paired: resolved ? 1 : 0, unmatched: 0, pending_review: resolved ? 0 : 1, unprocessed: 0 }, right: { total: 2, paired: resolved ? 1 : 0, unmatched: resolved ? 1 : 0, pending_review: resolved ? 0 : 2, unprocessed: 0 } },
    fieldCounts: resolved ? { equal: 0, equivalent_by_rule: 0, different: 1, invalid_value: 0 } : { equal: 0, equivalent_by_rule: 0, different: 0, invalid_value: 0 },
    candidateCount: 2, unresolvedCount: resolved ? 0 : 3, keyIssueCount: 1,
    keyIssues: [['no_key_configured',null,null,null]],
    decisions: resolved ? [['right_unmatched',null,'R2','synthetic truth marks the decoy unmatched',false],['accept','L1','R1','synthetic truth confirms the near-name catalog match',false],['reject','L1','R2','synthetic truth says this same-name decoy is a different product',false]] : [],
    candidates: [
      { left_id: 'L1', right_id: 'R1', score: 8000, suggested: false, component_id: 'Q1' },
      { left_id: 'L1', right_id: 'R2', score: 10000, suggested: !resolved, component_id: 'Q1' },
    ],
    pairs: resolved ? [{ left_id: 'L1', right_id: 'R1', source: 'human_review', reason: 'synthetic truth confirms the near-name catalog match', override: false }] : [],
    fieldOutcomes: resolved ? [['L1','R1','name','abcde','abcdx','different',null,null]] : [],
  };
}

function assertExactBaseline(name, report, reference, expected) {
  const baselinePairs = reference.pairs;
  const actualExactPairs = report.pairs.filter((pair) => pair.source === 'exact_key').map((pair) => [pair.left_id, pair.right_id]);
  assert.deepEqual(actualExactPairs, baselinePairs, `${name} exact pairs must match independent exact baseline identities`);
  assert.equal(report.summary.per_side.left.pending_review, reference.pendingLeft, `${name} independent baseline left pending count`);
  assert.equal(report.summary.per_side.right.pending_review, reference.pendingRight, `${name} independent baseline right pending count`);
  if (name !== 'catalog') assert.deepEqual(report.fields.map((field) => [field.left_id, field.right_id, field.field, field.left_raw, field.right_raw, field.status, field.difference, field.tolerance]), reference.fields.map((field) => [field.left_id, field.right_id, field.field, field.left_raw, field.right_raw, field.status, field.difference, field.tolerance]));
  else assert.deepEqual(baselinePairs, []);
  assert.deepEqual(actualExactPairs, expected.pairs.filter((pair) => pair.source === 'exact_key').map((pair) => [pair.left_id, pair.right_id]));
}

async function runMutationChecks(sourceDirectory, context) {
  const cases = [
    ['missing-record', /original input|IDs must cover/ , async (directory) => {
      const reportPath = path.join(directory, 'report.json');
      const report = await readJson(reportPath);
      report.records = report.records.filter((record) => record.id !== 'L3');
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }],
    ['pairs-csv-id', /pairs\.csv/, async (directory) => {
      const file = path.join(directory, 'pairs.csv');
      const rows = parseCsv(await fs.readFile(file, 'utf8'));
      rows[1][0] = 'L999';
      await fs.writeFile(file, rows.map((row) => row.join(',')).join('\n') + '\n');
    }],
    ['same-length-snapshot', /snapshot/, async (directory) => {
      const file = path.join(directory, 'input/left.csv');
      const bytes = await fs.readFile(file);
      const text = bytes.toString('utf8').replace('100.00', '999.99');
      assert.equal(Buffer.byteLength(text), bytes.length);
      await fs.writeFile(file, text);
    }],
    ['config-json', /normalized|config/, async (directory) => { await fs.writeFile(path.join(directory, 'config.json'), '{}\n'); }],
    ['markdown-summary', /summary\.md|computation status|Reconciliation summary/, async (directory) => { await fs.writeFile(path.join(directory, 'summary.md'), `## Record accounting\n\n${context.expected.unresolvedCount}\n`); }],
  ];
  for (const [name, pattern, mutate] of cases) {
    const directory = path.join(temporaryRoot, `mutation-${name}`);
    await fs.cp(sourceDirectory, directory, { recursive: true });
    await mutate(directory);
    await assert.rejects(validateRun(directory, context), pattern, `${name} mutation must be rejected`);
    console.log(`mutation rejected: ${name}`);
  }
}

for (const name of examples) {
  const base = path.join(root, 'examples', name);
  const leftBytes = readFileSync(path.join(base, 'left.csv'));
  const rightBytes = readFileSync(path.join(base, 'right.csv'));
  const sourceConfig = JSON.parse(readFileSync(path.join(base, 'rules.json'), 'utf8'));
  const sourceDecisions = parseCsv(readFileSync(path.join(base, 'reviewed.csv'), 'utf8'));
  const ids = { left: expectedRecordIds('left', leftBytes), right: expectedRecordIds('right', rightBytes) };
  const compareExpected = expectedFor(name, 'compare', ids);
  const resolvedExpected = expectedFor(name, 'resolved', ids);
  const context = (expected) => ({ expected, leftBytes, rightBytes, sourceConfig });
  const compareDir = path.join(temporaryRoot, `${name}-compare`);
  const resolvedDir = path.join(temporaryRoot, `${name}-resolved`);
  const replayDir = path.join(temporaryRoot, `${name}-replay`);

  let result = invoke(['compare', `${base}/left.csv`, `${base}/right.csv`, '--config', `${base}/rules.json`, '--out', compareDir]);
  assert.equal(result.code, compareExpected.exitCode, `${name} compare failed: ${result.stderr}`);
  const before = await validateRun(compareDir, context(compareExpected));
  const reference = exactReference(name, leftBytes, rightBytes, sourceConfig);
  assertExactBaseline(name, before.report, reference, compareExpected);

  if (name === 'orders') {
    assert.equal(before.report.fields[1].explanation, 'decimal_difference_within_tolerance');
    assert.equal(before.report.fields[4].explanation, 'decimal_difference_exceeds_tolerance');
    assert.equal(before.report.records.find((record) => record.id === 'L3').status, 'pending_review');
    assert.deepEqual(before.report.key_issues.map((issue) => [issue.code, issue.side, issue.record]), [['key_not_found','left',3]]);
  } else if (name === 'migration') {
    assert.deepEqual(before.report.structure, { unmapped_left: ['legacy_note'], unmapped_right: [], ignored_left: [], ignored_right: ['export_stamp'] });
    assert.deepEqual(before.report.key_issues.map((issue) => [issue.code, issue.side, issue.record]).sort(), [
      ['duplicate_key','left',2], ['duplicate_key','left',3], ['duplicate_key','right',2], ['duplicate_key','right',3],
      ['invalid_or_missing_key','left',4], ['invalid_or_missing_key','right',4],
    ]);
  } else {
    assert.deepEqual(before.report.candidates.map((candidate) => [candidate.left_id, candidate.right_id, candidate.score, candidate.suggested]), [['L1','R1',8000,false],['L1','R2',10000,true]]);
    const truth = await readJson(path.join(base, 'truth.json'));
    const truePairs = new Set(truth.true_pairs.map((pair) => JSON.stringify(pair)));
    const qualifiedTrue = before.report.candidates.filter((candidate) => truePairs.has(JSON.stringify([candidate.left_id, candidate.right_id]))).length;
    const suggested = before.report.candidates.filter((candidate) => candidate.suggested);
    const reviewRows = sourceDecisions.slice(1);
    const accepted = reviewRows.filter((row) => row[0] === 'accept');
    const rejected = reviewRows.filter((row) => row[0] === 'reject');
    assert.deepEqual({ true: qualifiedTrue, false: before.report.candidates.length - qualifiedTrue }, truth.qualified_candidates);
    assert.deepEqual({ true: suggested.filter((candidate) => truePairs.has(JSON.stringify([candidate.left_id, candidate.right_id]))).length, false: suggested.filter((candidate) => !truePairs.has(JSON.stringify([candidate.left_id, candidate.right_id]))).length, unmatched_left: suggested.filter((candidate) => truth.true_unmatched.left.includes(candidate.left_id)).length }, truth.suggestions);
    assert.deepEqual({ accepted_true: accepted.filter((row) => truePairs.has(JSON.stringify([row[1], row[2]]))).length, accepted_false: accepted.filter((row) => !truePairs.has(JSON.stringify([row[1], row[2]]))).length, rejected_false: rejected.filter((row) => !truePairs.has(JSON.stringify([row[1], row[2]]))).length, confirmed_unmatched_right: reviewRows.filter((row) => row[0] === 'right_unmatched' && truth.true_unmatched.right.includes(row[2])).length }, truth.review);
  }

  result = invoke(['resolve', compareDir, '--decisions', `${base}/reviewed.csv`, '--out', resolvedDir]);
  assert.equal(result.code, resolvedExpected.exitCode, `${name} resolve failed: ${result.stderr}`);
  const after = await validateRun(resolvedDir, context(resolvedExpected));
  const expectedImported = sourceDecisions.slice(1).filter((row) => row.some((cell) => cell !== '')).map((row) => [row[0], row[1] || null, row[2] || null, row[3]]);
  for (const [action, leftId, rightId, reason] of expectedImported) {
    assert.ok(after.report.decisions.some((decision) => decision.action === action && decision.left_id === leftId && decision.right_id === rightId && decision.reason === reason), `${name} resolved decision ${action} ${leftId ?? rightId}`);
  }
  const decisions = after.report.decisions.map((decision) => [decision.action, decision.left_id, decision.right_id, decision.reason, decision.override]);
  const sortDecisions = (rows) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(sortDecisions(decisions), sortDecisions([...resolvedExpected.decisions]), `${name} decision identities/reasons/override flags`);
  if (name === 'migration') {
    assert.ok(after.report.decisions.filter((decision) => decision.action === 'accept').every((decision) => decision.override));
    assert.deepEqual(after.report.structure, before.report.structure);
    assert.deepEqual(after.report.key_issues.map((issue) => [issue.code, issue.side, issue.record]).sort(), before.report.key_issues.map((issue) => [issue.code, issue.side, issue.record]).sort());
  }
  if (name === 'catalog') {
    assert.equal(after.report.pairs[0].override, false, 'qualified competing candidate acceptance is not an override');
    assert.equal(after.report.records.find((record) => record.id === 'R2').status, 'unmatched');
  }
  if (name === 'orders') await runMutationChecks(resolvedDir, context(resolvedExpected));

  result = invoke(['resolve', compareDir, '--decisions', path.join(resolvedDir, 'decisions.csv'), '--out', replayDir]);
  assert.equal(result.code, resolvedExpected.exitCode, `${name} replay failed: ${result.stderr}`);
  const replayed = await validateRun(replayDir, context(resolvedExpected));
  assert.deepEqual(replayed.report, after.report, `${name} resolve replay semantic report changed`);
  console.log(`${name}: compare/resolve/replay passed with fixture identities, complete exports and conservation`);
}
console.log(`Synthetic workflows and five mutation checks passed. Temporary outputs: ${temporaryRoot}`);
