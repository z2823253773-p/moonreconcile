import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import crc32 from 'buffer-crc32';
import { parseXmlEvents } from './xml.mjs';
import { XLSX_LIMITS } from './contracts.mjs';
export { XLSX_LIMITS, XLSX_ERROR_CODES, assertImportSpec, projectWorkbook, isXlsxErrorCode } from './contracts.mjs';
const { openPromise } = yauzl;
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const LO = 'http://schemas.libreoffice.org/';
const EXC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const AC = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac';
const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
const DC = 'http://purl.org/dc/elements/1.1/';
const DCT = 'http://purl.org/dc/terms/';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const EP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
const CUST = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
const VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
const THEME = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS = new Set([MAIN, CT, PKG, OFFICE, XML, CP, DC, DCT, XSI, EP, CUST, VT, THEME, EXC, AC, LO]);
const relTypes = new Map([
  ['officeDocument', `${OFFICE}/officeDocument`], ['worksheet', `${OFFICE}/worksheet`],
  ['chartsheet', `${OFFICE}/chartsheet`], ['sharedStrings', `${OFFICE}/sharedStrings`],
  ['styles', `${OFFICE}/styles`], ['theme', `${OFFICE}/theme`], ['hyperlink', `${OFFICE}/hyperlink`],
  ['extended-properties', `${OFFICE}/extended-properties`], ['custom-properties', `${OFFICE}/custom-properties`],
  ['core-properties', `${PKG}/metadata/core-properties`],
]);
const defaultContent = new Map([
  ['xml','application/xml'], ['rels','application/vnd.openxmlformats-package.relationships+xml'],
]);
const frozenDefaults = new Set(['fntdata\0application/x-fontdata','jpeg\0image/jpeg','png\0image/png']);
const ownedDirectories = new WeakMap();

