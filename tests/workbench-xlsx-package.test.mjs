import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { inspectXlsxPackage, disposeXlsxPackage, XLSX_LIMITS, assertImportSpec, projectWorkbook } from '../workbench/xlsx/package.mjs';

const fixture = name => path.join(import.meta.dirname, 'fixtures', 'xlsx', name);

async function readArchive(file) {
  const zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, strictFileNames: true });
  const result = new Map();
  try {
    const next = () => new Promise((resolve, reject) => {
      const clean = () => { zip.removeListener('entry', onEntry); zip.removeListener('end', onEnd); zip.removeListener('error', onError); };
      const onEntry = entry => { clean(); resolve(entry); };
      const onEnd = () => { clean(); resolve(null); };
      const onError = error => { clean(); reject(error); };
      zip.once('entry', onEntry); zip.once('end', onEnd); zip.once('error', onError); zip.readEntry();
    });
    for (let entry = await next(); entry; entry = await next()) {
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      result.set(entry.fileName, Buffer.concat(chunks));
    }
  } finally { zip.close(); }
  return result;
}

async function writeArchive(file, entries) {
  const archive = new yazl.ZipFile();
  for (const [name, bytes] of entries) archive.addBuffer(bytes, name, { compress: false });
  const done = pipeline(archive.outputStream, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  archive.end();
  await done;
}

test('package_follows_relations_not_sheet_filename', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-package-'));
  try {
    const entries = await readArchive(fixture('lo-1904-values.xlsx'));
    const relPath = 'xl/_rels/workbook.xml.rels';
    entries.set(relPath, Buffer.from(entries.get(relPath).toString('utf8').replace('worksheets/sheet1.xml', 'worksheets/renamed.xml')));
    entries.set('xl/worksheets/renamed.xml', entries.get('xl/worksheets/sheet1.xml'));
    entries.delete('xl/worksheets/sheet1.xml');
    entries.set('[Content_Types].xml', Buffer.from(entries.get('[Content_Types].xml').toString('utf8').replace('/xl/worksheets/sheet1.xml', '/xl/worksheets/renamed.xml')));
    const renamed = path.join(directory, 'renamed.xlsx');
    await writeArchive(renamed, entries);
    const inventory = await inspectXlsxPackage({
      assetPath: renamed, stagingPath: directory, limits: XLSX_LIMITS,
    });
    assert.equal(inventory.date_system, '1904');
    assert.ok(inventory.sheets.some(sheet => sheet.kind === 'worksheet' && sheet.part !== 'xl/worksheets/sheet1.xml'));
    await disposeXlsxPackage(inventory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('selectable_visible_worksheet_only', async () => {
  assert.deepEqual(XLSX_LIMITS, {
    compressed_bytes: 67108864, entries: 2048, actual_unzip_bytes: 268435456,
    xml_bytes: 67108864, xml_depth: 64, cell_bytes: 65536, csv_bytes: 67108864,
    data_rows: 100000, columns: 256,
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-hidden-'));
  try {
    const entries = await readArchive(fixture('lo-1904-values.xlsx'));
    const workbookPath = 'xl/workbook.xml';
    entries.set(workbookPath, Buffer.from(entries.get(workbookPath).toString('utf8').replace('state="visible"', 'state="veryHidden"')));
    const hidden = path.join(directory, 'hidden.xlsx');
    await writeArchive(hidden, entries);
    const inventory = await inspectXlsxPackage({ assetPath: hidden, stagingPath: directory, limits: XLSX_LIMITS });
    assert.equal(inventory.sheets[0].kind, 'worksheet');
    assert.equal(inventory.sheets[0].state, 'veryHidden');
    assert.equal(inventory.sheets[0].selectable, false);
    await disposeXlsxPackage(inventory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('zip_actual_limits_and_metadata_checked', async () => {
  assert.equal(XLSX_LIMITS.compressed_bytes, 67108864);
  assert.equal(XLSX_LIMITS.actual_unzip_bytes, 268435456);
});

test('native_formula_table_and_excel_extension_samples_are_rejected', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-reject-'));
  try {
    for (const [name, expected] of [
      ['lo-formula-reject.xlsx', 'xlsx_formula_rejected'],
      ['lo-1900-values.xlsx', 'unsupported_xlsx_feature'],
      ['excel-cr-values.xlsx', 'unsupported_xlsx_feature'],
    ]) {
      await assert.rejects(inspectXlsxPackage({ assetPath: fixture(name), stagingPath: directory, limits: XLSX_LIMITS }), error => error.code === expected);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native_merge_package_inventory_is_not_a_conversion_approval', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-merge-'));
  try {
    const inventory = await inspectXlsxPackage({ assetPath: fixture('lo-merge-reject.xlsx'), stagingPath: directory, limits: XLSX_LIMITS });
    assert.equal(inventory.sheets.length, 1);
    assert.equal(inventory.sheets[0].selectable, true);
    await disposeXlsxPackage(inventory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('lo1904_native_package_is_positive_inventory_only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-positive-'));
  try {
    const inventory = await inspectXlsxPackage({ assetPath: fixture('lo-1904-values.xlsx'), stagingPath: directory, limits: XLSX_LIMITS });
    assert.equal(inventory.date_system, '1904');
    assert.equal(inventory.sheets.length, 1);
    assert.equal(inventory.sheets[0].selectable, true);
    assert.equal(inventory.sheets[0].part, 'xl/worksheets/sheet1.xml');
    assert.equal(inventory.source.sha256, '03de0d3fce4cb78e97eb37a8d1f469e694b045e4e17f9e47e287b61d967a4954');
    assert.ok([...inventory.parts.values()].every(part => part.path.startsWith('part-')));
    const workbook = projectWorkbook(inventory, '01234567-89ab-4cde-8fab-0123456789ab');
    assert.equal(workbook.source_sha256, inventory.source.sha256);
    assert.equal(Object.hasOwn(workbook.sheets[0], 'relationship_id'), false);
    const spec = { schema_version: 1, source_sha256: inventory.source.sha256, sheet_id: inventory.sheets[0].sheet_id,
      header_row: 1, column_start: 1, column_end: 1, last_row: 1, columns: [{ column: 1, mode: 'stored_text' }], formula_policy: 'reject' };
    assert.equal(assertImportSpec(spec, inventory), spec);
    assert.throws(() => assertImportSpec({ ...spec, extra: true }, inventory), error => error.code === 'invalid_import_spec');
    await disposeXlsxPackage(inventory);
    assert.ok(await import('node:fs/promises').then(({ readdir }) => readdir(directory)).then(names => names.every(name => name !== 'unrelated')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('frozen_metadata_accepts_prefix_variants_and_no_extension', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-prefix-'));
  try {
    for (const transform of [
      source => source.replaceAll('loext:', 'vendor:').replace('xmlns:loext=', 'xmlns:vendor='),
      source => source.replace(/<extLst>.*?<\/extLst>/, ''),
    ]) {
      const entries = await readArchive(fixture('lo-1904-values.xlsx'));
      const name = 'xl/workbook.xml';
      entries.set(name, Buffer.from(transform(entries.get(name).toString('utf8'))));
      const target = path.join(directory, `prefix-${Math.random()}.xlsx`);
      await writeArchive(target, entries);
      const inventory = await inspectXlsxPackage({ assetPath: target, stagingPath: directory, limits: XLSX_LIMITS });
      assert.equal(inventory.date_system, '1904');
      await disposeXlsxPackage(inventory);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('hidden_worksheet_formula_is_rejected_even_without_cached_value', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-hidden-formula-'));
  try {
    const entries = await readArchive(fixture('lo-1904-values.xlsx'));
    const workbook = entries.get('xl/workbook.xml').toString('utf8');
    entries.set('xl/workbook.xml', Buffer.from(workbook.replace('state="visible"', 'state="hidden"')));
    const sheet = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
    entries.set('xl/worksheets/sheet1.xml', Buffer.from(sheet.replace('</sheetData>', '<row r="9"><c r="A9"><f>1+1</f></c></row></sheetData>')));
    const target = path.join(directory, 'hidden-formula.xlsx');
    await writeArchive(target, entries);
    await assert.rejects(inspectXlsxPackage({ assetPath: target, stagingPath: directory, limits: XLSX_LIMITS }), error => error.code === 'xlsx_formula_rejected');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('frozen_metadata_and_unused_default_negative_variants_are_rejected', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-metadata-'));
  try {
    const manifest = JSON.parse(await readFile(fixture('malicious-manifest.json'), 'utf8'));
    assert.equal(manifest.schema_version, 1);
    for (const item of manifest.cases) {
      const entries = await readArchive(fixture(manifest.base_fixture));
      if (item.part) {
        const before = entries.get(item.part).toString('utf8');
        assert.ok(before.includes(item.find), `${item.id}: mutation anchor missing`);
        entries.set(item.part, Buffer.from(before.replace(item.find, item.replace)));
      }
      if (item.add_part) entries.set(item.add_part, Buffer.from(item.bytes_base64, 'base64'));
      const target = path.join(directory, `${item.id}.xlsx`);
      await writeArchive(target, entries);
      await assert.rejects(inspectXlsxPackage({ assetPath: target, stagingPath: directory, limits: XLSX_LIMITS }), error => error.code === item.expect, item.id);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('relationship_target_allows_contained_parent_segment', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-contained-'));
  try {
    const entries = await readArchive(fixture('lo-1904-values.xlsx'));
    const name = 'xl/_rels/workbook.xml.rels';
    entries.set(name, Buffer.from(entries.get(name).toString('utf8').replace('worksheets/sheet1.xml', '../xl/worksheets/sheet1.xml')));
    const target = path.join(directory, 'contained.xlsx');
    await writeArchive(target, entries);
    const inventory = await inspectXlsxPackage({ assetPath: target, stagingPath: directory, limits: XLSX_LIMITS });
    assert.equal(inventory.sheets[0].part, 'xl/worksheets/sheet1.xml');
    await disposeXlsxPackage(inventory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('independent_python_zipfile_mutations_cover_zip_structure_and_counts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-python-mutations-'));
  try {
    execFileSync('python3', [
      'scripts/check-xlsx-oracle.py', '--xml-cases', 'tests/fixtures/xlsx/xml-cases.json',
      '--genuine-manifest', 'tests/fixtures/xlsx/genuine-save-manifest.json',
      '--malicious-manifest', 'tests/fixtures/xlsx/malicious-manifest.json',
      '--write-malicious-dir', directory,
    ], { stdio: 'ignore' });
    const manifest = JSON.parse(await readFile(fixture('malicious-manifest.json'), 'utf8'));
    for (const id of manifest.zip_mutations) {
      const target = path.join(directory, `${id}.xlsx`);
      const before = (await import('node:fs/promises')).readdir(directory);
      if (id === 'bit3_descriptor_valid' || id === 'safe_inert_directory') {
        const inventory = await inspectXlsxPackage({ assetPath: target, stagingPath: directory, limits: XLSX_LIMITS });
        assert.equal(inventory.date_system, '1904');
        await disposeXlsxPackage(inventory);
      } else {
        const expected = id === 'entry_count_2049' ? 'xlsx_limit_exceeded'
          : ['encrypted_entry','unsupported_method','symlink_entry','special_file_entry'].includes(id) ? 'unsupported_xlsx_feature'
            : 'invalid_xlsx';
        await assert.rejects(inspectXlsxPackage({ assetPath: target, stagingPath: directory, limits: XLSX_LIMITS }), error => error.code === expected, id);
      }
      assert.deepEqual(await (await import('node:fs/promises')).readdir(directory), await before);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('lower_limits_enforce_compressed_actual_xml_bytes_and_xml_depth', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-lower-limits-'));
  try {
    const base = fixture('lo-1904-values.xlsx');
    for (const limits of [
      { ...XLSX_LIMITS, compressed_bytes: 100 },
      { ...XLSX_LIMITS, actual_unzip_bytes: 100 },
      { ...XLSX_LIMITS, xml_bytes: 100 },
    ]) await assert.rejects(inspectXlsxPackage({ assetPath: base, stagingPath: directory, limits }), error => error.code === 'xlsx_limit_exceeded');
    const entries = await readArchive(base);
    const workbookPath = 'xl/workbook.xml';
    const source = entries.get(workbookPath).toString('utf8');
    const nested = `<sheets>${'<s>'.repeat(63)}${'</s>'.repeat(63)}`;
    entries.set(workbookPath, Buffer.from(source.replace('<sheets>', nested)));
    const deep = path.join(directory, 'deep.xlsx');
    await writeArchive(deep, entries);
    await assert.rejects(inspectXlsxPackage({ assetPath: deep, stagingPath: directory, limits: XLSX_LIMITS }), error => error.code === 'xlsx_limit_exceeded');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
