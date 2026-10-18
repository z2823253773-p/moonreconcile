import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { convertXlsx } from '../workbench/xlsx/adapter.mjs';
import { inspectXlsxPackage, disposeXlsxPackage } from '../workbench/xlsx/package.mjs';
import { XLSX_LIMITS } from '../workbench/xlsx/contracts.mjs';
import { loadBridgeInvoke } from '../cli/bridge.mjs';

const fixture = name => path.resolve('tests/fixtures/xlsx', name);
const hashFile = async p => createHash('sha256').update(await fs.readFile(p)).digest('hex');

for (const [file,dateSystem] of [['lo-conversion-1900.xlsx','1900'],['lo-conversion-1904.xlsx','1904']]) {
  test(`adapter reproduces genuine LibreOffice ${dateSystem} stored-value conversion`, async t => {
    const stagingPath=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-adapter-'));t.after(()=>fs.rm(stagingPath,{recursive:true,force:true}));
    const inventory=await inspectXlsxPackage({assetPath:fixture(file),stagingPath});t.after(()=>disposeXlsxPackage(inventory));
    const sheet=inventory.sheets[0];
    const importSpec={schema_version:1,source_sha256:inventory.source.sha256,sheet_id:sheet.sheet_id,header_row:1,column_start:1,column_end:6,last_row:5,columns:[
      {column:1,mode:'stored_text'},{column:2,mode:'decimal_lexeme'},{column:3,mode:'stored_text'},
      {column:4,mode:'excel_date'},{column:5,mode:'zero_padded_identifier'},{column:6,mode:'stored_text'}],formula_policy:'reject'};
    const result=await convertXlsx({assetPath:fixture(file),importSpec,side:'left',stagingPath,invoke:await loadBridgeInvoke(),limits:XLSX_LIMITS});
    const csv=await fs.readFile(result.csv_path);
    assert.deepEqual(csv,await fs.readFile(fixture(file.replace('.xlsx','-reference.csv'))));
    assert.equal(await hashFile(result.csv_path),dateSystem==='1900'?'393b7834578406b26ebf62321e62ef9bc11020bd5ec53daa11c4ff06d030e89e':'11209dcaf415406fef9bf8f9f69a7269eb76e8136395ee3dd635dd82412ed783');
    const profile=JSON.parse(await fs.readFile(result.profile_path,'utf8'));
    assert.deepEqual(profile,{schema_version:1,adapter_id:'restricted-ooxml',adapter_version:'1.0.0',import_spec:importSpec});
    const manifest=JSON.parse(await fs.readFile(result.adapter_manifest_path,'utf8'));
    assert.equal(manifest.source.sha256,inventory.source.sha256);
    assert.equal(manifest.canonical_csv.sha256,await hashFile(result.csv_path));
    assert.equal(manifest.row_mapping.row_count,4);
    assert.equal(result.preview.row_count,4);
  });
}

test('adapter rejects source identity mismatch before creating a result', async t => {
  const stagingPath=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-adapter-mismatch-'));t.after(()=>fs.rm(stagingPath,{recursive:true,force:true}));
  const inventory=await inspectXlsxPackage({assetPath:fixture('lo-conversion-1904.xlsx'),stagingPath});t.after(()=>disposeXlsxPackage(inventory));
  const importSpec={schema_version:1,source_sha256:'0'.repeat(64),sheet_id:`${'0'.repeat(64)}:1`,header_row:1,column_start:1,column_end:1,last_row:1,columns:[{column:1,mode:'stored_text'}],formula_policy:'reject'};
  await assert.rejects(convertXlsx({assetPath:fixture('lo-conversion-1904.xlsx'),importSpec,side:'left',stagingPath,invoke:await loadBridgeInvoke(),limits:XLSX_LIMITS}),e=>e.code==='xlsx_source_mismatch');
  await assert.rejects(fs.stat(path.join(stagingPath,'canonical.csv')));
});


