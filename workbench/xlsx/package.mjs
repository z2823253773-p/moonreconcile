import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import crc32 from 'buffer-crc32';
import { parseXmlEvents } from './xml.mjs';
import { XLSX_LIMITS, OOXML_TYPES, OOXML_RELATIONSHIPS, OOXML_DRAWING } from './contracts.mjs';
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
const D = OOXML_DRAWING;
const relTypes = new Map(Object.entries(OOXML_RELATIONSHIPS));
const TYPES = OOXML_TYPES;
const XML_WS = /^[\x20\x09\x0D\x0A]*$/;
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
function noUnexpectedText(node){if(node.children.some(item=>typeof item==='string'&&!XML_WS.test(item)))throw xerr();}
function safeXml(bytes, limits, part, strict = false) {
  const stack=[];let root=null;
  parseXmlEvents(bytes,{limits,part,rejectCommentsAndProcessingInstructions:strict,onEvent(event){
    if(event.type==='open') {
      const node={uri:event.uri,local:event.local,attrs:event.attributes,children:[]};
      if(stack.length)stack.at(-1).children.push(node);else if(root)throw xerr();else root=node;
      stack.push(node);
    } else if(event.type==='text'||event.type==='cdata') { if(stack.length)stack.at(-1).children.push(event.value); }
    else { if(!stack.length)throw xerr();stack.pop(); }
  }});
  if(!root)throw xerr();
  return root;
}
function validateAttrs(node, allowed) {
  for(const attr of node.attrs) if(attr.uri!==XMLNS&&!allowed.has(`${attr.uri}\0${attr.local}`)) throw xerr('unsupported_xlsx_feature');
}
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
async function closeZip(zip){
  if(!zip)return;
  await new Promise((resolve,reject)=>{
    const clean=()=>{zip.removeListener('close',onClose);zip.removeListener('error',onError);};
    const onClose=()=>{clean();resolve();};const onError=()=>{clean();reject(xerr());};
    zip.once('close',onClose);zip.once('error',onError);
    try{zip.close();}catch{clean();reject(xerr());}
  });
}
async function readEntry(zip,entry,ownedDir,index,limits,total,assetPath,signal){
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
  const ownedPath=path.join(ownedDir,`part-${String(index).padStart(4,'0')}`);
  let input;const aborted=()=>{if(signal?.aborted)throw signal.reason??xerr();};
  const onAbort=()=>input?.destroy(signal.reason??xerr());
  try {
    aborted();if(!dir)out=await fs.open(ownedPath,'wx',0o600);
    aborted();input=await zip.openReadStreamPromise(entry);
    signal?.addEventListener('abort',onAbort,{once:true});aborted();
    for await(const chunk of input){aborted();actual+=chunk.length;total.actual+=chunk.length;if(actual!==0&&total.actual>limits.actual_unzip_bytes)throw xerr('xlsx_limit_exceeded');if(actual>entry.uncompressedSize)throw xerr();crc=crc32.unsigned(chunk,crc);chunks.push(chunk);if(out)await out.writeFile(chunk);}
    aborted();if(actual!==entry.uncompressedSize||crc!==(entry.crc32>>>0))throw xerr();
  } finally {signal?.removeEventListener('abort',onAbort);input?.destroy();if(out)await out.close();}
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
  return {name,dir,alias,bytes,ownedPath,sha256:hash(bytes),interval:[entry.relativeOffsetOfLocalHeader,recordEnd]};
}

