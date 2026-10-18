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
    assert.ok([...inventory.parts.values()].every(part => path.isAbsolute(part.path) && path.basename(part.path).startsWith('part-')));
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
      const before = await (await import('node:fs/promises')).readdir(directory);
      if (['bit3_descriptor_valid','bit3_descriptor_unsigned','safe_inert_directory','entry_count_2048'].includes(id)) {
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

// Synthetic mutations below establish concrete repair risks; native bytes remain untouched.
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/package/2006/relationships';
const D = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const sheetPath = 'xl/worksheets/sheet1.xml';
const minimalSheet = contents => `<worksheet xmlns="${S}" xmlns:r="${R}"><sheetData>${contents}</sheetData></worksheet>`;
const rowCell = cell => `<row r="1">${cell}</row>`;
async function mutation(label, change, check, native = 'lo-1904-values.xlsx', limits = XLSX_LIMITS) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xlsx-repair-'));
  let inventory;
  try {
    const entries = await readArchive(fixture(native));
    await change(entries);
    const target = path.join(directory, 'synthetic.xlsx');
    await writeArchive(target, entries);
    const inspect = () => inspectXlsxPackage({ assetPath: target, stagingPath: directory, limits });
    await check(inspect, entries, directory);
  } finally { if (inventory) await disposeXlsxPackage(inventory); await rm(directory, { recursive: true, force: true }); }
}
const rejects = code => async inspect => assert.rejects(inspect(), e => e.code === code);
const accept = async inspect => { const inventory = await inspect(); await disposeXlsxPackage(inventory); };
function setXml(entries, name, change) { const before = entries.get(name).toString(); const after = change(before); assert.notEqual(after, before, name); entries.set(name, Buffer.from(after)); }
function addTyped(entries, name, type, xml) {
  entries.set(name, Buffer.from(xml));
  setXml(entries, '[Content_Types].xml', s => s.replace('</Types>', `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${type}+xml"/></Types>`));
}

test('C1 genuine ordinary sheet has independent nonzero counts and bounds', async () => {
  await mutation('native-counts', () => {}, async inspect => {
    const inventory = await inspect();
    try { assert.deepEqual(Object.fromEntries(['value_cells','min_row','max_row','min_column','max_column'].map(k => [k, inventory.sheets[0][k]])), {value_cells:6,min_row:1,max_row:2,min_column:1,max_column:3}); }
    finally { await disposeXlsxPackage(inventory); }
  });
});
for (const [id, cell, code] of [
  ['error', '<c r="A1" t="e"><v>#VALUE!</v></c>', 'xlsx_cell_error'],
  ['duplicate', '<c r="A1"><v>1</v></c><c r="A1"><v>2</v></c>', 'invalid_xlsx'],
  ['row-mismatch', '<c r="A2"><v>1</v></c>', 'invalid_xlsx'],
  ['coordinate-upper', '<c r="XFE1"><v>1</v></c>', 'invalid_xlsx'],
  ['coordinate-unsafe', '<c r="A9007199254740993"><v>1</v></c>', 'invalid_xlsx'],
  ['sst-outside', '<c r="A1" t="s"><v>999</v></c>', 'invalid_xlsx'],
  ['sst-fraction', '<c r="A1" t="s"><v>1.0</v></c>', 'invalid_xlsx'],
  ['style-outside', '<c r="A1" s="999"><v>1</v></c>', 'invalid_xlsx'],
  ['style-fraction', '<c r="A1" s="0.5"><v>1</v></c>', 'invalid_xlsx'],
  ['type-unknown', '<c r="A1" t="d"><v>2026-01-01</v></c>', 'unsupported_xlsx_feature'],
  ['value-nested', '<c r="A1"><v><t>1</t></v></c>', 'unsupported_xlsx_feature'],
  ['inline-missing', '<c r="A1" t="inlineStr"/>', 'invalid_xlsx'],
  ['inline-extra', '<c r="A1"><is><t>x</t></is></c>', 'invalid_xlsx'],
]) test(`C1 ${id} under real sheetData rejects`, async () => mutation(id, e => e.set(sheetPath, Buffer.from(minimalSheet(rowCell(cell)))), rejects(code)));

for (const [id, xml, code] of [
  ['formula', minimalSheet(rowCell('<c r="A1"><f>1+1</f><v>2</v></c>')), 'xlsx_formula_rejected'],
  ['error', minimalSheet(rowCell('<c r="A1" t="e"><v>#REF!</v></c>')), 'xlsx_cell_error'],
  ['syntax', `<worksheet xmlns="${S}">`, 'invalid_xlsx'],
  ['DTD', `<!DOCTYPE worksheet [<!ENTITY x "x">]>${minimalSheet('')}`, 'unsupported_xlsx_feature'],
  ['namespace', '<worksheet xmlns="urn:unexpected"/>', 'unsupported_xlsx_feature'],
  ['depth', `<worksheet xmlns="${S}">${'<x>'.repeat(64)}${'</x>'.repeat(64)}</worksheet>`, 'xlsx_limit_exceeded'],
]) for (const ext of ['bin','XML']) test(`I1 unused typed ${ext} ${id} is fully scanned`, async () => mutation(id, e => addTyped(e, `xl/unused.${ext}`, 'worksheet', xml), rejects(code)));

