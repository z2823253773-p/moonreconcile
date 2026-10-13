import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { renderCsv } from '../../cli/render.mjs';
import { canonicalJsonStringify } from '../../cli/io.mjs';
import { inspectImport } from '../engine-host.mjs';
import { inspectXlsxPackage, disposeXlsxPackage } from './package.mjs';
import { assertImportSpec, XLSX_LIMITS, OOXML_TYPES, OOXML_MAIN, OOXML_OFFICE } from './contracts.mjs';
import { parseXmlEvents } from './xml.mjs';
import { convertCell } from './values.mjs';

const MAIN=OOXML_MAIN, REL=OOXML_OFFICE;
const FAIL = (code, record=null, field=null) => Object.assign(new Error('Workbook conversion failed.'), {code,phase:'xlsx',record,field});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const elements = node => node.children.filter(child => typeof child !== 'string');
const children = (node,uri,local) => elements(node).filter(child=>child.uri===uri&&child.local===local);
const first = (node,uri,local) => children(node,uri,local)[0]??null;
const attr = (node,name,uri='') => node.attrs.find(item=>item.uri===uri&&item.local===name)?.value;

function parseTree(bytes,part,limits) {
  const stack=[];let root=null;
  let eventCount=0;
  parseXmlEvents(bytes,{limits,part,onEvent(event){
    eventCount++;
    if(event.type==='open'){
      const node={uri:event.uri,local:event.local,attrs:event.attributes,children:[]};
      if(stack.length)stack.at(-1).children.push(node);else root=node;stack.push(node);
    } else if(event.type==='text'||event.type==='cdata') { if(stack.length)stack.at(-1).children.push(event.value); }
    else stack.pop();
  }});
  return root;
}
function text(node){return node.children.filter(child=>typeof child==='string').join('');}
function textRuns(node) {
  const parts=[];let runs=0;
  for(const child of elements(node)) {
    if(child.uri!==MAIN) continue;
    if(child.local==='t') parts.push(text(child));
    else if(child.local==='r') { runs++;const item=first(child,MAIN,'t');if(item)parts.push(text(item)); }
  }
  return {value:parts.join(''),runs};
}
function columnNumber(letters) { let result=0;for(const char of letters)result=result*26+char.charCodeAt(0)-64;return result; }
function coordinate(value) {
  const match=/^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value??'');
  if(!match)throw FAIL('invalid_xlsx');
  const column=columnNumber(match[1]),row=Number(match[2]);
  if(column<1||column>16384||row>1048576)throw FAIL('invalid_xlsx');
  return {row,column};
}
function coordinateText(row,column) {
  let value='',n=column;
  while(n){const d=(n-1)%26;value=String.fromCharCode(65+d)+value;n=Math.floor((n-1)/26);}
  return `${value}${row}`;
}
function readShared(root,limits) {
  if(!root)return [];
  const items=children(root,MAIN,'si');if(items.length>1000000)throw FAIL('xlsx_limit_exceeded');
  let total=0;
  return items.map(item=>{const joined=textRuns(item);total+=Buffer.byteLength(joined.value,'utf8');if(total>67108864||Buffer.byteLength(joined.value,'utf8')>limits.cell_bytes)throw FAIL('xlsx_limit_exceeded');return joined;});
}
function readFormats(root) {
  if(!root)return [];
  const custom=new Map();const numFmts=first(root,MAIN,'numFmts');
  for(const item of numFmts?children(numFmts,MAIN,'numFmt'):[])custom.set(attr(item,'numFmtId'),attr(item,'formatCode'));
  const xfs=first(root,MAIN,'cellXfs');
  return (xfs?children(xfs,MAIN,'xf'):[]).map(xf=>custom.get(attr(xf,'numFmtId'))??'General');
}
function parseRef(ref) {
  const m=/^([A-Z]{1,3})([1-9][0-9]*):([A-Z]{1,3})([1-9][0-9]*)$/.exec(ref??'');
  if(!m)throw FAIL('invalid_xlsx');
  return {first:{column:columnNumber(m[1]),row:Number(m[2])},last:{column:columnNumber(m[3]),row:Number(m[4])}};
}
function overlaps(cell,spec) {return cell.row>=spec.header_row&&cell.row<=spec.last_row&&cell.column>=spec.column_start&&cell.column<=spec.column_end;}
function cellValue(node,shared,limits,part) {
  const coordinateValue=attr(node,'r'),pos=coordinate(coordinateValue),kind=attr(node,'t')??'n';
  const styleText=attr(node,'s');
  const styleIndex=styleText===undefined?null:Number(styleText);
  const v=first(node,MAIN,'v'),inline=first(node,MAIN,'is');
  let type='numeric',stored=v?text(v):'',richRuns=0;
  if(kind==='s') {
    const raw=stored;
    if(!/^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>=shared.length)throw FAIL('invalid_xlsx',pos.row,coordinateValue);
    const sharedCell=shared[Number(raw)];stored=sharedCell.value;richRuns=sharedCell.runs;type='text';
  } else if(kind==='inlineStr') { const joined=textRuns(inline);stored=joined.value;richRuns=joined.runs;type=stored===''?'blank':'text'; }
  else if(kind==='str') { type=stored===''?'blank':'text'; }
  else if(kind==='b') { if(stored==='')type='blank';else if(stored==='0'||stored==='1')type='boolean';else throw FAIL('invalid_xlsx',pos.row,coordinateValue); }
  else if(kind==='n') { if(stored==='')type='blank'; }
  else throw FAIL('unsupported_xlsx_feature',pos.row,coordinateValue);
  if(Buffer.byteLength(stored,'utf8')>limits.cell_bytes)throw FAIL('xlsx_limit_exceeded',pos.row,coordinateValue);
  return {coordinate:coordinateValue,row:pos.row,column:pos.column,type,stored_value:stored,style_index:styleIndex,rich_runs:richRuns,has_style:styleText!==undefined,part};
}
function rangeRows(spec) {return spec.last_row-spec.header_row;}
function exactUnique(values) {const set=new Set(values);return set.size===values.length;}
function warningList(counts) {
  const order=['hidden_rows_included','filtered_rows_included','outside_range_value_cells','outside_range_merges','rich_text_formatting_ignored'];
  return order.filter(code=>counts[code]>0).map(code=>({code,count:counts[code]}));
}
function addCount(counts,key,value=1) {counts[key]+=value;if(!Number.isSafeInteger(counts[key]))throw FAIL('xlsx_limit_exceeded');}
function styleIndexFor(cell,rowStyles,columnStyles) {
  if(cell.has_style)return cell.style_index??0;
  if(rowStyles.has(cell.row))return rowStyles.get(cell.row);
  for(const range of columnStyles)if(cell.column>=range.min&&cell.column<=range.max)return range.style;
  return 0;
}