function elements(node) { return node.children.filter(c => typeof c !== 'string'); }
function leaf(node, code='unsupported_xlsx_feature') {
  if(elements(node).length) throw xerr(code);
  if(!XML_WS.test(textContent(node))) throw xerr(code);
}
function attrs(node, names=[], required=[], special=true) {
  const allowed = new Set(names.map(name => name.includes('\0') ? name : `\0${name}`));
  if(special) {
    allowed.add(`${EXC}\0Ignorable`);
    if(node.uri===MAIN&&['row','sheetFormatPr'].includes(node.local))allowed.add(`${AC}\0dyDescent`);
    if(node.uri===MAIN&&node.local==='fonts')allowed.add(`${AC}\0knownFonts`);
  }
  validateAttrs(node,allowed);
  for(const key of required) { const [uri,local]=key.includes('\0')?key.split('\0'):['',key];if(getAttr(node,local,uri)===undefined)throw xerr(); }
}
function numericAttribute(node,name,{min=0,max=Number.MAX_SAFE_INTEGER}={}) {
  const v=getAttr(node,name);if(v===undefined)return;
  if(!/^(0|[1-9][0-9]*)$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)<min||Number(v)>max)throw xerr();
}
function validateContentTypes(tree,entries){
  if(tree.uri!==CT||tree.local!=='Types')throw xerr();attrs(tree,[],[],false);noUnexpectedText(tree);
  const defaults=new Map(),overrides=new Map(),overrideAliases=new Set();
  for(const node of elements(tree)){
    if(node.uri!==CT||!['Default','Override'].includes(node.local))throw xerr('unsupported_xlsx_feature');
    leaf(node);attrs(node,node.local==='Default'?['Extension','ContentType']:['PartName','ContentType'],node.local==='Default'?['Extension','ContentType']:['PartName','ContentType'],false);
    const type=getAttr(node,'ContentType');if(!type)throw xerr();
    if(node.local==='Default'){
      const ext=getAttr(node,'Extension');if(!/^[A-Za-z0-9]+$/.test(ext??'')||defaults.has(ext.toLowerCase()))throw xerr();defaults.set(ext.toLowerCase(),type);
    }else{
      const part=getAttr(node,'PartName');if(!part?.startsWith('/')||part.startsWith('//'))throw xerr();
      const canonical=part.slice(1),alias=validateEntryName(canonical);if(overrides.has(canonical)||overrideAliases.has(alias))throw xerr();overrides.set(canonical,type);overrideAliases.add(alias);
    }
  }
  for(const [ext,type]of defaults)if(defaultContent.get(ext)!==type&&!frozenDefaults.has(`${ext}\0${type}`))throw xerr('unsupported_xlsx_feature');
  for(const [ext,type]of defaultContent)if(defaults.get(ext)!==type)throw xerr();
  const effective=new Map();const allowed=new Set(Object.values(TYPES));
  for(const entry of entries.values()){
    if(entry.dir)continue;
    const ext=entry.name.endsWith('.rels')?'rels':path.posix.extname(entry.name).slice(1).toLowerCase();
    const type=overrides.get(entry.name)??defaults.get(ext);
    if(entry.name==='[Content_Types].xml'){if(type!=='application/xml')throw xerr();effective.set(entry.name,type);continue;}
    if(!allowed.has(type))throw xerr('unsupported_xlsx_feature');
    if(ext==='rels'&&type!==TYPES.relationships||type===TYPES.relationships&&!entry.name.endsWith('.rels'))throw xerr('unsupported_xlsx_feature');
    // No producer/path guess selects content. Every effective XML type is parsed,
    // including unused parts and nonstandard extensions.
    effective.set(entry.name,type);
  }
  for(const [part,type]of overrides)if(!entries.has(part)||entries.get(part).dir||effective.get(part)!==type)throw xerr('unsupported_xlsx_feature');
  for(const [ext,type]of defaults)if(frozenDefaults.has(`${ext}\0${type}`)&&[...entries.keys()].some(name=>path.posix.extname(name).slice(1).toLowerCase()===ext))throw xerr('unsupported_xlsx_feature');
  return {effective,overrides};
}
function parseRels(tree,source,entries){
  if(tree.uri!==PKG||tree.local!=='Relationships')throw xerr();attrs(tree,[],[],false);noUnexpectedText(tree);
  const rels=new Map(),targets=new Set();
  for(const node of elements(tree)){
    if(node.uri!==PKG||node.local!=='Relationship')throw xerr('unsupported_xlsx_feature');
    leaf(node);attrs(node,['Id','Type','Target','TargetMode'],['Id','Type','Target'],false);
    const id=getAttr(node,'Id'),type=getAttr(node,'Type'),mode=getAttr(node,'TargetMode');
    if(!id||rels.has(id)||![...relTypes.values()].includes(type)||mode!==undefined&&mode!=='Internal')throw xerr('unsupported_xlsx_feature');
    if(type===relTypes.get('drawing')&&mode!==undefined)throw xerr('unsupported_xlsx_feature');
    const target=resolveTarget(source,getAttr(node,'Target'));if(!entries.has(target)||entries.get(target).dir)throw xerr();
    if(targets.has(target))throw xerr();targets.add(target);rels.set(id,{id,type,target});
  }
  return rels;
}