async function makeSynthetic(t, kind) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-adapter-synthetic-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const output=path.join(root,'synthetic.xlsx');
  const script=String.raw`import re,sys,zipfile
src,dst,kind=sys.argv[1:]
with zipfile.ZipFile(src) as a, zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED) as b:
 for info in a.infolist():
  data=a.read(info.filename)
  if info.filename=='xl/worksheets/sheet1.xml':
   xml=data.decode('utf-8')
   if kind=='str-once':
    xml=re.sub(r'<c r="A2"[^>]*>.*?</c>', '<c r="A2" t="str"><v>_x005F_x0061_</v></c>', xml)
   if kind in ('lexical','core-whitespace','bad-date-type'):
    xml=re.sub(r'<c r="A2"[^>]*><v>[^<]*</v></c>', '<c r="A2" s="1" t="inlineStr"><is><r><t>_x005F_x0061_</t></r><r><t>&#60;b&#62;x&#60;/b&#62;</t></r><r><t><![CDATA[ &amp; ]]></t></r><rPh sb="0" eb="1"><t>phonetic</t></rPh></is></c>', xml)
    xml=re.sub(r'(<c r="B2"[^>]*><v>)[^<]*(</v></c>)',r'\g<1>9007199254740993\g<2>',xml)
    xml=re.sub(r'(<c r="B3"[^>]*><v>)[^<]*(</v></c>)',r'\g<1>123456789012345678901234567890\g<2>',xml)
    xml=xml.replace('<c r="F2" s="0" t="n">','<c r="F2" s="0" t="b">')
    xml=xml.replace('<c r="F3" s="0" t="n">','<c r="F3" s="0" t="b">')
    xml=re.sub(r'(<row r="2"[^>]*?) hidden="false"',r'\g<1> hidden="true"',xml)
    xml=xml.replace('</worksheet>','<mergeCells count="1"><mergeCell ref="A5:B5"/></mergeCells></worksheet>')
    if kind=='core-whitespace':
     xml=re.sub(r'<c r="A1"[^>]*><v>[^<]*</v></c>','<c r="A1" s="1" t="inlineStr"><is><t>  </t></is></c>',xml)
    if kind=='bad-date-type': xml=xml.replace('t="inlineStr"><is><r><t>_x005F_x0061_','t="d"><v>2025-01-01</v></c><c r="AA999" t="inlineStr"><is><r><t>_x005F_x0061_')
    if kind=='formula-outside': xml=xml.replace('<c r="B2" s="0"><v>9007199254740990</v></c>','<c r="B2"><f>1+1</f><v>2</v></c>')
   elif kind=='formula-outside': xml=xml.replace('<c r="B2" s="0" t="n"><v>9007199254740990</v></c>','<c r="B2"><f>1+1</f><v>2</v></c>')
   elif kind=='date-type-outside': xml=xml.replace('<c r="C2" s="0" t="n"><v>123</v></c>','<c r="C2" t="d"><v>2026-01-01</v></c>')
   elif kind=='error-type-outside': xml=xml.replace('<c r="C2" s="0" t="n"><v>123</v></c>','<c r="C2" t="e"><v>#REF!</v></c>')
   rows=re.findall(r'<row\b[^>]*>.*?</row>',xml)
   if kind=='lexical':
    for row in rows:
     if 'r="2"' in row:
      cells=re.findall(r'<c\b[^>]*>.*?</c>',row); row2=row
      for cell in cells: row2=row2.replace(cell,'')
      row2=row2.replace('</row>',''.join(reversed(cells))+'</row>')
      xml=xml.replace(row,row2)
    rows=re.findall(r'<row\b[^>]*>.*?</row>',xml)
    for row in rows:
     if 'r="2"' in row or 'r="3"' in row: xml=xml.replace(row,'')
    xml=xml.replace('</sheetData>',''.join(reversed([r for r in rows if 'r="1"' not in r and 'r="5"' not in r]))+'</sheetData>')
   data=xml.encode('utf-8')
  b.writestr(info,data)
`;
  execFileSync('python3',['-c',script,fixture('lo-conversion-1904.xlsx'),output,kind]);
  return {root,output};
}

async function convertFor(t, source, {last_row=4,column_start=1,column_end=6,columns,limits=XLSX_LIMITS}={}) {
  const stagingPath=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-adapter-synthetic-out-'));t.after(()=>fs.rm(stagingPath,{recursive:true,force:true}));
  const inventory=await inspectXlsxPackage({assetPath:source,stagingPath});
  t.after(()=>disposeXlsxPackage(inventory));
  const modes=columns??Array.from({length:column_end-column_start+1},(_,index)=>({column:column_start+index,mode:['stored_text','decimal_lexeme','stored_text','excel_date','zero_padded_identifier','stored_text'][column_start-1+index]}));
  const importSpec={schema_version:1,source_sha256:inventory.source.sha256,sheet_id:inventory.sheets[0].sheet_id,header_row:1,column_start,column_end,last_row,columns:modes,formula_policy:'reject'};
  const result=await convertXlsx({assetPath:source,importSpec,side:'left',stagingPath,invoke:await loadBridgeInvoke(),limits});
  return {result,inventory,stagingPath};
}

