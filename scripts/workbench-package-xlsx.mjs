import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, verifySourceAtHead, files } from './workbench-package-provenance.mjs';

// Development-side truth only. These files never enter the runtime package.
const FIXTURES = {
  'genuine-save-manifest.json': '1709d649ae32a37cd8c8fcdbc35275a319d2c6eb7c8d81e35df9d564e6c4a7fd',
  'genuine-save-expected.json': '48d100c12d9cdda5510764ed2477991b9850582eabdafe43b5b12eee0073f4e3',
  'lo-conversion-1904.xlsx': '98dded72b9412239d51993b314ce49281a4735d61a3633399a069d12736d1b62',
  'lo-conversion-1904-reference.csv': '11209dcaf415406fef9bf8f9f69a7269eb76e8136395ee3dd635dd82412ed783',
  'lo-formula-reject.xlsx': '7c2951091b4ff66bdd0edb7ab1cd1ceb0e92f53ee372227ad8c90a3eb787e806',
};

export async function genuineXlsxInputs(root) {
  const inputs = Object.fromEntries(Object.entries(FIXTURES).map(([name, sha]) => [`tests/fixtures/xlsx/${name}`, sha]));
  await verifySourceAtHead(root, inputs);
  const data = {};
  for (const [name, sha] of Object.entries(FIXTURES)) {
    data[name] = await fs.readFile(path.join(root, 'tests/fixtures/xlsx', name));
    assert.equal(digest(data[name]), sha, `pinned genuine fixture changed: ${name}`);
  }
  const manifest = JSON.parse(data['genuine-save-manifest.json']);
  assert.equal(manifest.schema_version, 1);
  for (const name of ['lo-conversion-1904.xlsx', 'lo-formula-reject.xlsx']) {
    const sample = manifest.samples.filter(item => item.path === name);
    assert.equal(sample.length, 1);
    assert.equal(sample[0].sha256, FIXTURES[name]);
    assert.equal(sample[0].bytes, data[name].length);
    assert.equal(sample[0].application, 'LibreOffice');
  }
  const expected = JSON.parse(data['genuine-save-expected.json']).samples.find(item => item.id === 'lo-conversion-1904.xlsx');
  assert.equal(expected.csv_sha256, FIXTURES['lo-conversion-1904-reference.csv']);
  return { data, expected, inputs };
}

export function assertXlsxCapabilities(caps) {
  assert.deepEqual(caps.formats, ['csv', 'xlsx']);
  assert.equal(caps.app_version, '0.2.0');
  assert.equal(caps.api_version, 1);
  assert.equal(caps.engine_version, '0.1.0');
  assert.equal(caps.xlsx_api_version, 1);
  assert.equal(caps.import_profile_schema_version, 1);
  assert.deepEqual(caps.xlsx_limits, {
    compressed_bytes: 67108864, entries: 2048, actual_unzip_bytes: 268435456,
    xml_bytes: 67108864, xml_depth: 64, cell_bytes: 65536, csv_bytes: 67108864,
    data_rows: 100000, columns: 256,
  });
}