// A finite parent/expanded-name/attribute/cardinality grammar for inert v1 data.
// Text leaves are explicit. Namespace membership is never authorization.
const schemas=new Map();
function rule(uri,local,attributes,childrenSpec={},text=false,required=[]){schemas.set(`${uri}\0${local}`,{uri,local,attributes:attributes.split(' ').filter(Boolean),childrenSpec:Object.fromEntries(Object.entries(childrenSpec).map(([key,value])=>[key.startsWith(uri+'\0')?key.slice(uri.length+1):key,value])),text,required});}
const repeat=(min=0,max=Infinity)=>[min,max];
const main=(name,a='',c={},t=false,r=[])=>rule(MAIN,name,a,c,t,r);
main('workbook','',{fileVersion:repeat(0,1),workbookPr:repeat(0,1),workbookProtection:repeat(0,1),bookViews:repeat(0,1),sheets:repeat(1,1),calcPr:repeat(0,1),extLst:repeat(0,1),definedNames:repeat(0,1)});
main('fileVersion','appName lastEdited lowestEdited rupBuild');
main('workbookPr','date1904 backupFile showObjects defaultThemeVersion codeName filterPrivacy saveExternalLinkValues updateLinks');
main('workbookProtection','lockStructure lockWindows lockRevision workbookPassword revisionsPassword');
main('bookViews','',{workbookView:repeat(1)});
main('workbookView','activeTab firstSheet showHorizontalScroll showVerticalScroll showSheetTabs tabRatio windowHeight windowWidth xWindow yWindow visibility minimized autoFilterDateGrouping');
main('sheets','',{sheet:repeat(1,2048)});main('sheet',`name sheetId state ${OFFICE}\0id`,{},false,['name','sheetId',`${OFFICE}\0id`]);
main('definedNames','',{definedName:repeat(1,1)});main('definedName','name function hidden vbProcedure localSheetId',{},true,['name','function','hidden','vbProcedure','localSheetId']);
main('calcPr','calcId calcMode fullCalcOnLoad forceFullCalc calcCompleted calcOnSave concurrentCalc concurrentManualCount iterate iterateCount iterateDelta refMode');
main('extLst','',{ext:repeat(1,1)});main('ext','uri',{[`${LO}\0extCalcPr`]:repeat(1,1)},false,['uri']);
rule(LO,'extCalcPr','stringRefSyntax',{},false,['stringRefSyntax']);
main('worksheet','',{sheetPr:repeat(0,1),dimension:repeat(0,1),sheetViews:repeat(0,1),sheetFormatPr:repeat(0,1),cols:repeat(0,1),sheetData:repeat(1,1),sheetProtection:repeat(0,1),autoFilter:repeat(0,1),mergeCells:repeat(0,1),hyperlinks:repeat(0,1),printOptions:repeat(0,1),pageMargins:repeat(0,1),pageSetup:repeat(0,1),headerFooter:repeat(0,1),drawing:repeat(0,1)});
main('chartsheet','',{sheetPr:repeat(0,1),sheetViews:repeat(0,1),sheetProtection:repeat(0,1),pageMargins:repeat(0,1),pageSetup:repeat(0,1),headerFooter:repeat(0,1)});
main('sheetPr','filterMode codeName enableFormatConditionsCalculation published syncHorizontal syncVertical syncRef transitionEvaluation transitionEntry',{tabColor:repeat(0,1),outlinePr:repeat(0,1),pageSetUpPr:repeat(0,1)});
main('outlinePr','applyStyles summaryBelow summaryRight showOutlineSymbols');main('pageSetUpPr','autoPageBreaks fitToPage');main('dimension','ref',{},false,['ref']);
main('sheetViews','',{sheetView:repeat(1)});
main('sheetView','colorId defaultGridColor rightToLeft showFormulas showGridLines showOutlineSymbols showRowColHeaders showZeros tabSelected topLeftCell view workbookViewId zoomScale zoomScaleNormal zoomScalePageLayoutView zoomScaleSheetLayoutView windowProtection',{pane:repeat(0,1),selection:repeat(0,4)});
main('pane','xSplit ySplit topLeftCell activePane state');main('selection','activeCell activeCellId pane sqref');
main('sheetFormatPr','baseColWidth customHeight defaultColWidth defaultRowHeight outlineLevelCol outlineLevelRow zeroHeight thickTop thickBottom');
main('cols','',{col:repeat(1)});main('col','min max width style hidden bestFit customWidth phonetic outlineLevel collapsed',{},false,['min','max']);
main('sheetData','',{row:repeat()});main('row','r s spans ht customFormat customHeight hidden outlineLevel collapsed thickTop thickBot ph',{c:repeat()},false,['r']);
main('c','r s t cm vm ph',{v:repeat(0,1),is:repeat(0,1)},false,['r']);
main('v','',{},true);main('is','',{t:repeat(0,1),r:repeat(),rPh:repeat(),phoneticPr:repeat(0,1)});
main('sst','count uniqueCount',{si:repeat()});main('si','',{t:repeat(0,1),r:repeat(),rPh:repeat(),phoneticPr:repeat(0,1)});
main('t',`${XML}\0space`,{},true);main('r','',{rPr:repeat(0,1),t:repeat(1,1)});main('rPh','sb eb',{t:repeat(1,1)},false,['sb','eb']);main('phoneticPr','fontId type alignment');
const fontKids=Object.fromEntries(['b','i','strike','condense','extend','outline','shadow','u','vertAlign','sz','color','name','family','charset','scheme','rFont'].map(k=>[k,repeat(0,1)]));
main('rPr','',Object.fromEntries(Object.entries(fontKids).filter(([k])=>k!=='name')));main('font','',Object.fromEntries(Object.entries(fontKids).filter(([k])=>k!=='rFont')));
for(const n of ['b','i','strike','condense','extend','outline','shadow','u','vertAlign','sz','name','family','charset','scheme','rFont'])main(n,'val');
for(const n of ['color','fgColor','bgColor','tabColor'])main(n,'auto indexed rgb theme tint');
main('sheetProtection','sheet objects scenarios formatCells formatColumns formatRows insertColumns insertRows insertHyperlinks deleteColumns deleteRows selectLockedCells sort autoFilter pivotTables selectUnlockedCells password');
main('mergeCells','count',{mergeCell:repeat(1)});main('mergeCell','ref',{},false,['ref']);
main('autoFilter','ref',{},false,['ref']);main('drawing',`${OFFICE}\0id`,{},false,[`${OFFICE}\0id`]);
main('hyperlinks','',{hyperlink:repeat(1)});main('hyperlink',`ref location display tooltip ${OFFICE}\0id`,{},false,['ref']);
main('printOptions','gridLines gridLinesSet headings horizontalCentered verticalCentered');
main('pageMargins','bottom footer header left right top');
main('pageSetup','blackAndWhite cellComments copies draft firstPageNumber fitToHeight fitToWidth horizontalDpi orientation pageOrder paperSize scale useFirstPageNumber verticalDpi usePrinterDefaults errors');
main('headerFooter','differentFirst differentOddEven alignWithMargins scaleWithDoc',Object.fromEntries(['oddFooter','oddHeader','evenFooter','evenHeader','firstFooter','firstHeader'].map(n=>[n,repeat(0,1)])));
for(const n of ['oddFooter','oddHeader','evenFooter','evenHeader','firstFooter','firstHeader'])main(n,'',{},true);
main('styleSheet','',Object.fromEntries(['numFmts','fonts','fills','borders','cellStyleXfs','cellXfs','cellStyles','dxfs','tableStyles','colors'].map(n=>[n,repeat(0,1)])));
for(const [container,item]of [['numFmts','numFmt'],['fonts','font'],['fills','fill'],['borders','border'],['cellStyleXfs','xf'],['cellXfs','xf'],['cellStyles','cellStyle'],['dxfs','dxf']])main(container,'count',{[item]:repeat()});
main('numFmt','numFmtId formatCode',{},false,['numFmtId','formatCode']);main('fill','',{patternFill:repeat(0,1),gradientFill:repeat(0,1)});main('patternFill','patternType',{fgColor:repeat(0,1),bgColor:repeat(0,1)});main('gradientFill','type degree left right top bottom',{stop:repeat()});main('stop','position',{color:repeat(1,1)});
main('border','diagonalUp diagonalDown outline',Object.fromEntries(['left','right','top','bottom','diagonal','vertical','horizontal','start','end'].map(n=>[n,repeat(0,1)])));
for(const n of ['left','right','top','bottom','diagonal','vertical','horizontal','start','end'])main(n,'style',{color:repeat(0,1)});
main('xf','numFmtId fontId fillId borderId xfId applyNumberFormat applyFont applyFill applyBorder applyAlignment applyProtection pivotButton quotePrefix',{alignment:repeat(0,1),protection:repeat(0,1)});
main('alignment','horizontal vertical textRotation wrapText shrinkToFit indent relativeIndent justifyLastLine readingOrder');main('protection','locked hidden');main('cellStyle','name xfId builtinId iLevel hidden customBuiltin');
main('dxf','',{font:repeat(0,1),numFmt:repeat(0,1),fill:repeat(0,1),alignment:repeat(0,1),border:repeat(0,1),protection:repeat(0,1)});
main('tableStyles','count defaultTableStyle defaultPivotStyle');main('colors','',{indexedColors:repeat(0,1),mruColors:repeat(0,1)});main('indexedColors','',{rgbColor:repeat()});main('rgbColor','rgb');main('mruColors','',{color:repeat()});