for (const [id, name, transform, code = 'unsupported_xlsx_feature'] of [
  ['ct-root-text','[Content_Types].xml',s=>s.replace('</Types>','bad</Types>'),'invalid_xlsx'],
  ['rels-root-text','_rels/.rels',s=>s.replace('</Relationships>','bad</Relationships>'),'invalid_xlsx'],
  ['nested-Default','[Content_Types].xml',s=>s.replace(/(<Default[^>]+)\/>/,'$1><Default Extension="x" ContentType="x"/></Default>')],
  ['nested-Override','[Content_Types].xml',s=>s.replace(/(<Override[^>]+)\/>/,'$1><Unknown/></Override>')],
  ['nested-external-relation','_rels/.rels',s=>s.replace(/(<Relationship [^>]+)\/>/,'$1><Relationship Id="evil" TargetMode="External" Type="x" Target="https://example.com"/></Relationship>')],
  ['nested-unknown-relation','_rels/.rels',s=>s.replace(/(<Relationship [^>]+)\/>/,'$1><Unknown/></Relationship>')],
  ['wrong-row-parent',sheetPath,s=>s.replace('</worksheet>','<row r="9"/></worksheet>')],
  ['wrong-cell-parent',sheetPath,s=>s.replace('</worksheet>','<c r="A9"/></worksheet>')],
  ['wrong-sheet-parent','xl/workbook.xml',s=>s.replace('</workbook>','<sheet name="wrong" sheetId="9" r:id="none"/></workbook>')],
  ['unknown-MAIN-sibling',sheetPath,s=>s.replace('</worksheet>','<unknown/></worksheet>')],
  ['unknown-ordinary-attr',sheetPath,s=>s.replace('<worksheet ', '<worksheet surprise="yes" ')],
  ['unapproved-AC-attr',sheetPath,s=>s.replace('<worksheet ', '<worksheet xmlns:ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" ac:bogus="yes" ')],
  ['wrong-AC-context',sheetPath,s=>s.replace('<worksheet ', '<worksheet xmlns:ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" ac:dyDescent="1" ')],
  ['wrong-AC-namespace-context','docProps/app.xml',s=>s.replace('</Properties>', '<row xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" ac:dyDescent="1"/></Properties>')],
]) test(`I2 exact schema ${id}`, async () => mutation(id, e=>setXml(e,name,transform), rejects(code)));