test('adapter decodes inline rich text once, preserves exact numeric strings, sorts physical cells, includes blank rows and warns', async t => {
  const {output}=await makeSynthetic(t,'lexical');
  const {result}=await convertFor(t,output,{last_row:4});
  const csv=await fs.readFile(result.csv_path,'utf8');
  assert.equal(csv,'text_id,numeric_long,decimal,date_serial,padded,boolean\n_x0061_<b>x</b> &amp; ,9007199254740993,123,1904-01-01,00123,TRUE\nend,123456789012345678901234567890,0.000123,1904-02-29,00000,FALSE\n,,,,,\n');
  const manifest=JSON.parse(await fs.readFile(result.adapter_manifest_path,'utf8'));
  assert.deepEqual(manifest.warnings,[{code:'hidden_rows_included',count:1},{code:'outside_range_value_cells',count:5},{code:'outside_range_merges',count:1},{code:'rich_text_formatting_ignored',count:1}]);
  assert.deepEqual(manifest.conversion_counts,{blank:6,text:4,numeric_lexemes:2,expanded_exponents:0,booleans:2,dates:2,zero_padded_identifiers:2});
});

test('adapter decodes stored string-cell Xstring escapes once', async t => {
  const {output}=await makeSynthetic(t,'str-once');
  const {result}=await convertFor(t,output,{last_row:2,column_start:1,column_end:1,columns:[{column:1,mode:'stored_text'}]});
  assert.equal(await fs.readFile(result.csv_path,'utf8'),'text_id\n_x0061_\n');
});

test('adapter retains an all-empty one-column physical row as one CSV record', async t => {
  const {result}=await convertFor(t,fixture('lo-conversion-1904.xlsx'),{last_row:4,column_start:6,column_end:6,columns:[{column:6,mode:'stored_text'}]});
  assert.equal(await fs.readFile(result.csv_path,'utf8'),'boolean\n1\n0\n\n');
});

test('adapter delegates whitespace-only header rejection to the core inspect', async t => {
  const {output}=await makeSynthetic(t,'core-whitespace');
  const stagingPath=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-core-header-'));t.after(()=>fs.rm(stagingPath,{recursive:true,force:true}));
  const inventory=await inspectXlsxPackage({assetPath:output,stagingPath});t.after(()=>disposeXlsxPackage(inventory));
  const importSpec={schema_version:1,source_sha256:inventory.source.sha256,sheet_id:inventory.sheets[0].sheet_id,header_row:1,column_start:1,column_end:1,last_row:1,columns:[{column:1,mode:'stored_text'}],formula_policy:'reject'};
  await assert.rejects(convertXlsx({assetPath:output,importSpec,side:'left',stagingPath,invoke:await loadBridgeInvoke()}),e=>e.code==='invalid_header'&&e.phase!=='xlsx');
});

test('adapter fails workbook-wide formula policy when formula lies outside selected rectangle', async t => {
  await assert.rejects(convertFor(t,fixture('lo-formula-reject.xlsx'),{last_row:1,column_start:1,column_end:1,columns:[{column:1,mode:'stored_text'}]}),e=>e.code==='xlsx_formula_rejected');
});


test('adapter includes filtered and hidden rows and reports the native filter counts', async t => {
  const {result,inventory}=await convertFor(t,fixture('lo-native-filter.xlsx'),{last_row:3,columns:Array.from({length:6},(_,i)=>({column:i+1,mode:'stored_text'}))});
  assert.equal(inventory.source.sha256,'74dbde7450c6e56de05a54891e8c9b9f6240a8212c783c129473c1c5cb706d4e');
  assert.equal(await fs.readFile(result.csv_path,'utf8'),'id,text,unicode,whitespace,literal,cr\n00123,hello,雪🙂,  keep  ,_x0061_,"line\nbreak"\nhidden,row,,,,\n');
  const manifest=JSON.parse(await fs.readFile(result.adapter_manifest_path,'utf8'));
  assert.deepEqual(manifest.warnings,[{code:'hidden_rows_included',count:1},{code:'filtered_rows_included',count:2},{code:'rich_text_formatting_ignored',count:1}]);
});


test('adapter reuses package guards for date/error cells outside the selected rectangle', async t => {
  for (const [kind,code] of [['date-type-outside','unsupported_xlsx_feature'],['error-type-outside','xlsx_cell_error']]) {
    const {output}=await makeSynthetic(t,kind);
    await assert.rejects(convertFor(t,output,{last_row:1,column_start:1,column_end:1,columns:[{column:1,mode:'stored_text'}]}),e=>e.code===code,kind);
  }
});

test('adapter rejects a selected merge and obeys lowered CSV byte bounds', async t => {
  const source=fixture('lo-merge-reject.xlsx');
  const stagingPath=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-merge-reject-'));t.after(()=>fs.rm(stagingPath,{recursive:true,force:true}));
  const specStage=path.join(stagingPath,'spec');await fs.mkdir(specStage);
  const inventory=await inspectXlsxPackage({assetPath:source,stagingPath:specStage});t.after(()=>disposeXlsxPackage(inventory));
  const importSpec={schema_version:1,source_sha256:inventory.source.sha256,sheet_id:inventory.sheets[0].sheet_id,header_row:1,column_start:1,column_end:1,last_row:1,columns:[{column:1,mode:'stored_text'}],formula_policy:'reject'};
  await assert.rejects(convertXlsx({assetPath:source,importSpec,side:'left',stagingPath,invoke:await loadBridgeInvoke(),limits:XLSX_LIMITS}),e=>e.code==='unsupported_xlsx_feature');
  await assert.rejects(fs.stat(path.join(stagingPath,'canonical.csv')),e=>e.code==='ENOENT');
  await assert.rejects(convertFor(t,fixture('lo-conversion-1904.xlsx'),{last_row:1,column_start:1,column_end:6,limits:{...XLSX_LIMITS,csv_bytes:16}}),e=>e.code==='xlsx_limit_exceeded'&&e.phase==='xlsx');
});