// Called inside the original strict gate, against its actual default-started,
// relocated, network-isolated child. Never imports checkout runtime modules.
export async function checkPackagedXlsx({ root, temp, relocated, app, api, job, runOfflineNode, nodeOnly, homeEnv, extractZip, result }) {
  const { data, expected, inputs } = await genuineXlsxInputs(root);
  const call = (route, options) => api(app.origin, app.token, route, options);
  const task = async (route, body, options) => job(app.origin, app.token, await call(route, { method: 'POST', body }), options);
  const upload = async (kind, bytes, filename) => (await call('/api/assets', { method: 'POST', kind, bytes, filename })).asset;
  const material = (id, kind) => call(`/api/imports/${id}/materials/export?kind=${kind}`, { raw: true });
  const source = data['lo-conversion-1904.xlsx'];
  const canonical = data['lo-conversion-1904-reference.csv'];
  const asset = await upload('xlsx', source, 'genuine-1904.xlsx');
  assert.equal(asset.sha256, digest(source));
  const { workbook } = await task('/api/xlsx/catalog', { asset_id: asset.asset_id });
  assert.equal(workbook.source_sha256, asset.sha256);
  assert.equal(workbook.date_system, '1904');
  const sheets = workbook.sheets.filter(sheet => sheet.name === 'Synthetic' && sheet.selectable && sheet.state === 'visible' && sheet.kind === 'worksheet');
  assert.equal(sheets.length, 1, 'explicit genuine worksheet must be selectable');
  const spec = { schema_version: 1, source_sha256: asset.sha256, sheet_id: sheets[0].sheet_id,
    ...expected.range, columns: expected.modes.map((mode, index) => ({ column: index + 1, mode })), formula_policy: 'reject' };
  assert.equal(spec.columns.length, 6);
  assert.equal(new Set(spec.columns.map(item => item.mode)).size, 4);
  const { import: left, preview } = await task('/api/imports', { asset_id: asset.asset_id, side: 'left', import_spec: spec });
  assert.deepEqual(preview.headers, expected.headers);
  assert.deepEqual(preview.rows.map(row => row.cells.map(cell => { assert.equal(cell.truncated, false); return cell.value; })), expected.rows);
  assert.equal(preview.row_count, 4);
  assert.equal(left.sha256, digest(canonical));
  assert.equal(left.format, 'xlsx');
  const rightAsset = await upload('csv', canonical, 'genuine-reference.csv');
  const { import: right } = await task('/api/imports', { asset_id: rightAsset.asset_id, side: 'right' });
  const { source_cell: cell } = await task(`/api/imports/${left.import_id}/source-cell`, { record: 1, column: 'date_serial' });
  assert.equal(cell.coordinate, 'D2');
  assert.equal(cell.stored_value, '0');
  assert.equal(cell.imported_value, '1904-01-01');
  assert.equal(cell.mode, 'excel_date');
  const profileBytes = await material(left.import_id, 'profile');
  const adapterBytes = await material(left.import_id, 'manifest');
  const profile = JSON.parse(profileBytes), adapter = JSON.parse(adapterBytes);
  assert.equal(profile.schema_version, 1);
  assert.equal(profile.adapter_id, 'restricted-ooxml');
  assert.equal(profile.adapter_version, '1.0.0');
  assert.deepEqual(profile.import_spec, spec);
  assert.equal(adapter.schema_version, 1);
  assert.equal(adapter.source.sha256, digest(source));
  assert.equal(adapter.canonical_csv.sha256, digest(canonical));
  assert.equal(adapter.profile.sha256, digest(profileBytes));
  assert.equal(left.adapter.import_manifest_sha256, digest(adapterBytes));
  const config = { schema_version: 1, fields: expected.headers.map(name => ({ name, left: name, right: name, type: 'text', compare: name !== 'text_id' })), key: ['text_id'] };
  const checked = await task('/api/config/check', { left_import_id: left.import_id, right_import_id: right.import_id, config });
  const compared = await task('/api/runs', { left_import_id: left.import_id, right_import_id: right.import_id, config_asset_id: checked.config_asset_id });
  const decisionBytes = Buffer.from('action,left_id,right_id,reason\n');
  const decisions = await upload('decisions', decisionBytes, 'empty-decisions.csv');
  const reviewed = await task(`/api/runs/${compared.revision.revision_id}/reviews`, { base_revision: compared.revision.revision_id, decisions_asset_id: decisions.asset_id });
  const revision = reviewed.revision;
  const report = await call(`/api/runs/${revision.revision_id}/export?kind=report`);
  const configBytes = await call(`/api/configs/${checked.config_asset_id}/export`);
  const oracle = path.join(temp, 'xlsx-cli');
  await fs.mkdir(oracle);
  for (const [name, bytes] of Object.entries({ 'left.csv': canonical, 'right.csv': canonical, 'config.json': configBytes, 'decisions.csv': decisionBytes })) await fs.writeFile(path.join(oracle, name), bytes);
  const compare = runOfflineNode(nodeOnly, ['cli/main.mjs', 'compare', path.join(oracle, 'left.csv'), path.join(oracle, 'right.csv'), '--config', path.join(oracle, 'config.json'), '--out', path.join(oracle, 'compared')], { cwd: relocated, env: homeEnv, encoding: 'utf8', timeout: 30000 });
  assert.ok([0, 1, 3].includes(compare.status), `genuine packaged CLI compare failed: ${compare.stderr}`);
  const resolve = runOfflineNode(nodeOnly, ['cli/main.mjs', 'resolve', path.join(oracle, 'compared'), '--decisions', path.join(oracle, 'decisions.csv'), '--out', path.join(oracle, 'resolved')], { cwd: relocated, env: homeEnv, encoding: 'utf8', timeout: 30000 });
  assert.ok([0, 1, 3].includes(resolve.status), `genuine packaged CLI resolve failed: ${resolve.stderr}`);
  assert.deepEqual(await fs.readFile(path.join(oracle, 'resolved/report.json')), report);
  const bundle = async id => {
    const packed = await task(`/api/runs/${id}/bundle`, {});
    return call(`/api/bundles/${packed.bundle_asset_id}/export`);
  };
  const bundleBytes = await bundle(revision.revision_id);
  const bundleFile = path.join(temp, 'mixed-reviewed.zip');
  await fs.writeFile(bundleFile, bundleBytes);
  const unpacked = path.join(temp, 'mixed-unpacked');
  await fs.mkdir(unpacked); await extractZip(bundleFile, unpacked);
  const hashes = await files(unpacked);
  assert.equal(Object.keys(hashes).length, 16);
  const sidecar = JSON.parse(await fs.readFile(path.join(unpacked, 'workbench.json')));
  assert.equal(sidecar.schema_version, 2);
  const coreManifest = JSON.parse(await fs.readFile(path.join(unpacked, 'run/manifest.json')));
  assert.equal(coreManifest.schema_version, 1);
  for (const record of sidecar.files) {
    const bytes = await fs.readFile(path.join(unpacked, record.path));
    assert.equal(bytes.length, record.bytes); assert.equal(digest(bytes), record.sha256);
  }
  for (const [name, bytes] of Object.entries({ 'import/left.xlsx': source, 'import/left.profile.json': profileBytes, 'import/left.adapter.json': adapterBytes, 'run/input/left.csv': canonical, 'run/input/right.csv': canonical })) assert.deepEqual(await fs.readFile(path.join(unpacked, name)), bytes);
  await call('/api/sessions/reset', { method: 'POST', body: { confirm: true } });
  const runAsset = await upload('run', bundleBytes, 'mixed-reviewed.zip');
  const restored = await task('/api/restores', { asset_id: runAsset.asset_id });
  assert.notEqual(restored.revision.revision_id, revision.revision_id);
  assert.notEqual(restored.revision.left_import_id, left.import_id);
  assert.deepEqual(await call(`/api/runs/${restored.revision.revision_id}/export?kind=report`), report);
  const restoredLeft = await call(`/api/imports/${restored.revision.left_import_id}`);
  const restoredRight = await call(`/api/imports/${restored.revision.right_import_id}`);
  assert.equal(restoredLeft.asset.sha256, digest(source));
  assert.deepEqual(restoredLeft.import.adapter, left.adapter);
  assert.equal(restoredRight.import.sha256, right.sha256);
  assert.deepEqual(await material(restoredLeft.import.import_id, 'profile'), profileBytes);
  assert.deepEqual(await material(restoredLeft.import.import_id, 'manifest'), adapterBytes);
  const restoredCell = await task(`/api/runs/${restored.revision.revision_id}/source-cell`, { side: 'left', record: 1, column: 'date_serial' });
  assert.deepEqual(restoredCell.source_cell, cell);
  const regeneratedFile = path.join(temp, 'mixed-regenerated.zip');
  await fs.writeFile(regeneratedFile, await bundle(restored.revision.revision_id));
  const regenerated = path.join(temp, 'mixed-regenerated');
  await fs.mkdir(regenerated); await extractZip(regeneratedFile, regenerated);
  const regeneratedHashes = await files(regenerated);
  for (const name of Object.keys(hashes).filter(name => name.startsWith('import/') || name.startsWith('run/') && name !== 'run/manifest.json')) assert.equal(regeneratedHashes[name], hashes[name], `regenerated material differs: ${name}`);
  const regeneratedManifest = JSON.parse(await fs.readFile(path.join(regenerated, 'run/manifest.json')));
  // Core v1 deliberately records each replay's creation time and local argv.
  // Resolve hashes its raw decision input. Restore uses the archived canonical
  // decisions.csv instead; bind both input hashes explicitly below. All other
  // immutable run identity fields and fingerprints must agree exactly.
  const immutableManifest = ({ created, provenance, decisions_sha256, ...identity }) => identity;
  assert.equal(coreManifest.decisions_sha256, digest(decisionBytes));
  assert.equal(regeneratedManifest.decisions_sha256, hashes['run/decisions.csv']);
  assert.deepEqual(immutableManifest(regeneratedManifest), immutableManifest(coreManifest));
  const oldSummary = await call(`/api/runs/${restored.revision.revision_id}/summary`);
  const bad = await upload('xlsx', data['lo-formula-reject.xlsx'], 'genuine-formula.xlsx');
  const rejected = await task('/api/xlsx/catalog', { asset_id: bad.asset_id }, { failureCode: 'xlsx_formula_rejected' });
  assert.equal(rejected.phase, 'xlsx');
  assert.equal(rejected.message, 'Invalid or damaged workbook package.');
  assert.equal(rejected.record, null);
  assert.equal(rejected.field, null);
  assert.deepEqual(await call(`/api/imports/${restored.revision.left_import_id}`), restoredLeft);
  assert.deepEqual(await call(`/api/imports/${restored.revision.right_import_id}`), restoredRight);
  assert.deepEqual(await call(`/api/runs/${restored.revision.revision_id}/summary`), oldSummary);
  assert.deepEqual(await call(`/api/runs/${restored.revision.revision_id}/export?kind=report`), report);
  // This endpoint accepts only the actual current head, proving rejection did
  // not replace it; the subsequent review is deliberately after retention checks.
  const followupDecisions = await upload('decisions', decisionBytes, 'followup-decisions.csv');
  const followup = await task(`/api/runs/${restored.revision.revision_id}/reviews`, { base_revision: restored.revision.revision_id, decisions_asset_id: followupDecisions.asset_id });
  assert.equal(followup.revision.parent_revision_id, restored.revision.revision_id);
  assert.deepEqual(await call(`/api/runs/${followup.revision.revision_id}/export?kind=report`), report);
  await verifySourceAtHead(root, inputs);
  result.gates.push({ name: 'genuine-mixed-xlsx-regeneration-cli-formula-retention', status: 0, materials: 16, sidecar_schema: 2, core_manifest_schema: 1,
    fixture_hashes: inputs, source_sha256: digest(source), canonical_sha256: digest(canonical), profile_sha256: digest(profileBytes), adapter_sha256: digest(adapterBytes),
    report_sha256: digest(report), bundle_sha256: digest(bundleBytes), cli_compare_status: compare.status, cli_resolve_status: resolve.status,
    source_cell: cell, rejection: rejected, prior_imports_and_head_retained: true, full_restore_regeneration_and_report_replay: true });
}