const theme=(n,a='',c={})=>rule(THEME,n,a,c);
theme('theme','name',{themeElements:repeat(1,1)});theme('themeElements','',{clrScheme:repeat(1,1),fontScheme:repeat(1,1),fmtScheme:repeat(1,1)});
const colorNames=['dk1','lt1','dk2','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'];theme('clrScheme','name',Object.fromEntries(colorNames.map(n=>[n,repeat(1,1)])));
for(const n of colorNames)theme(n,'',{srgbClr:repeat(0,1),sysClr:repeat(0,1)});
for(const n of ['srgbClr','schemeClr'])theme(n,'val');theme('sysClr','val lastClr');
theme('fontScheme','name',{majorFont:repeat(1,1),minorFont:repeat(1,1)});
for(const n of ['majorFont','minorFont'])theme(n,'',{latin:repeat(1,1),ea:repeat(1,1),cs:repeat(1,1),font:repeat()});
for(const n of ['latin','ea','cs'])theme(n,'typeface panose pitchFamily charset');theme('font','script typeface');
theme('fmtScheme','name',{fillStyleLst:repeat(1,1),lnStyleLst:repeat(1,1),effectStyleLst:repeat(1,1),bgFillStyleLst:repeat(1,1)});
for(const n of ['fillStyleLst','bgFillStyleLst'])theme(n,'',{solidFill:repeat()});theme('solidFill','',{schemeClr:repeat(0,1),srgbClr:repeat(0,1)});
theme('lnStyleLst','',{ln:repeat()});theme('ln','algn cap cmpd w',{solidFill:repeat(0,1),prstDash:repeat(0,1),miter:repeat(0,1),round:repeat(0,1),bevel:repeat(0,1),headEnd:repeat(0,1),tailEnd:repeat(0,1)});theme('prstDash','val');theme('miter','lim');theme('round');theme('bevel');for(const n of ['headEnd','tailEnd'])theme(n,'type w len');
theme('effectStyleLst','',{effectStyle:repeat()});theme('effectStyle','',{effectLst:repeat(1,1)});theme('effectLst');
const coreNames=[...[...['title','subject','creator','description','identifier','language']].map(n=>`${DC}\0${n}`),...[...['created','modified']].map(n=>`${DCT}\0${n}`),...['category','contentStatus','keywords','lastModifiedBy','lastPrinted','revision','version'].map(n=>`${CP}\0${n}`)];
rule(CP,'coreProperties','',Object.fromEntries(coreNames.map(n=>[n,repeat(0,1)])));
for(const key of coreNames){const [uri,n]=key.split('\0');rule(uri,n,uri===DCT?`${XSI}\0type`:'',{},true);}
const epText=['Template','TotalTime','Application','AppVersion','Company','Manager','Pages','Words','Characters','CharactersWithSpaces','Lines','Paragraphs','DocSecurity','ScaleCrop','LinksUpToDate','SharedDoc','HyperlinksChanged'];
rule(EP,'Properties','',Object.fromEntries([...epText.map(n=>[n,repeat(0,1)]),['HeadingPairs',repeat(0,1)],['TitlesOfParts',repeat(0,1)]]));for(const n of epText)rule(EP,n,'',{},true);
rule(EP,'HeadingPairs','',{[`${VT}\0vector`]:repeat(1,1)});rule(EP,'TitlesOfParts','',{[`${VT}\0vector`]:repeat(1,1)});
rule(CUST,'Properties','',{property:repeat()});rule(CUST,'property','fmtid pid name',Object.fromEntries(['lpwstr','bstr','i4','r8','bool','filetime'].map(n=>[`${VT}\0${n}`,repeat(0,1)])),false,['fmtid','pid','name']);
rule(VT,'vector','size baseType',Object.fromEntries(['variant','lpstr','lpwstr','i4'].map(n=>[n,repeat()])));rule(VT,'variant','',Object.fromEntries(['lpstr','lpwstr','i4'].map(n=>[n,repeat(0,1)])));
for(const n of ['lpstr','lpwstr','bstr','i4','r8','bool','filetime'])rule(VT,n,'',{},true);
rule(D,'wsDr','');