// Synthetic edge inputs are distinct from the unchanged application-saved workbooks.
const edgeVectors=JSON.parse(await fs.readFile(fixture('conversion-edge-vectors.json'),'utf8')).cases;
for(const vector of edgeVectors) {
  test(`repair edge ${vector.id}`, async t => {
    const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-repair-edge-'));
    t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
    const directory=process.env.TASK3_EDGE_OUTPUT?path.join(path.resolve(process.env.TASK3_EDGE_OUTPUT),vector.id):temporary;
    await fs.mkdir(directory,{recursive:true});
    const source=path.join(directory,'source.xlsx');
    const mutation=String.raw`import re,json,sys,zipfile
source,destination,vector_json=sys.argv[1:];v=json.loads(vector_json)
with zipfile.ZipFile(source) as a,zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED) as b:
 for info in a.infolist():
  name=info.filename;data=a.read(name)
  if name=='xl/worksheets/sheet1.xml':data=v['sheet_xml'].encode()
  if name=='xl/workbook.xml' and 'date_system' in v:data=data.replace(b'date1904="true"',b'date1904="false"' if v['date_system']=='1900' else b'date1904="true"')
  if v.get('no_styles'):
   if name=='xl/styles.xml':continue
   if name=='xl/_rels/workbook.xml.rels':data=re.sub(rb'<Relationship\b[^>]*Type="[^"]*/styles"[^>]*/>',b'',data)
   if name=='[Content_Types].xml':data=re.sub(rb'<Override\b[^>]*PartName="/xl/styles.xml"[^>]*/>',b'',data)
  if name=='xl/styles.xml':
   if 'format' in v:data=re.sub(rb'(<numFmt numFmtId="165" formatCode=")[^"]*',lambda m:m[1]+v['format'].encode(),data)
   if v.get('builtin_zero'):data=re.sub(rb'<numFmt numFmtId="165"[^>]*/>',b'',data).replace(b'<numFmts count="2">',b'<numFmts count="1">').replace(b'numFmtId="165"',b'numFmtId="1"')
  if name=='xl/sharedStrings.xml' and 'shared_xml' in v:data=v['shared_xml'].encode()
  b.writestr(info,data)
`;
    execFileSync('python3',['-c',mutation,fixture('lo-conversion-1904.xlsx'),source,JSON.stringify(vector)]);
    const sourceSha=await hashFile(source);
    const spec={schema_version:1,source_sha256:sourceSha,sheet_id:`${sourceSha}:1`,header_row:vector.header_row,column_start:vector.column_start,column_end:vector.column_end,last_row:vector.last_row,columns:vector.modes.map((mode,index)=>({column:vector.column_start+index,mode})),formula_policy:'reject'};
    await fs.writeFile(path.join(directory,'import-spec.json'),JSON.stringify(spec));
    let result,error;
    try { result=await convertXlsx({assetPath:source,importSpec:spec,side:'left',stagingPath:directory,invoke:await loadBridgeInvoke(),limits:{...XLSX_LIMITS,...vector.limits}}); }
    catch(e){const diagnostic=e.error??e;error={code:diagnostic.code,phase:diagnostic.phase,record:diagnostic.record??null,field:diagnostic.field??null};await fs.writeFile(path.join(directory,'error.json'),JSON.stringify(error));}
    if(vector.error) {
      assert.deepEqual(error,vector.error);
      if(vector.no_csv)await assert.rejects(fs.stat(path.join(directory,'canonical.csv')),e=>e.code==='ENOENT');
    } else {
      assert.equal(error,undefined);
      assert.equal(await fs.readFile(result.csv_path,'utf8'),vector.csv);
      const manifest=JSON.parse(await fs.readFile(result.adapter_manifest_path,'utf8'));
      assert.deepEqual(manifest.warnings,vector.warnings??(vector.id==='header-rich'||vector.id==='header-s'?[{code:'rich_text_formatting_ignored',count:1}]:[]));
      assert.equal(Object.entries(manifest.conversion_counts).filter(([key])=>key!=='expanded_exponents').reduce((n,[,value])=>n+value,0),(vector.last_row-vector.header_row)*vector.modes.length);
    }
  });
}