function xerr(code='invalid_xlsx') {
  const error = new Error(code === 'unsupported_xlsx_feature' ? 'Unsupported workbook feature.' : 'Invalid or damaged workbook package.');
  error.code = code; error.phase = 'xlsx'; return error;
}
function hash(bytes){ return createHash('sha256').update(bytes).digest('hex'); }
async function hashFile(file){const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');}
function getAttr(node, local, uri='') { return node.attrs.find(item => item.local === local && item.uri === uri)?.value; }
function children(node, uri, local){ return node.children.filter(item => typeof item !== 'string' && item.uri === uri && item.local === local); }
function child(node, uri, local){ const found=children(node,uri,local);if(found.length>1)throw xerr();return found[0]; }
function textContent(node){return node.children.filter(item=>typeof item==='string').join('');}
function noUnexpectedText(node){if(node.children.some(item=>typeof item==='string'&&item.trim()!==''))throw xerr();}
function safeXml(bytes, limits, part) {
  const stack=[];let root=null;
  parseXmlEvents(bytes,{limits,part,onEvent(event){
    if(event.type==='open') {
      const node={uri:event.uri,local:event.local,attrs:event.attributes,children:[]};
      if(stack.length)stack.at(-1).children.push(node);else if(root)throw xerr();else root=node;
      stack.push(node);
    } else if(event.type==='text'||event.type==='cdata') { if(stack.length)stack.at(-1).children.push(event.value); }
    else { if(!stack.length)throw xerr();stack.pop(); }
  }});
  if(!root)throw xerr();
  const check=node=>{if(typeof node==='string')return;if(node.uri&&!NS.has(node.uri))throw xerr('unsupported_xlsx_feature');for(const item of node.children)check(item);};check(root);
  return root;
}
function validateAttrs(node, allowed) {
  for(const attr of node.attrs) if(attr.uri!==XMLNS&&!allowed.has(`${attr.uri}\0${attr.local}`)) throw xerr('unsupported_xlsx_feature');
}
function localBase(pathname){const name=path.posix.basename(pathname);return name;}
function resolveTarget(source,target){
  if(typeof target!=='string'||!target||target.includes('%')||target.includes('\\')||target.includes('\0')||target.includes('#')||target.includes('?')||target.startsWith('/')||target.split('/').some(segment=>segment==='')||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target))throw xerr('unsupported_xlsx_feature');
  const stack=source?path.posix.dirname(source).split('/').filter(Boolean):[];
  for(const segment of target.split('/')) { if(!segment||segment==='.')continue;if(segment==='..'){if(!stack.length)throw xerr('unsupported_xlsx_feature');stack.pop();}else stack.push(segment); }
  const result=stack.join('/');if(!result||result.startsWith('../'))throw xerr('unsupported_xlsx_feature');return result;
}
function validateEntryName(name){
  if(typeof name!=='string'||!name||name.includes('\0')||name.includes('\\')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.includes('%')||name.split('/').some(s=>s===''||s==='.'||s==='..'))throw xerr();
  return name.normalize('NFC').toLowerCase();
}
function directoryEntry(entry){return entry.fileName.endsWith('/')||Boolean(entry.externalFileAttributes&0x10);}
function safeFileMode(entry){const creator=entry.versionMadeBy>>>8&255;const mode=entry.externalFileAttributes>>>16&0xffff;if(creator===3||creator===19){const type=mode&0o170000;if(type&&type!==0o100000&&type!==0o040000)throw xerr('unsupported_xlsx_feature');if(type===0o040000&&!directoryEntry(entry))throw xerr();}}
function nextEntry(zip){return new Promise((resolve,reject)=>{const clean=()=>{zip.removeListener('entry',onEntry);zip.removeListener('end',onEnd);zip.removeListener('error',onError);};const onEntry=e=>{clean();resolve(e);};const onEnd=()=>{clean();resolve(null);};const onError=e=>{clean();reject(e);};zip.once('entry',onEntry);zip.once('end',onEnd);zip.once('error',onError);try{zip.readEntry();}catch(e){clean();reject(e);}});}
async function readEntry(zip,entry,ownedDir,index,limits,total,assetPath){
  const dir=directoryEntry(entry);safeFileMode(entry);
  const alias=validateEntryName(dir?entry.fileName.slice(0,-1):entry.fileName);
  const flags=entry.generalPurposeBitFlag;
  const allowedFlags=0x808|(entry.compressionMethod===8?0x6:0);
  if((flags&0x41)!==0||(flags&~allowedFlags)!==0||![0,8].includes(entry.compressionMethod))throw xerr('unsupported_xlsx_feature');
  const local=await zip.readLocalFileHeaderPromise(entry);
  if(!local.fileName.equals(entry.fileNameRaw)||local.generalPurposeBitFlag!==flags||local.compressionMethod!==entry.compressionMethod)throw xerr();
  if(!(flags&8)&&(local.crc32!==entry.crc32||local.compressedSize!==entry.compressedSize||local.uncompressedSize!==entry.uncompressedSize))throw xerr();
  if(flags&8){
    const placeholders=(actual,expected)=>actual===0||actual===expected||actual===0xffffffff;
    if(!placeholders(local.crc32,entry.crc32)||!placeholders(local.compressedSize,entry.compressedSize)||!placeholders(local.uncompressedSize,entry.uncompressedSize))throw xerr();
  }
  const dataEnd=local.fileDataStart+entry.compressedSize;
  if(!Number.isSafeInteger(dataEnd)||dataEnd>zip.fileSize)throw xerr();
  if(dir&&(entry.compressedSize!==0||entry.uncompressedSize!==0||entry.crc32!==0))throw xerr();
  if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0)throw xerr();
  let actual=0,crc=0;const chunks=[];let out=null;
  if(!dir)out=await fs.open(path.join(ownedDir,`part-${String(index).padStart(4,'0')}`),'wx',0o600);
  const input=await zip.openReadStreamPromise(entry);
  try {
    for await(const chunk of input){actual+=chunk.length;total.actual+=chunk.length;if(actual!==0&&total.actual>limits.actual_unzip_bytes)throw xerr('xlsx_limit_exceeded');if(actual>entry.uncompressedSize)throw xerr();crc=crc32.unsigned(chunk,crc);chunks.push(chunk);if(out)await out.writeFile(chunk);}
    if(actual!==entry.uncompressedSize||crc!==(entry.crc32>>>0))throw xerr();
  } finally {input.destroy();if(out)await out.close();}
  let recordEnd=dataEnd;
  if(flags&8){
    const descriptor=Buffer.alloc(16);const handle=await fs.open(assetPath,'r');let read;
    try{read=await handle.read(descriptor,0,16,dataEnd);}finally{await handle.close();}
    if(read.bytesRead<12)throw xerr();const signed=descriptor.readUInt32LE(0)===0x08074b50;const offset=signed?4:0;
    if(read.bytesRead<offset+12||descriptor.readUInt32LE(offset)!==(entry.crc32>>>0)||descriptor.readUInt32LE(offset+4)!==entry.compressedSize||descriptor.readUInt32LE(offset+8)!==entry.uncompressedSize)throw xerr();
    recordEnd=dataEnd+offset+12;
  }
  if(recordEnd>zip.centralDirectoryOffset)throw xerr();
  const name=entry.fileName;
  const bytes=Buffer.concat(chunks,actual);
  return {name,dir,alias,bytes,sha256:hash(bytes),interval:[entry.relativeOffsetOfLocalHeader,recordEnd]};
}
function validateContentTypes(tree, entries){
  if(tree.uri!==CT||tree.local!=='Types')throw xerr();validateAttrs(tree,new Set());
  const defaults=new Map(),overrides=new Map();
  for(const node of tree.children.filter(x=>typeof x!=='string')){
    if(node.uri!==CT)throw xerr('unsupported_xlsx_feature');noUnexpectedText(node);
    if(node.local==='Default'){
      validateAttrs(node,new Set(['\0Extension','\0ContentType']));const ext=getAttr(node,'Extension'),type=getAttr(node,'ContentType');if(!ext||!type||defaults.has(ext.toLowerCase()))throw xerr();defaults.set(ext.toLowerCase(),type);
    } else if(node.local==='Override'){
      validateAttrs(node,new Set(['\0PartName','\0ContentType']));const part=getAttr(node,'PartName'),type=getAttr(node,'ContentType');if(!part?.startsWith('/')||part.startsWith('//')||!type)throw xerr();const canonical=part.slice(1);if(overrides.has(canonical))throw xerr();overrides.set(canonical,type);
    } else throw xerr('unsupported_xlsx_feature');
  }
  for(const [ext,type] of defaults){if(ext==='xml'&&type==='application/xml'||ext==='rels'&&type==='application/vnd.openxmlformats-package.relationships+xml')continue;if(!frozenDefaults.has(`${ext}\0${type}`))throw xerr('unsupported_xlsx_feature');}
  if(!defaults.has('xml')||!defaults.has('rels'))throw xerr();
  const effective=new Map();
  for(const entry of entries.values()){
    if(entry.dir)continue;
    const extension=entry.name.endsWith('.rels')?'rels':path.posix.extname(entry.name).slice(1).toLowerCase();
    const type=overrides.get(entry.name)??defaults.get(extension);
    if(!type)throw xerr('unsupported_xlsx_feature');effective.set(entry.name,type);
    const expected=entry.name.endsWith('.rels')?'application/vnd.openxmlformats-package.relationships+xml':null;
    if(expected&&type!==expected)throw xerr('unsupported_xlsx_feature');
    if(entry.name==='[Content_Types].xml')continue;
    const allowed=new Set([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
      'application/vnd.openxmlformats-officedocument.theme+xml',
      'application/vnd.openxmlformats-package.core-properties+xml',
      'application/vnd.openxmlformats-officedocument.extended-properties+xml',
      'application/vnd.openxmlformats-officedocument.custom-properties+xml',
      'application/vnd.openxmlformats-package.relationships+xml',
    ]);
    if(entry.name==='[Content_Types].xml') { if(type!=='application/xml')throw xerr(); continue; }
    if(!allowed.has(type))throw xerr('unsupported_xlsx_feature');
    if(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml','application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml','application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'].includes(type)&&!entry.name.startsWith('xl/'))throw xerr();
    if(type==='application/vnd.openxmlformats-officedocument.theme+xml'&&!entry.name.startsWith('xl/theme/'))throw xerr();
    if(type==='application/vnd.openxmlformats-package.core-properties+xml'&&entry.name!=='docProps/core.xml')throw xerr();
    if(type==='application/vnd.openxmlformats-officedocument.extended-properties+xml'&&entry.name!=='docProps/app.xml')throw xerr();
    if(type==='application/vnd.openxmlformats-officedocument.custom-properties+xml'&&entry.name!=='docProps/custom.xml')throw xerr();
    if(type==='application/vnd.openxmlformats-package.relationships+xml'&&!entry.name.endsWith('.rels'))throw xerr();
  }
  for(const [part,type] of overrides){if(!entries.has(part)||effective.get(part)!==type)throw xerr('unsupported_xlsx_feature');}
  for(const [ext,type] of defaults){if(frozenDefaults.has(`${ext}\0${type}`)){if([...entries.keys()].some(name=>path.posix.extname(name).slice(1).toLowerCase()===ext))throw xerr('unsupported_xlsx_feature');if([...overrides.keys()].some(name=>path.posix.extname(name).slice(1).toLowerCase()===ext))throw xerr('unsupported_xlsx_feature');}}
  return effective;
}
function parseRels(tree, source, entries){
  if(tree.uri!==PKG||tree.local!=='Relationships')throw xerr();validateAttrs(tree,new Set());const rels=new Map();
  for(const node of tree.children.filter(x=>typeof x!=='string')){
    if(node.uri!==PKG||node.local!=='Relationship')throw xerr('unsupported_xlsx_feature');noUnexpectedText(node);validateAttrs(node,new Set(['\0Id','\0Type','\0Target','\0TargetMode']));
    const id=getAttr(node,'Id'),type=getAttr(node,'Type'),target=getAttr(node,'Target'),mode=getAttr(node,'TargetMode')??'Internal';
    if(!id||rels.has(id)||!Object.values(Object.fromEntries(relTypes)).includes(type)||mode!=='Internal')throw xerr('unsupported_xlsx_feature');
    const name=resolveTarget(source,target);if(!entries.has(name))throw xerr();rels.set(id,{id,type,target:name});
  }
  return rels;
}
function validateExtensionGrammar(root, part){
  const walk=node=>{
    if(typeof node==='string')return;
    if(node.uri===EXC||node.uri===AC)throw xerr('unsupported_xlsx_feature');
    if(node.uri===LO&&!(part==='xl/workbook.xml'&&node.local==='extCalcPr'))throw xerr('unsupported_xlsx_feature');
    if(node.uri===MAIN&&['externalReference','externalReferences','definedNames','oleObject','control','tablePart','pivotTablePart','pivotCache','queryTable','dataModel','embeddedObject','drawing','legacyDrawing'].includes(node.local))throw xerr('unsupported_xlsx_feature');
    if(node.uri==='http://www.w3.org/2001/XMLSchema-instance')return;
    if(node.uri&&![MAIN,THEME,CT,PKG,OFFICE,XML,CP,DC,DCT,XSI,EP,CUST,VT,LO].includes(node.uri))throw xerr('unsupported_xlsx_feature');
    for(const childNode of node.children)walk(childNode);
  };
  walk(root);
  if(part==='xl/workbook.xml'){
    const extLists=[],extensionElements=[],loElements=[];const find=(node)=>{if(typeof node==='string')return;if(node.uri===MAIN&&node.local==='extLst')extLists.push(node);if(node.uri===MAIN&&node.local==='ext')extensionElements.push(node);if(node.uri===LO)loElements.push(node);for(const c of node.children)find(c);};find(root);
    if(extLists.length>1)throw xerr('unsupported_xlsx_feature');
    if(extLists.length){
      if(root.uri!==MAIN||root.local!=='workbook'||extLists[0]!==root.children.find(c=>typeof c!=='string'&&c.uri===MAIN&&c.local==='extLst'))throw xerr('unsupported_xlsx_feature');
      const list=extLists[0];validateAttrs(list,new Set());noUnexpectedText(list);const es=list.children.filter(c=>typeof c!=='string');if(es.length!==1||es[0].uri!==MAIN||es[0].local!=='ext')throw xerr('unsupported_xlsx_feature');
      const ext=es[0];validateAttrs(ext,new Set(['\0uri']));if(getAttr(ext,'uri')!=='{7626C862-2A13-11E5-B345-FEFF819CDC9F}')throw xerr('unsupported_xlsx_feature');noUnexpectedText(ext);const exts=ext.children.filter(c=>typeof c!=='string');if(exts.length!==1||exts[0].uri!==LO||exts[0].local!=='extCalcPr')throw xerr('unsupported_xlsx_feature');
      const calc=exts[0];validateAttrs(calc,new Set(['\0stringRefSyntax']));if(getAttr(calc,'stringRefSyntax')!=='CalcA1ExcelA1'||calc.children.some(c=>typeof c!=='string'||c.trim()!==''))throw xerr('unsupported_xlsx_feature');
      if(extensionElements.length!==1||extensionElements[0]!==ext||loElements.length!==1||loElements[0]!==calc)throw xerr('unsupported_xlsx_feature');
    } else if(extensionElements.length||loElements.length)throw xerr('unsupported_xlsx_feature');
  } else {
    const hasExtension=node=>typeof node!=='string'&&(node.uri===MAIN&&(node.local==='extLst'||node.local==='ext')||node.children.some(hasExtension));
    if(hasExtension(root))throw xerr('unsupported_xlsx_feature');
  }
  // Task1-frozen harmless AC attributes are deliberately narrow.
  const attrs=(node)=>{if(typeof node==='string')return;for(const a of node.attrs){if(a.uri===XMLNS)continue;if(a.uri===EXC&&a.local==='Ignorable')continue;if(a.uri===AC&&((a.local==='dyDescent'&&(node.local==='row'||node.local==='sheetFormatPr'))||(a.local==='knownFonts'&&node.local==='fonts')))continue;if(a.uri&&!NS.has(a.uri))throw xerr('unsupported_xlsx_feature');}for(const c of node.children)attrs(c);};attrs(root);
}
function colNumber(ref){const m=/^([A-Z]{1,3})([1-9][0-9]*)$/.exec(ref??'');if(!m)return null;let n=0;for(const c of m[1])n=n*26+c.charCodeAt(0)-64;return {column:n,row:Number(m[2])};}
function sheetInfo(root,{sharedStringCount,sharedValues,styleCount}){
  if(root.uri!==MAIN||root.local!=='worksheet')throw xerr('unsupported_xlsx_feature');
  const rows=children(root,MAIN,'row');let cells=0,minRow=null,maxRow=null,minCol=null,maxCol=null;const coordinates=new Set();
  for(const row of rows){const rr=getAttr(row,'r');if(!/^[1-9][0-9]*$/.test(rr??''))throw xerr();const rowNum=Number(rr);if(rowNum>1048576)throw xerr();
    for(const cell of children(row,MAIN,'c')){const ref=getAttr(cell,'r'),parsed=colNumber(ref);if(!parsed||parsed.row!==rowNum||parsed.column>16384||coordinates.has(ref))throw xerr();coordinates.add(ref);
      if(children(cell,MAIN,'f').length)throw xerr('xlsx_formula_rejected');if(children(cell,MAIN,'is').length>1||children(cell,MAIN,'v').length>1)throw xerr();if(getAttr(cell,'t')==='e')throw xerr('xlsx_cell_error');
      const kind=getAttr(cell,'t')??'n';if(!['n','s','inlineStr','str','b','e'].includes(kind))throw xerr('unsupported_xlsx_feature');
      const style=getAttr(cell,'s');if(style!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(style)||Number(style)>=styleCount))throw xerr();
      const v=child(cell,MAIN,'v'),is=child(cell,MAIN,'is');
      if(kind==='s'&&(!v||! /^(0|[1-9][0-9]*)$/.test(textContent(v))||!Number.isSafeInteger(Number(textContent(v)))||Number(textContent(v))>=sharedStringCount))throw xerr();
      if(kind==='inlineStr'&&!is)throw xerr();
      if(kind!=='inlineStr'&&is)throw xerr();
      const stored=kind==='s'?sharedValues[Number(textContent(v))]??'':v?textContent(v):is?descendants(is,MAIN,'t').map(textContent).join(''):'';
      if(kind==='b'&&v&&!['0','1'].includes(textContent(v)))throw xerr();
      if(Buffer.byteLength(stored,'utf8')>XLSX_LIMITS.cell_bytes)throw xerr('xlsx_limit_exceeded');
      const nonempty=stored!=='';
      if(nonempty){cells++;if(cells>1000000)throw xerr('xlsx_limit_exceeded');minRow=minRow===null?rowNum:Math.min(minRow,rowNum);maxRow=maxRow===null?rowNum:Math.max(maxRow,rowNum);minCol=minCol===null?parsed.column:Math.min(minCol,parsed.column);maxCol=maxCol===null?parsed.column:Math.max(maxCol,parsed.column);}
    }
  }
  return {value_cells:cells,min_row:minRow,max_row:maxRow,min_column:minCol,max_column:maxCol};
}
function parseXmlParts(entries,effective,limits){
  const trees=new Map();for(const item of entries.values()){
    if(item.dir||!item.name.endsWith('.xml')&&!item.name.endsWith('.rels'))continue;
    if(item.bytes.byteLength>limits.xml_bytes)throw xerr('xlsx_limit_exceeded');
    const tree=safeXml(item.bytes,limits,item.name);validateExtensionGrammar(tree,item.name);
    if(item.name==='[Content_Types].xml')continue;
    const type=effective.get(item.name);
    const roots={
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml':[MAIN,'workbook'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml':[MAIN,'worksheet'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml':[MAIN,'chartsheet'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml':[MAIN,'sst'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml':[MAIN,'styleSheet'],
      'application/vnd.openxmlformats-officedocument.theme+xml':[THEME,'theme'],
      'application/vnd.openxmlformats-package.core-properties+xml':[CP,'coreProperties'],
      'application/vnd.openxmlformats-officedocument.extended-properties+xml':[EP,'Properties'],
      'application/vnd.openxmlformats-officedocument.custom-properties+xml':[CUST,'Properties'],
      'application/vnd.openxmlformats-package.relationships+xml':[PKG,'Relationships'],
    };
    const expected=roots[type];if(!expected||tree.uri!==expected[0]||tree.local!==expected[1])throw xerr('unsupported_xlsx_feature');
    const scan=node=>{if(typeof node==='string')return;if(node.uri===MAIN&&node.local==='f')throw xerr('xlsx_formula_rejected');for(const childNode of node.children)scan(childNode);};scan(tree);
    trees.set(item.name,tree);
  }
  return trees;
}
function workbookCellLimits(trees){
  const shared=trees.get('xl/sharedStrings.xml');let sharedStringCount=0,sharedBytes=0;const sharedValues=[];
  if(shared){const items=children(shared,MAIN,'si');if(items.length>1000000)throw xerr('xlsx_limit_exceeded');sharedStringCount=items.length;for(const si of items){const value=descendants(si,MAIN,'t').map(textContent).join('');sharedValues.push(value);sharedBytes+=Buffer.byteLength(value,'utf8');if(sharedBytes>XLSX_LIMITS.actual_unzip_bytes)throw xerr('xlsx_limit_exceeded');}}
  let styleCount=1;const styles=trees.get('xl/styles.xml');if(styles){const xfs=child(styles,MAIN,'cellXfs');if(!xfs)throw xerr();styleCount=children(xfs,MAIN,'xf').length;if(styleCount<1)throw xerr();}
  return {sharedStringCount,sharedValues,styleCount};
}
function descendants(root,uri,local){const result=[];const visit=node=>{if(typeof node==='string')return;if(node.uri===uri&&node.local===local)result.push(node);for(const childNode of node.children)visit(childNode);};visit(root);return result;}
function validateRelations(entries,trees,effective){
  const all=new Map();
  for(const name of entries.keys())if(name.endsWith('.rels')){const source=name==='_rels/.rels'?'':name.replace(/\/_rels\/([^/]+)\.rels$/,'/$1').replace(/^_rels\/([^/]+)\.rels$/,'$1');if(source&&!entries.has(source))throw xerr();all.set(source,parseRels(trees.get(name),source,entries));}
  if(!all.has(''))throw xerr();const root=all.get('');const office=[...root.values()].filter(r=>r.type===relTypes.get('officeDocument'));if(office.length!==1||office[0].target!=='xl/workbook.xml')throw xerr();
  for(const [source,rels] of all)for(const rel of rels.values()){
    if(rel.type===relTypes.get('hyperlink'))continue;
    if(rel.type===relTypes.get('officeDocument'))continue;
    const type=effective.get(rel.target);
    const expected=rel.type===relTypes.get('worksheet')?'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml':rel.type===relTypes.get('chartsheet')?'application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml':rel.type===relTypes.get('sharedStrings')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml':rel.type===relTypes.get('styles')?'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml':rel.type===relTypes.get('theme')?'application/vnd.openxmlformats-officedocument.theme+xml':rel.type===relTypes.get('core-properties')?'application/vnd.openxmlformats-package.core-properties+xml':rel.type===relTypes.get('extended-properties')?'application/vnd.openxmlformats-officedocument.extended-properties+xml':rel.type===relTypes.get('custom-properties')?'application/vnd.openxmlformats-officedocument.custom-properties+xml':null;
    if(!expected||type!==expected)throw xerr('unsupported_xlsx_feature');
  }
  return all;
}
function workbookSheets(root, rels, sourceHash, trees, effective, cellLimits){
  if(root.uri!==MAIN||root.local!=='workbook')throw xerr('unsupported_xlsx_feature');
  const props=child(root,MAIN,'workbookPr');const date_system=props&&['1','true'].includes((getAttr(props,'date1904')??'false').toLowerCase())?'1904':'1900';
  const list=child(root,MAIN,'sheets');if(!list)throw xerr();const sheets=[];const ids=new Set(),rids=new Set();let totalCells=0;
  for(const node of children(list,MAIN,'sheet')){
    const name=getAttr(node,'name'),id=getAttr(node,'sheetId'),rid=getAttr(node,'id',OFFICE);if(typeof name!=='string'||!name||[...name].length>31||! /^[1-9][0-9]*$/.test(id??'')||!rid||ids.has(id)||rids.has(rid))throw xerr();ids.add(id);rids.add(rid);
    const state=getAttr(node,'state')??'visible';if(!['visible','hidden','veryHidden'].includes(state))throw xerr();const relation=rels.get(rid);if(!relation)throw xerr();
    const kind=relation.type===relTypes.get('worksheet')?'worksheet':relation.type===relTypes.get('chartsheet')?'other':null;if(!kind)throw xerr('unsupported_xlsx_feature');
    const ct=effective.get(relation.target);if(ct!==(kind==='worksheet'?'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml':'application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml'))throw xerr();
    const tree=trees.get(relation.target);if(!tree)throw xerr();let info={value_cells:0,min_row:null,max_row:null,min_column:null,max_column:null};if(kind==='worksheet'){info=sheetInfo(tree,cellLimits);totalCells+=info.value_cells;if(totalCells>1000000)throw xerr('xlsx_limit_exceeded');}
    if(sheets.length>=2048)throw xerr('xlsx_limit_exceeded');sheets.push({sheet_id:`${sourceHash}:${id}`,name,state,kind,selectable:kind==='worksheet'&&state==='visible',...info,relationship_id:rid,part:relation.target});
  }
  if(!sheets.length)throw xerr();return {date_system,sheets};
}

export async function inspectXlsxPackage({assetPath,stagingPath,limits=XLSX_LIMITS,signal}={}) {
  const ceilings={...XLSX_LIMITS};
  if(!limits||Object.keys(limits).length!==Object.keys(ceilings).length||Object.keys(ceilings).some(key=>!Object.hasOwn(limits,key)||!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>XLSX_LIMITS[key]))throw xerr('invalid_xlsx');
  if(signal?.aborted)throw signal.reason??xerr();
  const stat=await fs.lstat(assetPath).catch(()=>null);if(!stat?.isFile()||stat.isSymbolicLink())throw xerr();if(stat.size>limits.compressed_bytes)throw xerr('xlsx_limit_exceeded');
  const dirStat=await fs.lstat(stagingPath).catch(()=>null);if(!dirStat?.isDirectory()||dirStat.isSymbolicLink())throw xerr();
  const ownedDir=await fs.mkdtemp(path.join(stagingPath,'xlsx-owned-'));let zip;const entries=new Map(),aliases=new Set(),intervals=[];let count=0,total={actual:0};
  try {
    const sourceSha=await hashFile(assetPath);
    zip=await openPromise(assetPath,{lazyEntries:true,autoClose:false,validateEntrySizes:true,strictFileNames:true});
    for(let entry=await nextEntry(zip);entry;entry=await nextEntry(zip)){
      if(signal?.aborted)throw signal.reason??xerr();count++;if(count>limits.entries)throw xerr('xlsx_limit_exceeded');
      const item=await readEntry(zip,entry,ownedDir,count,limits,total,assetPath);if(entry.extraFields.some(field=>field.id===0x7075)||entries.has(item.name)||aliases.has(item.alias))throw xerr();aliases.add(item.alias);if(!item.dir)entries.set(item.name,item);else entries.set(item.name,item);intervals.push(item.interval);
    }
    intervals.sort((a,b)=>a[0]-b[0]);for(let i=1;i<intervals.length;i++)if(intervals[i][0]<intervals[i-1][1])throw xerr();
    if(!entries.has('[Content_Types].xml')||!entries.has('_rels/.rels'))throw xerr();
    const limitsXml={xml_bytes:limits.xml_bytes,xml_depth:limits.xml_depth};
    const ctTree=safeXml(entries.get('[Content_Types].xml').bytes,limitsXml,'[Content_Types].xml');
    const effective=validateContentTypes(ctTree,entries);const trees=parseXmlParts(entries,effective,limitsXml);
    const relations=validateRelations(entries,trees,effective);const workbook=entries.get('xl/workbook.xml');if(!workbook)throw xerr();
    const finalStat=await fs.lstat(assetPath);if(finalStat.size!==stat.size||finalStat.ino!==stat.ino||await hashFile(assetPath)!==sourceSha)throw xerr('xlsx_source_mismatch');
    const cellLimits=workbookCellLimits(trees);
    const parsed=workbookSheets(trees.get('xl/workbook.xml'),relations.get('xl/workbook.xml'),sourceSha,trees,effective,cellLimits);
    const parts=new Map();for(const item of entries.values())if(!item.dir){parts.set(item.name,{path:`part-${String([...entries.keys()].indexOf(item.name)+1).padStart(4,'0')}`,bytes:item.bytes,sha256:item.sha256,content_type:effective.get(item.name)});}
    const inventory={source:{bytes:stat.size,sha256:sourceSha},date_system:parsed.date_system,sheets:parsed.sheets,parts};
    ownedDirectories.set(inventory,ownedDir);return inventory;
  } catch(error){await fs.rm(ownedDir,{recursive:true,force:true}).catch(()=>{});if(signal?.aborted)throw signal.reason??xerr();if(['invalid_xlsx','unsupported_xlsx_feature','xlsx_limit_exceeded','xlsx_source_mismatch','xlsx_formula_rejected','xlsx_cell_error','xlsx_value_mode_mismatch','xlsx_date_rejected','xlsx_numeric_limit','xlsx_conversion_mismatch'].includes(error?.code))throw error;throw xerr();}
  finally {zip?.close();}
}

export async function disposeXlsxPackage(inventory){const dir=ownedDirectories.get(inventory);if(!dir)return;ownedDirectories.delete(inventory);await fs.rm(dir,{recursive:true,force:true});}