/** Convert a verified OOXML package into the existing core's canonical CSV. */
export async function convertXlsx({assetPath,importSpec,side,stagingPath,invoke,limits=XLSX_LIMITS,signal}={}) {
  if(!['left','right'].includes(side)||typeof invoke!=='function'||typeof assetPath!=='string'||typeof stagingPath!=='string')throw FAIL('invalid_import_spec');
  const activeLimits=limits??XLSX_LIMITS;
  const partsDir=path.join(stagingPath,'parts');await fs.mkdir(partsDir,{recursive:true,mode:0o700});
  let inventory;
  try {
    if(signal?.aborted)throw signal.reason??FAIL('invalid_xlsx');
    inventory=await inspectXlsxPackage({assetPath,stagingPath:partsDir,limits:activeLimits,signal});
    assertImportSpec(importSpec,inventory);
    const sheet=inventory.sheets.find(item=>item.sheet_id===importSpec.sheet_id);
    const worksheetPart=inventory.parts.get(sheet.part);
    const tree=parseTree(await fs.readFile(worksheetPart.path),sheet.part,{xml_bytes:activeLimits.xml_bytes,xml_depth:activeLimits.xml_depth});
    const sharedPart=[...inventory.parts.values()].find(p=>p.content_type===OOXML_TYPES.sharedStrings);
    const stylesPart=[...inventory.parts.values()].find(p=>p.content_type===OOXML_TYPES.styles);
    const shared=readShared(sharedPart?parseTree(await fs.readFile(sharedPart.path),'sharedStrings.xml',{xml_bytes:activeLimits.xml_bytes,xml_depth:activeLimits.xml_depth}):null,activeLimits);
    const formats=readFormats(stylesPart?parseTree(await fs.readFile(stylesPart.path),'styles.xml',{xml_bytes:activeLimits.xml_bytes,xml_depth:activeLimits.xml_depth}):null);
    const data=first(tree,MAIN,'sheetData');if(!data)throw FAIL('invalid_xlsx');
    const rows=children(data,MAIN,'row'),cells=[],rowStyles=new Map(),hiddenRows=new Set();
    const columnStyles=[];
    const cols=first(tree,MAIN,'cols');
    for(const col of cols?children(cols,MAIN,'col'):[]) {
      const min=Number(attr(col,'min')),max=Number(attr(col,'max')),style=Number(attr(col,'style')??'0');
      if(Number.isSafeInteger(min)&&Number.isSafeInteger(max)&&Number.isSafeInteger(style))columnStyles.push({min,max,style});
    }
    for(const rowNode of rows) {
      const row=Number(attr(rowNode,'r'));
      const rowStyleText=attr(rowNode,'s');if(rowStyleText!==undefined)rowStyles.set(row,Number(rowStyleText));
      const hidden=attr(rowNode,'hidden');if(hidden==='1'||hidden==='true')hiddenRows.add(row);
      for(const node of children(rowNode,MAIN,'c'))cells.push(cellValue(node,shared,activeLimits,sheet.part));
    }
    cells.sort((a,b)=>a.row-b.row||a.column-b.column);
    const byPosition=new Map(cells.map(cell=>[`${cell.row}:${cell.column}`,cell]));
    const header=[];
    for(let col=importSpec.column_start;col<=importSpec.column_end;col++) {
      const cell=byPosition.get(`${importSpec.header_row}:${col}`);
      if(!cell||cell.type!=='text'||cell.stored_value==='')throw FAIL('xlsx_value_mode_mismatch',importSpec.header_row,coordinateText(importSpec.header_row,col));
      header.push(cell.stored_value);
    }
    if(!exactUnique(header))throw FAIL('invalid_import_spec',importSpec.header_row);
    const canonicalCsv=path.join(stagingPath,'canonical.csv'),profilePath=path.join(stagingPath,'profile.json'),manifestPath=path.join(stagingPath,'adapter.json');
    let csvHandle=null;
    let csvBytes=0,rowCount=0;
    const write=async chunk=>{const bytes=Buffer.from(chunk,'utf8');if(csvBytes+bytes.length>activeLimits.csv_bytes)throw FAIL('xlsx_limit_exceeded');csvBytes+=bytes.length;await csvHandle.write(bytes);};
    const counts={blank:0,text:0,numeric_lexemes:0,expanded_exponents:0,booleans:0,dates:0,zero_padded_identifiers:0};
    const warningCounts={hidden_rows_included:0,filtered_rows_included:0,outside_range_value_cells:0,outside_range_merges:0,rich_text_formatting_ignored:0};
    const filterNode=first(tree,MAIN,'autoFilter');const filter=filterNode?parseRef(attr(filterNode,'ref')):null;
    const mergesNode=first(tree,MAIN,'mergeCells');
    for(const mergeNode of mergesNode?children(mergesNode,MAIN,'mergeCell'):[]) {
      const merge=parseRef(attr(mergeNode,'ref'));
      if(!(merge.last.row<importSpec.header_row||merge.first.row>importSpec.last_row||merge.last.column<importSpec.column_start||merge.first.column>importSpec.column_end))throw FAIL('unsupported_xlsx_feature');
      addCount(warningCounts,'outside_range_merges');
    }
    for(const cell of cells) {
      if(cell.stored_value!==''&&!overlaps(cell,importSpec))addCount(warningCounts,'outside_range_value_cells');
      if(overlaps(cell,importSpec)&&cell.row>importSpec.header_row&&cell.type==='text'&&cell.rich_runs>1)addCount(warningCounts,'rich_text_formatting_ignored');
    }
    try {
    csvHandle=await fs.open(canonicalCsv,'wx',0o600);
    await write(renderCsv(header,[]));
    for(let row=importSpec.header_row+1;row<=importSpec.last_row;row++) {
      if(signal?.aborted)throw signal.reason??FAIL('xlsx_limit_exceeded');
      if(hiddenRows.has(row))addCount(warningCounts,'hidden_rows_included');
      if(filter&&row>=filter.first.row&&row<=filter.last.row&&filter.first.column<=importSpec.column_end&&filter.last.column>=importSpec.column_start)addCount(warningCounts,'filtered_rows_included');
      const output=[];
      for(let index=0;index<importSpec.columns.length;index++) {
        const physical=importSpec.column_start+index;
        const cell=byPosition.get(`${row}:${physical}`)??{coordinate:coordinateText(row,physical),row,column:physical,type:'blank',stored_value:'',style_index:null};
        const styleIndex=styleIndexFor(cell,rowStyles,columnStyles);
        if(!Number.isSafeInteger(styleIndex)||styleIndex<0||styleIndex>=formats.length)throw FAIL('invalid_xlsx',row,cell.coordinate);
        const storedCell={coordinate:cell.coordinate,row:cell.row,column:cell.column,type:cell.type,stored_value:cell.stored_value,style_index:cell.has_style?cell.style_index:styleIndex};
        const converted=convertCell(storedCell,importSpec.columns[index].mode,{date_system:inventory.date_system,number_format:formats[styleIndex]??'General',limits:activeLimits});
        if(Buffer.byteLength(converted.value,'utf8')>activeLimits.cell_bytes)throw FAIL('xlsx_limit_exceeded',row,cell.coordinate);
        addCount(counts,converted.category);
        if(converted.expanded)addCount(counts,'expanded_exponents');
        output.push(converted.value);
      }
      await write(renderCsv([], [output]).slice(1));
      rowCount++;
    }
    if(rowCount>activeLimits.data_rows||header.length>activeLimits.columns)throw FAIL('xlsx_limit_exceeded');
    } finally {if(csvHandle)await csvHandle.close();}
    const csvData=await fs.readFile(canonicalCsv);
    const preview=await inspectImport(csvData,{invoke,side});
    const profile={schema_version:1,adapter_id:'restricted-ooxml',adapter_version:'1.0.0',import_spec:importSpec};
    const profileBytes=Buffer.from(canonicalJsonStringify(profile),'utf8');
    if(profileBytes.length>1048576)throw FAIL('xlsx_limit_exceeded');
    const profileHandle=await fs.open(profilePath,'wx',0o600);try{await profileHandle.writeFile(profileBytes);}finally{await profileHandle.close();}
    const warnings=warningList(warningCounts);
    const worksheet={sheet_id:sheet.sheet_id,name:sheet.name,relationship_id:sheet.relationship_id,part:sheet.part,date_system:inventory.date_system};
    const manifest={schema_version:1,adapter_id:'restricted-ooxml',adapter_version:'1.0.0',profile:{bytes:profileBytes.length,sha256:hash(profileBytes)},source:{bytes:inventory.source.bytes,sha256:inventory.source.sha256},canonical_csv:{bytes:csvData.length,sha256:hash(csvData)},worksheet,row_mapping:{kind:'rectangle',header_row:importSpec.header_row,data_first_row:importSpec.header_row+1,row_count:rowCount,column_start:importSpec.column_start,column_end:importSpec.column_end},warnings,conversion_counts:counts};
    const manifestBytes=Buffer.from(canonicalJsonStringify(manifest),'utf8');if(manifestBytes.length>1048576)throw FAIL('xlsx_limit_exceeded');
    const manifestHandle=await fs.open(manifestPath,'wx',0o600);try{await manifestHandle.writeFile(manifestBytes);}finally{await manifestHandle.close();}
    return {csv_path:canonicalCsv,profile_path:profilePath,adapter_manifest_path:manifestPath,preview};
  } catch(error) {
    if(error?.error||error?.phase&&error.phase!=='xlsx')throw error;
    if(error?.code&&String(error.code).startsWith('xlsx_')||error?.code==='invalid_xlsx'||error?.code==='unsupported_xlsx_feature'||error?.code==='invalid_import_spec')throw error;
    throw FAIL('invalid_xlsx');
  } finally { if(inventory)await disposeXlsxPackage(inventory); }
}