function renamePart(e, oldName, newName, sourceRels) {
  e.set(newName, e.get(oldName)); e.delete(oldName);
  setXml(e, '[Content_Types].xml', s=>s.replace(`/${oldName}`,`/${newName}`));
  setXml(e, sourceRels, s=>s.replace(path.posix.relative(sourceRels === '_rels/.rels' ? '.' : 'xl',oldName),path.posix.relative(sourceRels === '_rels/.rels' ? '.' : 'xl',newName)));
}
for (const [id, oldName, newName, rels] of [
  ['workbook','xl/workbook.xml','xl/renamed.xml','_rels/.rels'],
  ['SST','xl/sharedStrings.xml','xl/strings.bin','xl/_rels/workbook.xml.rels'],
  ['styles','xl/styles.xml','xl/format.XML','xl/_rels/workbook.xml.rels'],
]) test(`I3 relation selects renamed ${id}`, async () => mutation(id,e=>{
  renamePart(e,oldName,newName,rels);
  if(id==='workbook'){e.set('xl/_rels/renamed.xml.rels',e.get('xl/_rels/workbook.xml.rels'));e.delete('xl/_rels/workbook.xml.rels');}
},accept));
for (const [id, transform, code] of [
 ['missing-SST', s=>s.replace(/<Relationship [^>]*Type="[^"]*\/sharedStrings"[^>]*\/>/,''),'invalid_xlsx'],
 ['duplicate-SST', s=>s.replace('</Relationships>',`<Relationship Id="extra" Type="${R}/sharedStrings" Target="./sharedStrings.xml"/></Relationships>`),'invalid_xlsx'],
 ['wrong-SST-type', s=>s.replace(`${R}/sharedStrings`,`${R}/styles`),'unsupported_xlsx_feature'],
 ['duplicate-target-sheet',s=>s.replace('</Relationships>',`<Relationship Id="extra" Type="${R}/worksheet" Target="./worksheets/sheet1.xml"/></Relationships>`),'invalid_xlsx'],
]) test(`I3 ${id}`,async()=>mutation(id,e=>setXml(e,'xl/_rels/workbook.xml.rels',transform),rejects(code)));

test('I3 unused officeDocument relation must have workbook type and root context', async()=>mutation('unused-office',e=>{
 e.set('xl/worksheets/_rels/sheet1.xml.rels',Buffer.from(`<Relationships xmlns="${P}"><Relationship Id="bad" Type="${R}/officeDocument" Target="../styles.xml"/></Relationships>`));
},rejects('unsupported_xlsx_feature')));
for (const target of ['/xl/worksheets/sheet1.xml','../../../escape.xml','worksheets/sheet1.xml?x','worksheets/sheet1.xml#x','%2e%2e/worksheets/sheet1.xml','https://example.com/file']) test(`I3 target safety ${target}`,async()=>mutation('target',e=>setXml(e,'xl/_rels/workbook.xml.rels',s=>s.replace('worksheets/sheet1.xml',target)),rejects('unsupported_xlsx_feature')));

test('I4 unreferenced worksheet invalid cells count and reject',async()=>mutation('unused-sheet',e=>addTyped(e,'xl/unreferenced.xml','worksheet',minimalSheet(rowCell('<c r="A1" s="999"><v>1</v></c>'))),rejects('invalid_xlsx')));
for (const [type,xml] of [['sharedStrings',`<sst xmlns="${S}"><si><unknown/></si></sst>`],['styles',`<styleSheet xmlns="${S}"><cellXfs><xf/></cellXfs><unknown/></styleSheet>`]]) test(`I4 unused extra ${type} cannot bypass validation`,async()=>mutation(type,e=>addTyped(e,`xl/extra-${type}.bin`,type,xml),rejects('unsupported_xlsx_feature')));

test('I4 rich text excludes phonetic text from lower cell bytes and nonempty counts',async()=>mutation('phonetic',e=>{
 e.set(sheetPath,Buffer.from(minimalSheet(rowCell('<c r="A1" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r><rPh sb="0" eb="2"><t>phonetic annotation</t></rPh></is></c>'))));
},async inspect=>{const i=await inspect();try{assert.equal(i.sheets[0].value_cells,1);}finally{await disposeXlsxPackage(i);}},'lo-1904-values.xlsx',{...XLSX_LIMITS,cell_bytes:2}));
test('I4 lower decoded UTF8 cell limit boundary accepts',async()=>mutation('cell-limit',e=>{
 e.set(sheetPath,Buffer.from(minimalSheet(rowCell('<c r="A1" t="inlineStr"><is><t>雪🙂</t></is></c>'))));
},accept,'lo-1904-values.xlsx',{...XLSX_LIMITS,cell_bytes:7}));
test('I4 lower decoded UTF8 cell limit plus one rejects',async()=>mutation('cell-limit',e=>{
 e.set(sheetPath,Buffer.from(minimalSheet(rowCell('<c r="A1" t="inlineStr"><is><t>雪🙂</t></is></c>'))));
},rejects('xlsx_limit_exceeded'),'lo-1904-values.xlsx',{...XLSX_LIMITS,cell_bytes:6}));

test('I5 stream-open rejection closes extraction and zip handles and preserves unrelated caller file',async()=>{
 const fsp=(await import('node:fs/promises')).default;
 const originalOpen=fsp.open, originalStream=yauzl.ZipFile.prototype.openReadStreamPromise, originalClose=yauzl.ZipFile.prototype.close;
 const handles=[];let zipClosed=0,zipClosedEvents=0;const directory=await mkdtemp(path.join(os.tmpdir(),'xlsx-fd-'));
 try{
  await fsp.writeFile(path.join(directory,'unrelated'),'preserve');
  fsp.open=async(...args)=>{const h=await originalOpen(...args);if(args[1]==='wx')handles.push(h);return h;};
  yauzl.ZipFile.prototype.openReadStreamPromise=async()=>{throw new Error('deliberate acquisition failure');};
  yauzl.ZipFile.prototype.close=function(){zipClosed++;this.once('close',()=>zipClosedEvents++);return originalClose.call(this);};
  await assert.rejects(inspectXlsxPackage({assetPath:fixture('lo-1904-values.xlsx'),stagingPath:directory}),e=>e.code==='invalid_xlsx');
  assert.equal(handles.length,1);assert.ok(handles.every(h=>h.fd===-1),'already acquired FileHandle must close');assert.ok(zipClosed>0);assert.ok(zipClosedEvents>0,'ZIP descriptor close must finish before failure settles');
  assert.equal(await fsp.readFile(path.join(directory,'unrelated'),'utf8'),'preserve');assert.deepEqual(await fsp.readdir(directory),['unrelated']);
 }finally{fsp.open=originalOpen;yauzl.ZipFile.prototype.openReadStreamPromise=originalStream;yauzl.ZipFile.prototype.close=originalClose;for(const h of handles)if(h.fd!==-1)await h.close();await rm(directory,{recursive:true,force:true});}
});
test('I5 cancellation during final entry cannot return an inventory',async()=>{
 const original=yauzl.ZipFile.prototype.openReadStreamPromise;const controller=new AbortController();const directory=await mkdtemp(path.join(os.tmpdir(),'xlsx-abort-'));
 try{yauzl.ZipFile.prototype.openReadStreamPromise=async function(entry){const stream=await original.call(this,entry);if(entry.fileName==='docProps/app.xml')controller.abort();return stream;};
 await assert.rejects(inspectXlsxPackage({assetPath:fixture('lo-1904-values.xlsx'),stagingPath:directory,signal:controller.signal}),e=>e.name==='AbortError');
 assert.deepEqual(await (await import('node:fs/promises')).readdir(directory),[]);
 }finally{yauzl.ZipFile.prototype.openReadStreamPromise=original;await rm(directory,{recursive:true,force:true});}
});

test('M2 OwnedPart is numeric metadata with absolute generated usable paths, private disposal only',async()=>mutation('owned',()=>{},async(inspect,e,directory)=>{
 const fsp=await import('node:fs/promises');await fsp.writeFile(path.join(directory,'unrelated'),'preserve');const inventory=await inspect();
 try{assert.deepEqual(Object.keys(inventory).sort(),['date_system','parts','sheets','source']);for(const [name,part] of inventory.parts){assert.ok(path.isAbsolute(part.path));assert.deepEqual(Object.keys(part).sort(),['bytes','content_type','path','sha256']);assert.equal(part.bytes,e.get(name).length);assert.deepEqual(await readFile(part.path),e.get(name));}}
 finally{await disposeXlsxPackage(inventory);await disposeXlsxPackage(inventory);}assert.equal(await readFile(path.join(directory,'unrelated'),'utf8'),'preserve');
 await disposeXlsxPackage({path:directory,parts:new Map()});assert.equal(await readFile(path.join(directory,'unrelated'),'utf8'),'preserve');
}));

test('M1 malformed sheet ID differs from a well-formed source binding mismatch and asset UUID enforced',async()=>mutation('DTO',()=>{},async inspect=>{
 const i=await inspect();try{const spec={schema_version:1,source_sha256:i.source.sha256,sheet_id:i.sheets[0].sheet_id,header_row:1,column_start:1,column_end:1,last_row:1,columns:[{column:1,mode:'stored_text'}],formula_policy:'reject'};
 for(const sheet_id of [null,[],123,'x',`${i.source.sha256}:0`,`${i.source.sha256}:01`])assert.throws(()=>assertImportSpec({...spec,sheet_id},i),e=>e.code==='invalid_import_spec');
 assert.throws(()=>assertImportSpec({...spec,sheet_id:`${'a'.repeat(64)}:1`},i),e=>e.code==='xlsx_source_mismatch');
 for(const asset of ['','x','01234567-89ab-1cde-8fab-0123456789ab','01234567-89ab-4cde-0fab-0123456789ab'])assert.throws(()=>projectWorkbook(i,asset),e=>e.code==='invalid_xlsx');
 for(const patch of [{header_row:0},{header_row:1048577},{column_start:0},{column_end:16385},{column_end:257},{last_row:100002},{last_row:0},{columns:[{column:2,mode:'stored_text'}]},{columns:[{column:1,mode:'guess'}]},{columns:[{column:1,mode:'stored_text',extra:1}]}])assert.throws(()=>assertImportSpec({...spec,...patch},i),e=>e.code==='invalid_import_spec');
 for(const sheet of [{...i.sheets[0],state:'hidden',selectable:false},{...i.sheets[0],kind:'other',selectable:false}])assert.throws(()=>assertImportSpec(spec,{...i,sheets:[sheet]}),e=>e.code==='invalid_import_spec');
 }finally{await disposeXlsxPackage(i);}
}));

async function drawingMutation(id, change, check) {
 return mutation(id, e=>{setXml(e,'xl/workbook.xml',s=>s.replace(/<definedNames>.*?<\/definedNames>/,''));return change(e);},check,'lo-native-filter.xlsx');
}
const drawingPath='xl/drawings/drawing1.xml';
const drawingRels='xl/worksheets/_rels/sheet1.xml.rels';
for(const [id,change] of [
 ['empty',()=>{}],
 ['XML-whitespace',e=>e.set(drawingPath,Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:wsDr xmlns:a="${D}"> \t&#13;\n<![CDATA[ \t\n]]></a:wsDr>`))],
 ['internal-hyperlink-other-target',e=>setXml(e,drawingRels,s=>s.replace('</Relationships>',`<Relationship Id="link" Type="${R}/hyperlink" Target="../styles.xml"/></Relationships>`))],
])test(`approved empty drawing synthetic positive ${id}`,async()=>drawingMutation(id,change,accept));
for(const ch of ['\u00a0','\ufeff','\u2003','\u2028'])for(const node of ['target','drawing','autoFilter'])test(`exact XML_WS rejects ${ch.codePointAt(0).toString(16)} in ${node}`,async()=>drawingMutation('whitespace',e=>{
 if(node==='target')e.set(drawingPath,Buffer.from(`<wsDr xmlns="${D}">${ch}</wsDr>`));
 else setXml(e,sheetPath,s=>node==='drawing'?s.replace(/<drawing([^>]+)\/>/,`<drawing$1>${ch}</drawing>`):s.replace(/<autoFilter([^>]+)>(?:<\/autoFilter>)/,`<autoFilter$1>${ch}</autoFilter>`));
},rejects('unsupported_xlsx_feature')));
for(const [id,change,code='unsupported_xlsx_feature']of[
 ['child',e=>e.set(drawingPath,Buffer.from(`<wsDr xmlns="${D}"><oneCellAnchor/></wsDr>`))],
 ['ordinary-attribute',e=>e.set(drawingPath,Buffer.from(`<wsDr xmlns="${D}" surprise="x"/>`))],
 ['xml-space',e=>e.set(drawingPath,Buffer.from(`<wsDr xmlns="${D}" xml:space="preserve"/>`))],
 ['mc-Ignorable',e=>e.set(drawingPath,Buffer.from(`<wsDr xmlns="${D}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x"/>`))],
 ['wrong-root',e=>e.set(drawingPath,Buffer.from(`<drawing xmlns="${D}"/>`))],
 ['empty-target-rels',e=>e.set('xl/drawings/_rels/drawing1.xml.rels',Buffer.from(`<Relationships xmlns="${P}"/>`))],
 ['hidden-owner',e=>setXml(e,'xl/workbook.xml',s=>s.replace('state="visible"','state="hidden"'))],
 ['no-filter',e=>setXml(e,sheetPath,s=>s.replace(/<autoFilter[^>]+><\/autoFilter>/,''))],
 ['no-marker',e=>setXml(e,sheetPath,s=>s.replace(/<drawing[^>]+\/>/,''))],
 ['duplicate-marker',e=>setXml(e,sheetPath,s=>s.replace(/(<drawing[^>]+\/>)/,'$1$1'))],
 ['duplicate-target',e=>{e.set('xl/drawings/extra.xml',e.get(drawingPath));setXml(e,'[Content_Types].xml',s=>s.replace('</Types>',`<Override PartName="/xl/drawings/extra.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`));}],
 ['explicit-Internal',e=>setXml(e,drawingRels,s=>s.replace('<Relationship Id=', '<Relationship TargetMode="Internal" Id='))],
 ['nested-relationship',e=>setXml(e,drawingRels,s=>s.replace(/(<Relationship [^>]+)\/>/,'$1><Relationship Id="nested" Type="x" Target="x"/></Relationship>'))],
 ['nested-Override',e=>setXml(e,'[Content_Types].xml',s=>s.replace(/(<Override [^>]*drawing[^>]+)\/>/,'$1><Override/></Override>'))],
 ['wrong-type',e=>setXml(e,'[Content_Types].xml',s=>s.replace('application/vnd.openxmlformats-officedocument.drawing+xml','application/vnd.openxmlformats-officedocument.theme+xml'))],
 ['drawing-Default',e=>setXml(e,'[Content_Types].xml',s=>s.replace('</Types>','<Default Extension="dml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'))],
 ['same-owner-nondrawing-inbound',e=>setXml(e,drawingRels,s=>s.replace('</Relationships>',`<Relationship Id="link" Type="${R}/hyperlink" Target="../drawings/./drawing1.xml"/></Relationships>`)),'invalid_xlsx'],
 ['other-source-nondrawing-inbound',e=>{e.set('xl/_rels/styles.xml.rels',Buffer.from(`<Relationships xmlns="${P}"><Relationship Id="link" Type="${R}/hyperlink" Target="drawings/drawing1.xml"/></Relationships>`));}],
 ['unreferenced-error-later',e=>addTyped(e,'xl/zz-unused.bin','worksheet',minimalSheet(rowCell('<c r="A1" t="e"><v>#REF!</v></c>'))),'xlsx_cell_error'],
 ['unreferenced-formula-later',e=>addTyped(e,'xl/zz-unused.bin','worksheet',minimalSheet(rowCell('<c r="A1"><f t="array" ref="A1:A1">1</f><v>1</v></c>'))),'xlsx_formula_rejected'],
])test(`approved empty drawing negative ${id}`,async()=>drawingMutation(id,change,rejects(code)));
for(const node of ['target','worksheet'])for(const kind of ['comment','PI'])for(const where of ['before','inside','after'])test(`strict ${node} ${kind} ${where}`,async()=>drawingMutation('strict',e=>{
 const name=node==='target'?drawingPath:sheetPath;const token=kind==='comment'?'<!--safe-->':'<?test safe?>';
 setXml(e,name,s=>where==='before'?s.replace(/(<\?xml[^>]*\?>)?/,`$1${token}`):where==='after'?s+token:s.replace(node==='target'?'</xdr:wsDr>':'</worksheet>',`${token}${node==='target'?'</xdr:wsDr>':'</worksheet>'}`));
},rejects('unsupported_xlsx_feature')));

for(const ref of ['A1:A1','A1:XFD1048576'])test(`autoFilter boundary positive ${ref}`,async()=>mutation('filter',e=>e.set(sheetPath,Buffer.from(minimalSheet('').replace('</worksheet>',`<autoFilter ref="${ref}"/></worksheet>`))),accept));
for(const ref of ['A1','$A$1:$F$3','a1:F3','A01:F3',' A1:F3','A1:F3 ','F3:A1','A1:XFE3','A1:F1048577','A1:F3,G1:G2','Synthetic!A1:F3','R1C1:R3C6'])test(`autoFilter malformed ref ${ref}`,async()=>mutation('filter',e=>e.set(sheetPath,Buffer.from(minimalSheet('').replace('</worksheet>',`<autoFilter ref="${ref}"/></worksheet>`))),rejects('invalid_xlsx')));
for(const [id,element]of[
 ['missing-ref','<autoFilter/>'],['qualified-ref',`<autoFilter r:ref="A1:F3"/>`],['extra-attribute','<autoFilter ref="A1:F3" hidden="1"/>'],['xml-space','<autoFilter ref="A1:F3" xml:space="preserve"/>'],
 ['predicate','<autoFilter ref="A1:F3"><filterColumn colId="0"><filters><filter val="x"/></filters></filterColumn></autoFilter>'],['duplicate','<autoFilter ref="A1:F3"/><autoFilter ref="A1:F3"/>'],['wrong-namespace','<autoFilter xmlns="urn:bad" ref="A1:F3"/>'],
])test(`autoFilter exact schema ${id}`,async()=>mutation('filter',e=>e.set(sheetPath,Buffer.from(minimalSheet('').replace('</worksheet>',`${element}</worksheet>`))),rejects(id==='missing-ref'?'invalid_xlsx':'unsupported_xlsx_feature')));
test('autoFilter wrong-parent fails',async()=>mutation('filter',e=>e.set(sheetPath,Buffer.from(minimalSheet('<autoFilter ref="A1:F3"/>'))),rejects('unsupported_xlsx_feature')));
test('nonqualifying worksheet preserves comments and PI default',async()=>mutation('default-tokens',e=>e.set(sheetPath,Buffer.from(`<!--before--><?test safe?>${minimalSheet(rowCell('<c r="A1" t="inlineStr"><is><t>x</t></is></c>'))}<!--after-->`)),accept));
test('qualifying worksheet rejects comment in cell even with no drawing',async()=>mutation('qualifying',e=>e.set(sheetPath,Buffer.from(minimalSheet(rowCell('<c r="A1" t="inlineStr"><is><t>x<!--cell--></t></is></c>')).replace('</worksheet>','<autoFilter ref="A1:F3"/></worksheet>'))),rejects('unsupported_xlsx_feature')));

for(const [id,transform]of[
 ['LO-value',s=>s.replace('CalcA1ExcelA1','bad')],['LO-namespace',s=>s.replace('http://schemas.libreoffice.org/','urn:bad')],
 ['duplicate-extLst',s=>s.replace(/(<extLst>.*?<\/extLst>)/,'$1$1')],['duplicate-ext',s=>s.replace(/(<ext .*?<\/ext>)/,'$1$1')],
 ['duplicate-extCalcPr',s=>s.replace(/(<loext:extCalcPr[^>]*\/>)/,'$1$1')],['nested-content',s=>s.replace(/(<loext:extCalcPr[^>]*?)\/>/,'$1><loext:child/></loext:extCalcPr>')],
 ['wrong-parent',s=>s.replace(/(<extLst>.*?<\/extLst>)/,'').replace('</sheets>', '<extLst><ext uri="{7626C862-2A13-11E5-B345-FEFF819CDC9F}"><loext:extCalcPr xmlns:loext="http://schemas.libreoffice.org/" stringRefSyntax="CalcA1ExcelA1"/></ext></extLst></sheets>')],
 ['NBSP-text',s=>s.replace('<extLst>','<extLst>\u00a0')],
])test(`I6 frozen metadata ${id}`,async()=>mutation(id,e=>setXml(e,'xl/workbook.xml',transform),rejects('unsupported_xlsx_feature')));
test('I6 LO metadata in wrong actual part rejects',async()=>mutation('LO-part',e=>{e.set('xl/unused.xml',Buffer.from(`<worksheet xmlns="${S}"><sheetData/><extLst><ext uri="{7626C862-2A13-11E5-B345-FEFF819CDC9F}"><loext:extCalcPr xmlns:loext="http://schemas.libreoffice.org/" stringRefSyntax="CalcA1ExcelA1"/></ext></extLst></worksheet>`));setXml(e,'[Content_Types].xml',s=>s.replace('</Types>',`<Override PartName="/xl/unused.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`));},rejects('unsupported_xlsx_feature')));
for(const type of ['shared','array','dataTable', 'dynamicArray'])test(`I6 frozen metadata cannot hide unused ${type} formula`,async()=>mutation(type,e=>addTyped(e,'xl/unused.xml','worksheet',minimalSheet(rowCell(`<c r="A1"><f t="${type}">1</f><v>1</v></c>`))),rejects('xlsx_formula_rejected')));
for(const [id,transform]of[
 ['Default-duplicate',s=>s.replace('</Types>','<Default Extension="PNG" ContentType="image/png"/></Types>')],
 ['Default-conflict',s=>s.replace('</Types>','<Default Extension="png" ContentType="application/xml"/></Types>')],
 ['Override-duplicate',s=>s.replace(/(<Override [^>]+\/>)/,'$1$1')],
 ['Override-case-alias',s=>s.replace('</Types>','<Override PartName="/XL/WORKBOOK.XML" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>')],
])test(`I6 content type ${id}`,async()=>mutation(id,e=>setXml(e,'[Content_Types].xml',transform),rejects('invalid_xlsx')));
for(const ext of ['PNG','JPEG','FNTDATA'])test(`I6 actual media case ${ext} remains unsupported`,async()=>mutation(ext,e=>e.set(`xl/media/unused.${ext}`,Buffer.from('binary')),rejects('unsupported_xlsx_feature')));
for(const [id,xml]of[
 ['wrong-namespace',`<Relationships xmlns="urn:bad"><Relationship Id="r" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
 ['wrong-type',`<Relationships xmlns="${P}"><Relationship Id="r" Type="${R}/vbaProject" Target="worksheets/sheet1.xml"/></Relationships>`],
 ['missing-id',`<Relationships xmlns="${P}"><Relationship Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
])test(`I6 relationship ${id}`,async()=>mutation(id,e=>e.set('xl/_rels/workbook.xml.rels',Buffer.from(xml)),rejects(id==='missing-id'?'invalid_xlsx':'unsupported_xlsx_feature')));
for(const key of Object.keys(XLSX_LIMITS))test(`lower-only limit cannot raise ${key}`,async()=>mutation(key,()=>{},rejects('invalid_xlsx'),'lo-1904-values.xlsx',{...XLSX_LIMITS,[key]:XLSX_LIMITS[key]+1}));

test('I6 compressed actual and XML counters exact-boundary and plus one',async()=>mutation('actual-boundary',()=>{},async(inspect,entries,directory)=>{
 const target=path.join(directory,'synthetic.xlsx');const bytes=(await (await import('node:fs/promises')).stat(target)).size;const actual=[...entries.values()].reduce((n,b)=>n+b.length,0);const xml=Math.max(...[...entries.values()].map(b=>b.length));
 for(const [key,value]of[['compressed_bytes',bytes],['actual_unzip_bytes',actual],['xml_bytes',xml],['entries',entries.size]]){
 const i=await inspectXlsxPackage({assetPath:target,stagingPath:directory,limits:{...XLSX_LIMITS,[key]:value}});await disposeXlsxPackage(i);
 await assert.rejects(inspectXlsxPackage({assetPath:target,stagingPath:directory,limits:{...XLSX_LIMITS,[key]:value-1}}),e=>e.code==='xlsx_limit_exceeded');}
}));

test('I4 whole-package populated cell ceiling includes two unreferenced worksheet parts',async()=>mutation('populated-ceiling',e=>{
 function col(n){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}
 function sheet(count){let source='<sheetData>';let row=1;while(count){source+=`<row r="${row}">`;for(let c=1;c<=Math.min(count,16384);c++)source+=`<c r="${col(c)}${row}"><v>1</v></c>`;count-=Math.min(count,16384);source+='</row>';row++;}return `<worksheet xmlns="${S}">${source}</sheetData></worksheet>`;}
 // Six native populated values + 500000 + 499995 => 1000001, while
 // neither individual sheet exceeds the same production bound.
 addTyped(e,'xl/extra-a.bin','worksheet',sheet(500000));addTyped(e,'xl/extra-b.bin','worksheet',sheet(499995));
},rejects('xlsx_limit_exceeded')));

const staticName='<definedNames><definedName function="false" hidden="true" localSheetId="0" name="_xlnm._FilterDatabase" vbProcedure="false">Synthetic!$A$1:$F$3</definedName></definedNames>';
// mutation() serializes synthetic copies; this direct test proves original native bytes.
test('static FilterDatabase genuine unmodified fixture source receipt',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'xlsx-native-original-'));try{const i=await inspectXlsxPackage({assetPath:fixture('lo-native-filter.xlsx'),stagingPath:directory});try{assert.equal(i.source.bytes,6691);assert.equal(i.source.sha256,'74dbde7450c6e56de05a54891e8c9b9f6240a8212c783c129473c1c5cb706d4e');assert.equal(i.sheets[0].value_cells,14);}finally{await disposeXlsxPackage(i);}}finally{await rm(directory,{recursive:true,force:true});}
});
for(const [id,transform]of[
 ['prefix',s=>s.replace('<definedNames>','<s:definedNames xmlns:s="'+S+'">').replace('</definedNames>','</s:definedNames>').replace('<definedName ','<s:definedName ').replace('</definedName>','</s:definedName>')],
 ['CDATA-reference',s=>s.replace('Synthetic!$A$1:$F$3','<![CDATA[Synthetic!$A]]>&#36;1:&#36;F&#36;3')],
 ['ordinal-vs-sheetId',s=>s.replace('sheetId="1"','sheetId="9"')],
])test(`static FilterDatabase exact positive ${id}`,async()=>mutation(id,e=>setXml(e,'xl/workbook.xml',transform),accept,'lo-native-filter.xlsx'));
for(const key of ['name','function','hidden','vbProcedure','localSheetId'])test(`static FilterDatabase missing attribute ${key}`,async()=>mutation(key,e=>setXml(e,'xl/workbook.xml',s=>s.replace(new RegExp(` ${key}="[^"]+"`),'')),rejects('invalid_xlsx'),'lo-native-filter.xlsx'));
for(const [id,transform]of[
 ['wrong-name',s=>s.replace('_xlnm._FilterDatabase','_xlnm.Print_Area')],['function-1',s=>s.replace('function="false"','function="0"')],['hidden-1',s=>s.replace('hidden="true"','hidden="1"')],['vbProcedure-true',s=>s.replace('vbProcedure="false"','vbProcedure="true"')],['local-1',s=>s.replace('localSheetId="0"','localSheetId="1"')],['local-00',s=>s.replace('localSheetId="0"','localSheetId="00"')],
 ['extra-leaf-attr',s=>s.replace('<definedName ','<definedName extra="x" ')],['qualified-leaf-attr',s=>s.replace('<definedName ','<definedName r:name="x" ')],['list-attr',s=>s.replace('<definedNames>','<definedNames xml:space="preserve">')],
 ['duplicate-list',s=>s.replace(staticName,staticName+staticName)],['duplicate-leaf',s=>s.replace('</definedNames>',staticName.replace('<definedNames>','').replace('</definedNames>','')+'</definedNames>')],
 ['wrong-parent',s=>s.replace(staticName,'').replace('</sheets>',staticName+'</sheets>')],['wrong-namespace',s=>s.replace('<definedNames>','<definedNames xmlns="urn:bad">')],
 ['Unicode-name',s=>s.replace('name="Synthetic"','name="雪"')],['quoted-name',s=>s.replace('name="Synthetic"','name="Some Sheet"')],['renamed-sheet',s=>s.replace('name="Synthetic"','name="Renamed"')],
 ['nested-child',s=>s.replace('</definedName>','<unknown/></definedName>')],['outer-NBSP',s=>s.replace('<definedNames>','<definedNames>\u00a0')],
])test(`static FilterDatabase reject ${id}`,async()=>mutation(id,e=>setXml(e,'xl/workbook.xml',transform),rejects('unsupported_xlsx_feature'),'lo-native-filter.xlsx'));
for(const text of ['=SUM(A1:A3)','1','Synthetic!A1:F3','Synthetic!$A$1:$E$3','Other!$A$1:$F$3',"'Synthetic'!$A$1:$F$3",'Synthetic:Other!$A$1:$F$3','[Other.xlsx]Synthetic!$A$1:$F$3','Synthetic!$A$1:$F$3,Synthetic!$A$1:$F$3',' Synthetic!$A$1:$F$3','Synthetic!$A$1:$F$3\n','Synthetic!$A$1:$F$3\u00a0','OtherName','Synthetic!$A:$F'])test(`static FilterDatabase reject exact text ${JSON.stringify(text)}`,async()=>mutation('text',e=>setXml(e,'xl/workbook.xml',s=>s.replace('Synthetic!$A$1:$F$3',text)),rejects('unsupported_xlsx_feature'),'lo-native-filter.xlsx'));
for(const [id,change]of[
 ['different-autoFilter',e=>setXml(e,sheetPath,s=>s.replace('<autoFilter ref="A1:F3">','<autoFilter ref="A1:E3">'))],
 ['no-drawing',e=>{setXml(e,sheetPath,s=>s.replace(/<drawing[^>]+\/>/,''));e.delete(drawingPath);e.delete(drawingRels);setXml(e,'[Content_Types].xml',s=>s.replace(/<Override[^>]*drawing[^>]*\/>/,''));}],
 ['no-filter',e=>setXml(e,sheetPath,s=>s.replace(/<autoFilter[^>]+><\/autoFilter>/,''))],
 ['hidden-owner',e=>setXml(e,'xl/workbook.xml',s=>s.replace('state="visible"','state="hidden"'))],
 ['other-ordinal-first',e=>{addTyped(e,'xl/other.xml','worksheet',minimalSheet(''));setXml(e,'xl/_rels/workbook.xml.rels',s=>s.replace('</Relationships>',`<Relationship Id="other" Type="${R}/worksheet" Target="other.xml"/></Relationships>`));setXml(e,'xl/workbook.xml',s=>s.replace('<sheets>','<sheets><sheet name="Other" sheetId="2" r:id="other"/>'));}],
])test(`static FilterDatabase binding ${id}`,async()=>mutation(id,change,rejects('unsupported_xlsx_feature'),'lo-native-filter.xlsx'));
for(const token of ['<!--safe-->','<?task safe?>'])for(const where of ['before','after','leaf','list','elsewhere'])test(`static FilterDatabase strict workbook ${token} ${where}`,async()=>mutation('strict-workbook',e=>setXml(e,'xl/workbook.xml',s=>where==='before'?s.replace(/(<\?xml[^>]+\?>)/,`$1${token}`):where==='after'?s+token:where==='leaf'?s.replace('Synthetic!$A$1:$F$3',`Synthetic!$A$1:${token}$F$3`):where==='list'?s.replace('<definedNames>',`<definedNames>${token}`):s.replace('<bookViews>',`<bookViews>${token}`)),rejects('unsupported_xlsx_feature'),'lo-native-filter.xlsx'));
test('static FilterDatabase absent workbook preserves default comments and PI',async()=>mutation('absent-default',e=>setXml(e,'xl/workbook.xml',s=>s.replace('</workbook>','<!--inert--><?task inert?></workbook>')),accept));
for(const kind of ['error','formula'])test(`static FilterDatabase valid metadata cannot hide unused ${kind}`,async()=>mutation(kind,e=>addTyped(e,'xl/unused.XML','worksheet',minimalSheet(rowCell(kind==='error'?'<c r="A1" t="e"><v>#REF!</v></c>':'<c r="A1"><f t="shared">1</f><v>1</v></c>'))),rejects(kind==='error'?'xlsx_cell_error':'xlsx_formula_rejected'),'lo-native-filter.xlsx'));

for(const ch of ['\u00a0','\ufeff','\u2003','\u2028'])test(`ref-only autoFilter without drawing rejects non XML whitespace ${ch.codePointAt(0).toString(16)}`,async()=>mutation('filter-whitespace',e=>e.set(sheetPath,Buffer.from(minimalSheet('').replace('</worksheet>',`<autoFilter ref="A1:F3">${ch}</autoFilter></worksheet>`))),rejects('unsupported_xlsx_feature')));

for(const [id,change,code]of[
 ['wrong-font-parent',e=>setXml(e,'xl/styles.xml',s=>s.replace('<font>','<font><rFont val="wrong"/>')),'unsupported_xlsx_feature'],
 ['wrong-rich-parent',e=>{e.set(sheetPath,Buffer.from(minimalSheet(rowCell('<c r="A1" t="inlineStr"><is><r><rPr><name val="wrong"/></rPr><t>x</t></r></is></c>'))));},'unsupported_xlsx_feature'],
 ['styles-count-mismatch',e=>setXml(e,'xl/styles.xml',s=>s.replace(/(<cellXfs count=")[0-9]+/, '$1999')),'invalid_xlsx'],
 ['fill-choice',e=>setXml(e,'xl/styles.xml',s=>s.replace('<fill>','<fill><gradientFill/>')),'invalid_xlsx'],
])test(`exact inert schema ${id}`,async()=>mutation(id,change,rejects(code)));
for(const [id,change,code]of[
 ['missing-root-office',e=>setXml(e,'_rels/.rels',s=>s.replace(/<Relationship [^>]*Type="[^"]*\/officeDocument"[^>]*\/>/,'')),'invalid_xlsx'],
 ['wrong-root-office-type',e=>setXml(e,'_rels/.rels',s=>s.replace('xl/workbook.xml','xl/styles.xml')),'unsupported_xlsx_feature'],
 ['missing-styles',e=>setXml(e,'xl/_rels/workbook.xml.rels',s=>s.replace(/<Relationship [^>]*Type="[^"]*\/styles"[^>]*\/>/,'')),'invalid_xlsx'],
 ['workbook-macro-type',e=>setXml(e,'[Content_Types].xml',s=>s.replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','application/vnd.ms-excel.sheet.macroEnabled.main+xml')),'unsupported_xlsx_feature'],
 ['workbook-XLSB-type',e=>setXml(e,'[Content_Types].xml',s=>s.replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','application/vnd.ms-excel.sheet.binary.macroEnabled.main')),'unsupported_xlsx_feature'],
 ['vba',e=>{e.set('xl/vbaProject.bin',Buffer.from('not-executable'));setXml(e,'[Content_Types].xml',s=>s.replace('</Types>','<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'));},'unsupported_xlsx_feature'],
 ['external-hyperlink',e=>e.set(drawingRels,Buffer.from(`<Relationships xmlns="${P}"><Relationship Id="external" Type="${R}/hyperlink" TargetMode="External" Target="https://example.com"/></Relationships>`)),'unsupported_xlsx_feature'],
 ['media-Override-related',e=>{e.set('xl/media/x.PNG',Buffer.from('image'));setXml(e,'[Content_Types].xml',s=>s.replace('</Types>','<Override PartName="/xl/media/x.PNG" ContentType="image/png"/></Types>'));e.set(drawingRels,Buffer.from(`<Relationships xmlns="${P}"><Relationship Id="img" Type="${R}/image" Target="../media/x.PNG"/></Relationships>`));},'unsupported_xlsx_feature'],
])test(`remaining mandatory security ${id}`,async()=>mutation(id,change,rejects(code)));
test('chartsheet inventory is other and cannot be selected',async()=>mutation('chartsheet',e=>{
 e.set('xl/chart-sheet.xml',Buffer.from(`<chartsheet xmlns="${S}"/>`));setXml(e,'[Content_Types].xml',s=>s.replace('</Types>',`<Override PartName="/xl/chart-sheet.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/></Types>`));setXml(e,'xl/_rels/workbook.xml.rels',s=>s.replace('</Relationships>',`<Relationship Id="chart" Type="${R}/chartsheet" Target="chart-sheet.xml"/></Relationships>`));setXml(e,'xl/workbook.xml',s=>s.replace('</sheets>','<sheet name="Chart" sheetId="2" r:id="chart"/></sheets>'));
},async inspect=>{const i=await inspect();try{assert.equal(i.sheets[1].kind,'other');assert.equal(i.sheets[1].selectable,false);}finally{await disposeXlsxPackage(i);}}));
for(const [count,code]of[[1000000,null],[1000001,'xlsx_limit_exceeded']])test(`actual SST item count ${count}`,async()=>mutation('SST-count',e=>e.set('xl/sharedStrings.xml',Buffer.from(`<sst xmlns="${S}" count="9007199254740991">${'<si/>'.repeat(count)}</sst>`)),code?rejects(code):accept));
for(const key of ['invalid-ole-XLS','encrypted-OOXML'])test(`non-ZIP ${key} signature is rejected`,async()=>{
 const fsp=await import('node:fs/promises'),dir=await mkdtemp(path.join(os.tmpdir(),'xlsx-signature-'));try{const target=path.join(dir,'disguised.xlsx');await fsp.writeFile(target,Buffer.from('d0cf11e0a1b11ae100000000','hex'));await assert.rejects(inspectXlsxPackage({assetPath:target,stagingPath:dir}),e=>e.code==='invalid_xlsx');}finally{await rm(dir,{recursive:true,force:true});}
});

// N1: row/column references use the same relation-selected cellXfs index space
// as c.s. The base native LO1904 styles has exactly two cellXfs (indices 0,1).
function inheritedStyleSheet(kind, index, populated) {
  const value = populated ? '<c r="A1"><v>1</v></c>' : '';
  return kind === 'row'
    ? minimalSheet(`<row r="1" s="${index}" customFormat="1" hidden="1">${value}</row>`)
    : `<worksheet xmlns="${S}"><cols><col min="1" max="16384" style="${index}" hidden="1"/></cols><sheetData>${populated ? rowCell(value) : ''}</sheetData></worksheet>`;
}
async function inheritedStyleCase(kind, index, context, check) {
  return mutation(`inherited-${kind}-${context}`, entries => {
    const xml = inheritedStyleSheet(kind, index, context === 'visible-populated');
    if (context === 'unused-empty') addTyped(entries, 'xl/unused-styled.XML', 'worksheet', xml);
    else entries.set(sheetPath, Buffer.from(xml));
    if (context === 'hidden-empty') setXml(entries, 'xl/workbook.xml', source => source.replace('state="visible"', 'state="hidden"'));
  }, check);
}
for (const kind of ['row','column']) for (const context of ['visible-populated','hidden-empty','unused-empty']) {
  for (const [label,index] of [
    ['noninteger','not-an-index'], ['fraction','1.0'], ['negative','-1'],
    ['noncanonical','01'], ['exponent','1e0'], ['one-past-last','2'],
    ['out-of-range','999'], ['safe-large-outside','9007199254740991'], ['unsafe','9007199254740993'],
  ]) test(`N1 rejects ${kind} ${label} ${context}`, async () => inheritedStyleCase(kind,index,context,rejects('invalid_xlsx')));
  for (const index of ['0','1']) test(`N1 accepts ${kind} index ${index} ${context}`, async () => inheritedStyleCase(kind,index,context,async inspect => {
    const inventory = await inspect();
    try {
      assert.equal(inventory.sheets[0].value_cells, context === 'visible-populated' ? 1 : context === 'unused-empty' ? 6 : 0);
      if (context === 'hidden-empty') assert.equal(inventory.sheets[0].selectable, false);
    } finally { await disposeXlsxPackage(inventory); }
  }));
}
test('N1 inherited styles use relationship-selected renamed styles part',async()=>mutation('inherited-renamed',entries=>{
 renamePart(entries,'xl/styles.xml','xl/selected-styles.bin','xl/_rels/workbook.xml.rels');
 entries.set(sheetPath,Buffer.from(inheritedStyleSheet('row','1',true).replace('<sheetData>','<cols><col min="1" max="1" style="1"/></cols><sheetData>')));
},accept));