function validateSchema(root){
  function walk(node,parent){
    const spec=schemas.get(`${node.uri}\0${node.local}`);if(!spec)throw xerr('unsupported_xlsx_feature');
    const exactNode=node.uri===D||node.uri===LO||node.uri===MAIN&&['autoFilter','drawing','extLst','ext','definedNames','definedName'].includes(node.local);
    attrs(node,spec.attributes,spec.required,!exactNode);
    if(!spec.text&&!XML_WS.test(textContent(node)))throw xerr('unsupported_xlsx_feature');
    const counts=new Map();
    for(const c of elements(node)){
      const key=c.uri===node.uri?c.local:`${c.uri}\0${c.local}`;
      if(!Object.hasOwn(spec.childrenSpec,key))throw xerr('unsupported_xlsx_feature');
      counts.set(key,(counts.get(key)??0)+1);walk(c,node);
    }
    for(const [key,[min,max]]of Object.entries(spec.childrenSpec))if((counts.get(key)??0)<min||(counts.get(key)??0)>max)throw xerr('unsupported_xlsx_feature');
    if(node.uri===THEME&&(colorNames.includes(node.local)||node.local==='solidFill')&&elements(node).length!==1)throw xerr();
    if(node.uri===MAIN){
      if(node.local==='fill'&&elements(node).length!==1)throw xerr();
      if(['numFmts','fonts','fills','borders','cellStyleXfs','cellXfs','cellStyles','dxfs','mergeCells'].includes(node.local)&&getAttr(node,'count')!==undefined&&Number(getAttr(node,'count'))!==elements(node).length)throw xerr();
      if(['si','is'].includes(node.local)&&children(node,MAIN,'t').length&&children(node,MAIN,'r').length)throw xerr();
      if(node.local==='t'){const space=getAttr(node,'space',XML);if(space!==undefined&&!['preserve','default'].includes(space))throw xerr();}
      if(node.local==='ext'&&getAttr(node,'uri')!=='{7626C862-2A13-11E5-B345-FEFF819CDC9F}')throw xerr('unsupported_xlsx_feature');
      if(['sst','numFmts','fonts','fills','borders','cellStyleXfs','cellXfs','cellStyles','dxfs','mergeCells','tableStyles'].includes(node.local))numericAttribute(node,'count');
      if(node.local==='sst')numericAttribute(node,'uniqueCount');
    }
    if(node.uri===LO&&(getAttr(node,'stringRefSyntax')!=='CalcA1ExcelA1'||parent?.uri!==MAIN||parent.local!=='ext'))throw xerr('unsupported_xlsx_feature');
    if(node.uri===CUST&&node.local==='property'&&elements(node).length!==1)throw xerr();
    if(node.uri===VT&&node.local==='variant'&&elements(node).length!==1)throw xerr();
  }
  walk(root,null);
}
function scanFormula(root){
  if(root.uri===MAIN&&root.local==='f')throw xerr('xlsx_formula_rejected');
  for(const node of elements(root))scanFormula(node);
}
function coordinate(ref){
  const m=/^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref??'');if(!m)throw xerr();
  let column=0;for(const ch of m[1])column=column*26+ch.charCodeAt(0)-64;
  const row=Number(m[2]);if(column>16384||row>1048576)throw xerr();return {row,column};
}
function rectangle(ref){
  const match=/^([A-Z]{1,3}[1-9][0-9]{0,6}):([A-Z]{1,3}[1-9][0-9]{0,6})$/.exec(ref??'');if(!match)throw xerr();
  const first=coordinate(match[1]),last=coordinate(match[2]);if(first.row>last.row||first.column>last.column)throw xerr();return {first,last};
}
function storedText(node){
  // rPh's t is annotation, never stored text. Validated rich runs are ordered.
  return elements(node).filter(c=>c.uri===MAIN&&['t','r'].includes(c.local)).map(c=>c.local==='t'?textContent(c):textContent(child(c,MAIN,'t'))).join('');
}
function worksheetInfo(root,cellLimits,limits,total){
  const data=child(root,MAIN,'sheetData');if(!data)throw xerr();
  const coords=new Set(),rows=new Set();let cells=0,minRow=null,maxRow=null,minCol=null,maxCol=null;
  for(const row of children(data,MAIN,'row')){
    numericAttribute(row,'r',{min:1,max:1048576});const rowNum=Number(getAttr(row,'r'));if(rows.has(rowNum))throw xerr();rows.add(rowNum);
    for(const c of children(row,MAIN,'c')){
      const ref=getAttr(c,'r'),pos=coordinate(ref);if(pos.row!==rowNum||coords.has(ref))throw xerr();coords.add(ref);
      const kind=getAttr(c,'t')??'n';if(kind==='e')throw xerr('xlsx_cell_error');if(!['n','s','inlineStr','str','b'].includes(kind))throw xerr('unsupported_xlsx_feature');
      const style=getAttr(c,'s');if(style!==undefined){numericAttribute(c,'s',{max:cellLimits.styleCount-1});}
      const v=child(c,MAIN,'v'),inline=child(c,MAIN,'is');if(kind==='inlineStr'&&(!inline||v)||kind!=='inlineStr'&&inline)throw xerr();
      let value=v?textContent(v):inline?storedText(inline):'';
      if(kind==='s'){
        if(!v||!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>=cellLimits.sharedValues.length)throw xerr();
        value=cellLimits.sharedValues[Number(value)];
      }
      if(kind==='b'&&v&&!['0','1'].includes(value))throw xerr();
      if(Buffer.byteLength(value,'utf8')>limits.cell_bytes)throw xerr('xlsx_limit_exceeded');
      if(value!==''){
        cells++;total.cells++;if(total.cells>1000000)throw xerr('xlsx_limit_exceeded');
        minRow=minRow===null?pos.row:Math.min(minRow,pos.row);maxRow=maxRow===null?pos.row:Math.max(maxRow,pos.row);minCol=minCol===null?pos.column:Math.min(minCol,pos.column);maxCol=maxCol===null?pos.column:Math.max(maxCol,pos.column);
      }
    }
  }
  for(const merge of children(child(root,MAIN,'mergeCells')??{children:[]},MAIN,'mergeCell'))rectangle(getAttr(merge,'ref'));
  const filter=child(root,MAIN,'autoFilter');if(filter)rectangle(getAttr(filter,'ref'));
  return {value_cells:cells,min_row:minRow,max_row:maxRow,min_column:minCol,max_column:maxCol};
}
function parseXmlParts(entries,effective,limits){
  const roots=new Map([[TYPES.workbook,[MAIN,'workbook']],[TYPES.worksheet,[MAIN,'worksheet']],[TYPES.chartsheet,[MAIN,'chartsheet']],[TYPES.sharedStrings,[MAIN,'sst']],[TYPES.styles,[MAIN,'styleSheet']],[TYPES.theme,[THEME,'theme']],[TYPES['core-properties'],[CP,'coreProperties']],[TYPES['extended-properties'],[EP,'Properties']],[TYPES['custom-properties'],[CUST,'Properties']],[TYPES.relationships,[PKG,'Relationships']],[TYPES.drawing,[D,'wsDr']]]);
  const trees=new Map();
  for(const entry of entries.values()){
    if(entry.dir||entry.name==='[Content_Types].xml')continue;
    const type=effective.get(entry.name),expected=roots.get(type);if(!expected)throw xerr('unsupported_xlsx_feature');
    const tree=safeXml(entry.bytes,limits,entry.name,type===TYPES.drawing);
    if(tree.uri!==expected[0]||tree.local!==expected[1])throw xerr('unsupported_xlsx_feature');
    scanFormula(tree);
    if(type!==TYPES.relationships)validateSchema(tree);
    if(type===TYPES.worksheet&&(child(tree,MAIN,'autoFilter')||child(tree,MAIN,'drawing'))||type===TYPES.workbook&&child(tree,MAIN,'definedNames')){
      // No decoding or inflation of first-pass output: strict pass uses the same
      // original verified byte Buffer, under the same lower-only XML ceilings.
      safeXml(entry.bytes,limits,entry.name,true);
    }
    trees.set(entry.name,tree);
  }
  return trees;
}
function relationshipSource(name){
  if(name==='_rels/.rels')return '';
  const match=/^(?:(.*)\/)?_rels\/([^/]+)\.rels$/.exec(name);if(!match)throw xerr();
  return `${match[1]?match[1]+'/':''}${match[2]}`;
}
function validateRelations(entries,trees,effective){
  const all=new Map(),inbound=new Map();
  for(const [name,type]of effective)if(type===TYPES.relationships){
    const source=relationshipSource(name);if(source&&(!entries.has(source)||entries.get(source).dir))throw xerr();if(all.has(source))throw xerr();
    all.set(source,parseRels(trees.get(name),source,entries));
  }
  const root=all.get('');if(!root)throw xerr();const office=[...root.values()].filter(r=>r.type===relTypes.get('officeDocument'));if(office.length!==1)throw xerr();
  const workbookPart=office[0].target;
  for(const [source,rels]of all)for(const rel of rels.values()){
    const typeKey=[...relTypes].find(([,value])=>value===rel.type)?.[0];
    if(typeKey==='officeDocument'&&(source!==''||effective.get(rel.target)!==TYPES.workbook))throw xerr('unsupported_xlsx_feature');
    if(typeKey!=='hyperlink'&&effective.get(rel.target)!==TYPES[typeKey==='officeDocument'?'workbook':typeKey])throw xerr('unsupported_xlsx_feature');
    if(['worksheet','chartsheet','sharedStrings','styles'].includes(typeKey)&&source!==workbookPart)throw xerr('unsupported_xlsx_feature');
    const edges=inbound.get(rel.target)??[];edges.push({source,...rel});inbound.set(rel.target,edges);
  }
  for(const name of entries.keys())if(effective.get(name)===TYPES.workbook&&name!==workbookPart)throw xerr('unsupported_xlsx_feature');
  const workbookRels=all.get(workbookPart);if(!workbookRels)throw xerr();
  const selected={};
  for(const kind of ['sharedStrings','styles']){
    const rels=[...workbookRels.values()].filter(r=>r.type===relTypes.get(kind));const parts=[...effective].filter(([,t])=>t===TYPES[kind]).map(([p])=>p);
    if(rels.length>1||parts.length>1)throw xerr('unsupported_xlsx_feature');
    if(parts.length!==rels.length)throw xerr();selected[kind]=rels[0]?.target;
  }
  return {all,inbound,workbookPart,workbookRels,selected};
}
function workbookCellLimits(trees,selected){
  const shared=selected.sharedStrings?trees.get(selected.sharedStrings):null,sharedValues=[];let sharedBytes=0;
  if(shared){
    const items=children(shared,MAIN,'si');if(items.length>1000000)throw xerr('xlsx_limit_exceeded');
    for(const item of items){const value=storedText(item);sharedBytes+=Buffer.byteLength(value,'utf8');if(sharedBytes>67108864)throw xerr('xlsx_limit_exceeded');sharedValues.push(value);}
  }
  let styleCount=1;
  if(selected.styles){const styles=trees.get(selected.styles),xfs=child(styles,MAIN,'cellXfs');if(!xfs)throw xerr();styleCount=children(xfs,MAIN,'xf').length;if(!styleCount)throw xerr();
    for(const xf of children(xfs,MAIN,'xf'))for(const key of ['numFmtId','fontId','fillId','borderId','xfId'])numericAttribute(xf,key);
    const formats=child(styles,MAIN,'numFmts');const ids=new Set();for(const fmt of formats?children(formats,MAIN,'numFmt'):[]){numericAttribute(fmt,'numFmtId');const id=getAttr(fmt,'numFmtId');if(ids.has(id))throw xerr();ids.add(id);}
  }
  return {sharedValues,styleCount};
}
function workbookSheets(root,rels,sourceHash,infos){
  const props=child(root,MAIN,'workbookPr'),date=getAttr(props??{attrs:[]},'date1904');if(date!==undefined&&!['0','1','true','false'].includes(date))throw xerr();
  const date_system=['1','true'].includes(date)?'1904':'1900',list=child(root,MAIN,'sheets');if(!list)throw xerr();
  const ids=new Set(),rids=new Set(),targets=new Set(),names=new Set(),sheets=[];
  for(const node of children(list,MAIN,'sheet')){
    const id=getAttr(node,'sheetId'),name=getAttr(node,'name'),rid=getAttr(node,'id',OFFICE),state=getAttr(node,'state')??'visible';
    if(!/^[1-9][0-9]*$/.test(id??'')||!Number.isSafeInteger(Number(id))||!name||[...name].length>31||ids.has(id)||rids.has(rid)||names.has(name)||!['visible','hidden','veryHidden'].includes(state))throw xerr();
    ids.add(id);rids.add(rid);names.add(name);const relation=rels.get(rid);if(!relation)throw xerr();
    if(targets.has(relation.target))throw xerr();targets.add(relation.target);
    const kind=relation.type===relTypes.get('worksheet')?'worksheet':relation.type===relTypes.get('chartsheet')?'other':null;if(!kind)throw xerr('unsupported_xlsx_feature');
    const info=kind==='worksheet'?infos.get(relation.target):{value_cells:0,min_row:null,max_row:null,min_column:null,max_column:null};if(!info)throw xerr();
    sheets.push({sheet_id:`${sourceHash}:${id}`,name,state,kind,selectable:kind==='worksheet'&&state==='visible',...info,relationship_id:rid,part:relation.target});
  }
  if(!sheets.length||sheets.length>2048)throw xerr();return {date_system,sheets};
}
function validateEmptyDrawing(trees,effective,overrides,graph,sheets){
  const drawingParts=[...effective].filter(([,type])=>type===TYPES.drawing).map(([part])=>part),edges=[],markers=[];
  for(const [source,rels]of graph.all)for(const rel of rels.values())if(rel.type===relTypes.get('drawing'))edges.push({source,...rel});
  for(const [part,tree]of trees)if(tree.uri===MAIN&&tree.local==='worksheet')for(const marker of children(tree,MAIN,'drawing'))markers.push({part,id:getAttr(marker,'id',OFFICE)});
  if(!drawingParts.length&&!edges.length&&!markers.length)return null;
  if(drawingParts.length!==1||edges.length!==1||markers.length!==1)throw xerr('unsupported_xlsx_feature');
  const target=drawingParts[0],edge=edges[0],marker=markers[0],owner=sheets.find(s=>s.part===marker.part);
  if(!owner?.selectable||edge.source!==owner.part||edge.id!==marker.id||edge.target!==target||graph.inbound.get(target)?.length!==1||overrides.get(target)!==TYPES.drawing||graph.all.has(target)||!child(trees.get(owner.part),MAIN,'autoFilter'))throw xerr('unsupported_xlsx_feature');
  return owner;
}
function validateFilterDatabase(workbook,owner,sheets,trees){
  const list=child(workbook,MAIN,'definedNames');
  // Parent grammar rejects wrong occurrences; the only workbook part was
  // selected by root officeDocument identity, never by its filename.
  if(!list)return;
  const name=child(list,MAIN,'definedName');
  if(!owner||sheets[0]!==owner||!/^([A-Za-z_][A-Za-z0-9_]{0,30})$/.test(owner.name)||sheets.filter(s=>s.name===owner.name).length!==1)throw xerr('unsupported_xlsx_feature');
  const expectedAttrs={name:'_xlnm._FilterDatabase',function:'false',hidden:'true',vbProcedure:'false',localSheetId:'0'};
  for(const [key,value]of Object.entries(expectedAttrs))if(getAttr(name,key)!==value)throw xerr('unsupported_xlsx_feature');
  const ref=getAttr(child(trees.get(owner.part),MAIN,'autoFilter'),'ref');rectangle(ref);
  const m=/^([A-Z]{1,3})([1-9][0-9]{0,6}):([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  const expected=`${owner.name}!$${m[1]}$${m[2]}:$${m[3]}$${m[4]}`;
  if(textContent(name)!==expected)throw xerr('unsupported_xlsx_feature');
}

export async function inspectXlsxPackage({assetPath,stagingPath,limits=XLSX_LIMITS,signal}={}){
  if(!limits||Object.keys(limits).length!==Object.keys(XLSX_LIMITS).length||Object.keys(XLSX_LIMITS).some(k=>!Object.hasOwn(limits,k)||!Number.isSafeInteger(limits[k])||limits[k]<1||limits[k]>XLSX_LIMITS[k]))throw xerr();
  const aborted=()=>{if(signal?.aborted)throw signal.reason??xerr();};aborted();
  const stat=await fs.lstat(assetPath).catch(()=>null);if(!stat?.isFile()||stat.isSymbolicLink())throw xerr();if(stat.size>limits.compressed_bytes)throw xerr('xlsx_limit_exceeded');
  const ds=await fs.lstat(stagingPath).catch(()=>null);if(!ds?.isDirectory()||ds.isSymbolicLink())throw xerr();
  const ownedDir=await fs.mkdtemp(path.join(path.resolve(stagingPath),'xlsx-owned-'));let zip;const entries=new Map(),aliases=new Set(),intervals=[];let count=0;const total={actual:0,cells:0};
  try{
    aborted();const sourceSha=await hashFile(assetPath);aborted();
    zip=await openPromise(assetPath,{lazyEntries:true,autoClose:false,validateEntrySizes:true,strictFileNames:true});
    for(let entry=await nextEntry(zip);entry;entry=await nextEntry(zip)){
      aborted();if(++count>limits.entries)throw xerr('xlsx_limit_exceeded');
      const item=await readEntry(zip,entry,ownedDir,count,limits,total,assetPath,signal);aborted();
      if(entry.extraFields.some(f=>f.id===0x7075)||entries.has(item.name)||aliases.has(item.alias))throw xerr();aliases.add(item.alias);entries.set(item.name,item);intervals.push(item.interval);
    }
    aborted();intervals.sort((a,b)=>a[0]-b[0]);for(let i=1;i<intervals.length;i++)if(intervals[i][0]<intervals[i-1][1])throw xerr();
    if(!entries.has('[Content_Types].xml')||!entries.has('_rels/.rels'))throw xerr();
    const xmlLimits={xml_bytes:limits.xml_bytes,xml_depth:limits.xml_depth};const ct=safeXml(entries.get('[Content_Types].xml').bytes,xmlLimits,'[Content_Types].xml');
    const {effective,overrides}=validateContentTypes(ct,entries),trees=parseXmlParts(entries,effective,xmlLimits),graph=validateRelations(entries,trees,effective);
    const cellLimits=workbookCellLimits(trees,graph.selected),infos=new Map();
    for(const [part,type]of effective)if(type===TYPES.worksheet)infos.set(part,worksheetInfo(trees.get(part),cellLimits,limits,total));
    const parsed=workbookSheets(trees.get(graph.workbookPart),graph.workbookRels,sourceSha,infos);
    const drawingOwner=validateEmptyDrawing(trees,effective,overrides,graph,parsed.sheets);
    validateFilterDatabase(trees.get(graph.workbookPart),drawingOwner,parsed.sheets,trees);
    aborted();const finalStat=await fs.lstat(assetPath);if(finalStat.size!==stat.size||finalStat.ino!==stat.ino||await hashFile(assetPath)!==sourceSha)throw xerr('xlsx_source_mismatch');aborted();
    const completedZip=zip;zip=null;await closeZip(completedZip);aborted();
    const parts=new Map();for(const item of entries.values())if(!item.dir)parts.set(item.name,{path:item.ownedPath,bytes:item.bytes.length,sha256:item.sha256,content_type:effective.get(item.name)});
    const inventory={source:{bytes:stat.size,sha256:sourceSha},date_system:parsed.date_system,sheets:parsed.sheets,parts};ownedDirectories.set(inventory,ownedDir);return inventory;
  }catch(error){
    await fs.rm(ownedDir,{recursive:true,force:true}).catch(()=>{});aborted();
    if(['invalid_xlsx','unsupported_xlsx_feature','xlsx_limit_exceeded','xlsx_source_mismatch','xlsx_formula_rejected','xlsx_cell_error'].includes(error?.code))throw error;throw xerr();
  }finally{await closeZip(zip);}
}
export async function disposeXlsxPackage(inventory){const dir=ownedDirectories.get(inventory);if(!dir)return;await fs.rm(dir,{recursive:true,force:true});ownedDirectories.delete(inventory);}
