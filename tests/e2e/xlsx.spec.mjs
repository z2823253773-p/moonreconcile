import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { startWorkbench } from '../../workbench/server.mjs';

let app;
test.beforeEach(async()=>{app=await startWorkbench({xlsxEnabled:true});});
test.afterEach(async()=>{await app?.close();app=null;});
async function open(page){try{await page.goto(`${app.origin}/#token=${app.token}`);}catch(error){error.message=error.message.replaceAll(app.token,'[redacted]');throw error;}await expect(page.getByRole('heading',{name:'MoonReconcile 工作台'})).toBeVisible();}
const fixture=name=>fileURLToPath(new URL(`../../tests/fixtures/xlsx/${name}`,import.meta.url));
async function saveReport(page,file){const pending=page.waitForEvent('download');await page.locator('.export-panel').getByRole('button',{name:'下载 report.json',exact:true}).click();const download=await pending;await download.saveAs(file);return fs.readFile(file);}
async function makeHtmlWorkbook(input,output){
  const zip=await yauzl.openPromise(input,{lazyEntries:true,autoClose:false,strictFileNames:true}),entries=[];
  try{
    const next=()=>new Promise((resolve,reject)=>{const clean=()=>{zip.removeListener('entry',onEntry);zip.removeListener('end',onEnd);zip.removeListener('error',onError);};const onEntry=entry=>{clean();resolve(entry);},onEnd=()=>{clean();resolve(null);},onError=error=>{clean();reject(error);};zip.once('entry',onEntry);zip.once('end',onEnd);zip.once('error',onError);zip.readEntry();});
    for(let entry=await next();entry;entry=await next()){const stream=await zip.openReadStreamPromise(entry),chunks=[];for await(const chunk of stream)chunks.push(chunk);let data=Buffer.concat(chunks);if(entry.fileName==='xl/sharedStrings.xml'){const xml=data.toString('utf8'),updated=xml.replace(/<si><r>[\s\S]*?<\/r><r>[\s\S]*?<\/r><\/si>/,'<si><t xml:space="preserve">&lt;script&gt;alert(1)&lt;/script&gt;雪🙂</t></si>');if(updated===xml)throw new Error('genuine XLSX rich-text fixture anchor missing');data=Buffer.from(updated);}entries.push([entry.fileName,data]);}
  }finally{zip.close();}
  const archive=new yazl.ZipFile();for(const [name,bytes]of entries)archive.addBuffer(bytes,name,{compress:false});const writing=pipeline(archive.outputStream,createWriteStream(output,{flags:'wx',mode:0o600}));archive.end();await writing;
}
function acceptConfirmContaining(page,text){page.once('dialog',dialog=>{expect(dialog.type()).toBe('confirm');expect(dialog.message()).toContain(text);void dialog.accept();});}
async function fillNativeFilterChoices(dialog){
  await dialog.getByLabel('工作表').selectOption('74dbde7450c6e56de05a54891e8c9b9f6240a8212c783c129473c1c5cb706d4e:1');
  for(const [name,value] of [['标题行','1'],['起始列','1'],['结束列','6'],['最后一行','3']])await dialog.getByLabel(name).fill(value);
  await dialog.getByRole('button',{name:'更新范围和转换方式'}).click();
  for(let index=1;index<=6;index++)await dialog.getByLabel(`第 ${index} 列转换方式`).selectOption('stored_text');
}

test('restricted XLSX asks for every choice and confirmation, then compares with visible provenance',async({page},testInfo)=>{
  await open(page);
  await expect(page.locator('#imports h2')).toHaveText('选择左右 CSV / XLSX');
  await expect(page.getByLabel('左侧来源 XLSX 文件')).toBeEnabled();
  await page.setViewportSize({width:390,height:844});
  await page.getByLabel('左侧来源 XLSX 文件').setInputFiles(fixture('lo-native-filter.xlsx'));
  await expect(page.getByRole('dialog')).toBeVisible();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByLabel('工作表')).toHaveValue('');
  await expect(dialog.getByLabel('标题行')).toHaveValue('');
  await expect(dialog.getByRole('button',{name:'检查选择并转换'})).toBeDisabled();
  await dialog.getByLabel('工作表').focus();await page.keyboard.press('s');await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('工作表')).toHaveValue('74dbde7450c6e56de05a54891e8c9b9f6240a8212c783c129473c1c5cb706d4e:1');
  await dialog.getByLabel('标题行').fill('1');await expect(dialog.getByLabel('标题行')).toHaveValue('1');
  await dialog.getByLabel('起始列').fill('1');await expect(dialog.getByLabel('起始列')).toHaveValue('1');
  await dialog.getByLabel('结束列').fill('6');await expect(dialog.getByLabel('结束列')).toHaveValue('6');
  await dialog.getByLabel('最后一行').fill('3');await expect(dialog.getByLabel('最后一行')).toHaveValue('3');
  await dialog.getByLabel('标题行').fill('0');
  await expect(dialog.getByRole('button',{name:'检查选择并转换'})).toBeDisabled();
  await dialog.getByLabel('标题行').fill('1');
  await dialog.getByLabel('最后一行').fill('1048577');
  await expect(dialog.getByRole('button',{name:'检查选择并转换'})).toBeDisabled();
  await dialog.getByLabel('最后一行').fill('3');
  await dialog.getByRole('button',{name:'更新范围和转换方式'}).click();
  await expect(dialog.getByLabel('第 1 列转换方式')).toHaveValue('');
  for(let i=1;i<=6;i++)await dialog.getByLabel(`第 ${i} 列转换方式`).selectOption('stored_text');
  acceptConfirmContaining(page,'转换前确认：Synthetic!A1:F3');
  await dialog.getByRole('button',{name:'检查选择并转换'}).click();
  await expect(dialog).toContainText('filtered_rows_included');
  await expect(dialog).toContainText('hidden_rows_included');
  await expect(dialog).toContainText('规范 CSV SHA-256');
  await expect(dialog.getByRole('button',{name:'绑定为左侧来源'})).toBeVisible();
  await expect(dialog.locator('h3')).toBeFocused();
  expect(await dialog.evaluate(element=>element.scrollTop)).toBe(0);
  expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  for(const hash of [await dialog.locator('p').filter({hasText:'原始文件 SHA-256'}).last().textContent(),await dialog.locator('p').filter({hasText:'规范 CSV SHA-256'}).last().textContent()])
    expect(hash).toMatch(/[a-f0-9]{64}/);
  await expect(dialog.locator('p').filter({hasText:'行映射：物理第'})).toBeVisible();
  await dialog.screenshot({path:testInfo.outputPath('xlsx-confirm-top-390.png')});
  await dialog.evaluate(element=>element.scrollTop=element.scrollHeight);
  await expect(dialog.locator('p').filter({hasText:'行映射：物理第'})).toBeVisible();
  await dialog.screenshot({path:testInfo.outputPath('xlsx-confirm-bottom-390.png')});
  acceptConfirmContaining(page,'确认将 lo-native-filter.xlsx 的工作表 Synthetic');
  await dialog.getByRole('button',{name:'绑定为左侧来源'}).click();
  await expect(page.locator('#imports')).toContainText('Synthetic');
  await expect(page.locator('#imports')).toContainText('雪🙂');
  await expect(page.locator('#imports script')).toHaveCount(0);
  await expect(page.locator('#imports')).toContainText('原始文件 SHA-256');
  await expect(page.locator('#imports')).toContainText('规范 CSV SHA-256');
  await expect(page.locator('#imports')).toContainText('stored_text');
  const rightCopy=testInfo.outputPath('right-native.xlsx');await makeHtmlWorkbook(fixture('lo-native-filter.xlsx'),rightCopy);
  await page.getByLabel('右侧来源 XLSX 文件').setInputFiles(rightCopy);
  const rightDialog=page.getByRole('dialog');
  const rightSheet=rightDialog.getByLabel('工作表');await rightSheet.selectOption(await rightSheet.locator('option').nth(1).getAttribute('value'));
  await rightDialog.getByLabel('标题行').fill('1');await rightDialog.getByLabel('起始列').fill('1');await rightDialog.getByLabel('结束列').fill('6');await rightDialog.getByLabel('最后一行').fill('3');
  await rightDialog.getByRole('button',{name:'更新范围和转换方式'}).click();
  for(let i=1;i<=6;i++)await rightDialog.getByLabel(`第 ${i} 列转换方式`).selectOption('stored_text');
  acceptConfirmContaining(page,'转换前确认：Synthetic!A1:F3');await rightDialog.getByRole('button',{name:'检查选择并转换'}).click();
  await expect(rightDialog.getByRole('button',{name:'绑定为右侧来源'})).toBeVisible();
  acceptConfirmContaining(page,'确认将 right-native.xlsx 的工作表 Synthetic');await rightDialog.getByRole('button',{name:'绑定为右侧来源'}).click();
  await expect(page.locator('#imports')).toContainText('right-native.xlsx');
  await expect(page.locator('#imports')).toContainText('<script>alert(1)</script>雪🙂');
  await expect(page.locator('#imports script')).toHaveCount(0);
  await page.getByRole('button',{name:'从当前列生成空白草稿',exact:true}).click();
  const fields=page.locator('#config .field-card');await expect(fields).toHaveCount(6);
  for(let index=0;index<6;index++)await fields.nth(index).getByLabel('类型（必选）').selectOption('text');
  await page.getByRole('button',{name:'校验并保存规则',exact:true}).click();
  await expect(page.locator('.notice.success.validation-summary')).toBeVisible();
  await page.getByRole('button',{name:'运行核心比较',exact:true}).click();
  const result=page.locator('.result-host');await expect(result.locator('.result-summary')).toBeVisible();
  const records=result.locator('.evidence-section').filter({has:page.getByRole('heading',{name:/记录状态与来源格值/})});
  await expect(records.getByRole('button',{name:'查看 id 原值',exact:true}).first()).toBeVisible();
  await records.getByRole('button',{name:'查看 id 原值',exact:true}).first().click();
  const provenance=page.getByRole('dialog');await expect(provenance).toContainText('Synthetic');await expect(provenance).toContainText('A2');
  await expect(provenance).toContainText('存储的原值');await expect(provenance).toContainText('导入后的原值');await expect(provenance).toContainText('00123');
  await provenance.getByRole('button',{name:'关闭',exact:true}).click();
  const beforeReport=await saveReport(page,testInfo.outputPath('before-candidate-report.json'));
  await page.getByLabel('左侧来源 XLSX 文件').setInputFiles(fixture('lo-formula-reject.xlsx'));
  const formulaDialog=page.getByRole('dialog');await expect(formulaDialog).toContainText('xlsx_formula_rejected');
  await formulaDialog.getByRole('button',{name:'取消并保留当前来源'}).click();
  await expect(page.locator('#imports')).toContainText('lo-native-filter.xlsx');
  expect(await saveReport(page,testInfo.outputPath('after-formula-report.json'))).toEqual(beforeReport);
  await page.getByLabel('左侧来源 XLSX 文件').setInputFiles(fixture('lo-native-filter.xlsx'));
  const escapeSelection=page.getByRole('dialog');await expect(escapeSelection).toBeVisible();
  await page.keyboard.press('Escape');await expect(escapeSelection).not.toBeVisible();
  await expect(page.locator('#imports')).toContainText('lo-native-filter.xlsx');
  expect(await saveReport(page,testInfo.outputPath('after-escape-selection-report.json'))).toEqual(beforeReport);
  await page.getByLabel('左侧来源 XLSX 文件').setInputFiles(fixture('lo-native-filter.xlsx'));
  const escapeSummary=page.getByRole('dialog');await fillNativeFilterChoices(escapeSummary);
  acceptConfirmContaining(page,'转换前确认：Synthetic!A1:F3');await escapeSummary.getByRole('button',{name:'检查选择并转换'}).click();
  await expect(escapeSummary.getByRole('button',{name:'绑定为左侧来源'})).toBeVisible();
  await page.keyboard.press('Escape');await expect(escapeSummary).not.toBeVisible();
  await expect(page.locator('#imports')).toContainText('lo-native-filter.xlsx');
  expect(await saveReport(page,testInfo.outputPath('after-escape-summary-report.json'))).toEqual(beforeReport);
  await page.getByLabel('左侧来源 XLSX 文件').setInputFiles(fixture('lo-native-filter.xlsx'));
  const declined=page.getByRole('dialog');
  await declined.getByLabel('工作表').selectOption('74dbde7450c6e56de05a54891e8c9b9f6240a8212c783c129473c1c5cb706d4e:1');
  await declined.getByLabel('标题行').fill('1');await declined.getByLabel('起始列').fill('1');await declined.getByLabel('结束列').fill('6');await declined.getByLabel('最后一行').fill('3');
  await declined.getByRole('button',{name:'更新范围和转换方式'}).click();for(let i=1;i<=6;i++)await declined.getByLabel(`第 ${i} 列转换方式`).selectOption('stored_text');
  acceptConfirmContaining(page,'转换前确认：Synthetic!A1:F3');await declined.getByRole('button',{name:'检查选择并转换'}).click();
  await expect(declined.getByRole('button',{name:'绑定为左侧来源'})).toBeVisible();
  page.once('dialog',dialog=>{expect(dialog.message()).toContain('确认将 lo-native-filter.xlsx 的工作表 Synthetic');void dialog.dismiss();});await declined.getByRole('button',{name:'绑定为左侧来源'}).click();
  await expect(declined).toContainText('转换完成');
  await expect(page.locator('#imports')).toContainText('lo-native-filter.xlsx');
  await declined.getByRole('button',{name:'取消并保留当前来源'}).click();
  expect(await saveReport(page,testInfo.outputPath('after-decline-report.json'))).toEqual(beforeReport);
  let importCalls=0;
  await page.route('**/api/imports',async route=>{
    if(route.request().method()==='POST'&&++importCalls===2)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'invalid_import_spec',message:'Injected second-side failure',phase:'xlsx',side:'left',record:null,field:null}})});
    return route.continue();
  });
  acceptConfirmContaining(page,'使用已保存的原始来源资产和转换选择');await page.getByRole('button',{name:'交换左右并重置关联规则'}).click();
  await expect(page.locator('#imports')).toContainText('交换未完成');
  await expect(page.locator('#imports')).toContainText('lo-native-filter.xlsx');await expect(page.locator('#imports')).toContainText('right-native.xlsx');
  expect(await saveReport(page,testInfo.outputPath('after-failed-swap-report.json'))).toEqual(beforeReport);
  await page.unroute('**/api/imports');
  acceptConfirmContaining(page,'使用已保存的原始来源资产和转换选择');await page.getByRole('button',{name:'交换左右并重置关联规则'}).click();
  await expect(page.locator('#imports')).toContainText('左右 XLSX 已交换并重新导入');
  await expect(page.locator('#imports')).toContainText('right-native.xlsx');
  await expect(result).toContainText('旧版本（只读）');
  await page.locator('#imports').screenshot({path:testInfo.outputPath('xlsx-bound-390.png')});
});

test('1904 date mode, stored date serial, blank row mapping, and outside-range warning are explicit',async({page})=>{
  await open(page);
  await page.getByLabel('左侧来源 XLSX 文件').setInputFiles(fixture('lo-conversion-1904.xlsx'));
  const first=page.getByRole('dialog');
  const configure=async(dialog,dateMode)=>{
    const sheet=dialog.getByLabel('工作表'),id=await sheet.locator('option').nth(1).getAttribute('value');await sheet.selectOption(id);
    for(const [name,value] of [['标题行','1'],['起始列','1'],['结束列','6'],['最后一行','4']])await dialog.getByLabel(name).fill(value);
    await dialog.getByRole('button',{name:'更新范围和转换方式'}).click();
    const modes=['stored_text','decimal_lexeme','decimal_lexeme',dateMode,'zero_padded_identifier','stored_text'];
    for(let index=0;index<modes.length;index++)await dialog.getByLabel(`第 ${index+1} 列转换方式`).selectOption(modes[index]);
    acceptConfirmContaining(page,'转换前确认：Synthetic!A1:F4');await dialog.getByRole('button',{name:'检查选择并转换'}).click();
    await expect(dialog).toContainText('日期系统 1904');await expect(dialog).toContainText('outside_range_value_cells');await expect(dialog).toContainText('3 条数据记录');
  };
  await configure(first,'stored_text');
  await expect(first).toContainText('D：保留存储原值（文本）（stored_text）');
  acceptConfirmContaining(page,'工作表 Synthetic');await first.getByRole('button',{name:'绑定为左侧来源'}).click();
  const left=page.locator('#imports .source-card').first();await expect(left).toContainText('日期系统 1904');await expect(left).toContainText('行映射：物理第 1 行为表头，数据从第 2 行开始，3 条');
  const leftRows=left.locator('.preview-table tbody tr');await expect(leftRows).toHaveCount(3);await expect(leftRows.first()).toContainText('0');await expect(leftRows.last()).toContainText('3');
  await page.getByLabel('右侧来源 XLSX 文件').setInputFiles(fixture('lo-conversion-1904.xlsx'));
  const second=page.getByRole('dialog');await configure(second,'excel_date');
  acceptConfirmContaining(page,'工作表 Synthetic');await second.getByRole('button',{name:'绑定为右侧来源'}).click();
  const right=page.locator('#imports .source-card').nth(1);await expect(right).toContainText('1904-01-01');await expect(right.locator('.preview-table tbody tr').last()).toContainText('3');
});

test('default host stays CSV-only until the explicit test capability is enabled',async({page})=>{
  await app.close();app=await startWorkbench();await open(page);
  await expect(page.locator('#imports h2')).toHaveText('选择左右 CSV');
  await expect(page.getByLabel('左侧来源 CSV 文件')).toBeEnabled();
  await expect(page.getByLabel('左侧来源 XLSX 文件')).toHaveCount(0);
  const response=await page.request.get(`${app.origin}/api/capabilities`,{headers:{Authorization:`Bearer ${app.token}`}});
  expect((await response.json()).formats).toEqual(['csv']);
});

async function conversionChoices(page,{mode='excel_date',firstMode='stored_text'}={}) {
  const dialog=page.getByRole('dialog'),sheet=dialog.getByLabel('工作表');
  await sheet.selectOption(await sheet.locator('option').nth(1).getAttribute('value'));
  for(const [name,value] of [['标题行','1'],['起始列','1'],['结束列','6'],['最后一行','2']])await dialog.getByLabel(name).fill(value);
  await dialog.getByRole('button',{name:'更新范围和转换方式'}).click();
  for(const [index,value]of [firstMode,'decimal_lexeme','stored_text',mode,'zero_padded_identifier','stored_text'].entries())await dialog.getByLabel(`第 ${index+1} 列转换方式`).selectOption(value);
  acceptConfirmContaining(page,'转换前确认：Synthetic!A1:F2');await dialog.getByRole('button',{name:'检查选择并转换'}).click();
  return dialog;
}
async function mixedCompare(page,testInfo){
  await open(page);
  await page.getByLabel('左侧来源 XLSX 文件').setInputFiles(fixture('lo-conversion-1904.xlsx'));
  const dialog=await conversionChoices(page);await expect(dialog.getByRole('button',{name:'绑定为左侧来源'})).toBeVisible();
  acceptConfirmContaining(page,'工作表 Synthetic');await dialog.getByRole('button',{name:'绑定为左侧来源'}).click();
  const counterpart=testInfo.outputPath('counterpart.csv');
  await fs.writeFile(counterpart,'text_id,numeric_long,decimal,date_serial,padded,boolean\n00123,9007199254740990,123,1904-01-01,00123,1\ncsv-only,1,1,1904-01-02,00001,0\n');
  await page.getByLabel('右侧来源 XLSX 文件').setInputFiles(counterpart);
  await expect(page.locator('#imports .source-card').nth(1)).toContainText('完整校验 2 行');
  await page.getByRole('button',{name:'从当前列生成空白草稿',exact:true}).click();
  const fields=page.locator('#config .field-card');await expect(fields).toHaveCount(6);
  for(let index=0;index<6;index++)await fields.nth(index).getByLabel('类型（必选）').selectOption('text');
  await page.getByLabel('主键字段（每行一项）').fill('text_id');
  await page.getByRole('button',{name:'校验并保存规则',exact:true}).click();await expect(page.locator('.notice.success.validation-summary')).toBeVisible();
  await page.getByRole('button',{name:'运行核心比较',exact:true}).click();
  await expect(page.locator('.result-summary')).toBeVisible();await expect(page.getByRole('button',{name:'添加手工决定',exact:true})).toBeEnabled();
}
async function originalDateProvenance(page){
  const records=page.locator('.result-host .evidence-section').filter({has:page.getByRole('heading',{name:/记录状态与来源格值/})});
  const left=records.locator('.evidence-item').filter({has:page.getByRole('heading',{name:/records\[.*L1$/})});
  await left.getByRole('button',{name:'查看 date_serial 原值',exact:true}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toContainText('原始工作簿：Synthetic · D2 · numeric · excel_date');
  await expect(dialog.getByRole('heading',{name:'存储的原值',exact:true})).toBeVisible();await expect(dialog.getByRole('heading',{name:'导入后的原值',exact:true})).toBeVisible();
  await expect(dialog.locator('pre').nth(0)).toHaveText('0');await expect(dialog.locator('pre').nth(1)).toHaveText('1904-01-01');
  return dialog;
}

test('mixed CSV XLSX review branch rebind preserves original materials profile swap and immutable old provenance',async({page},testInfo)=>{
  const imports=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/api/imports'&&request.method()==='POST')imports.push(request.postDataJSON());});
  await mixedCompare(page,testInfo);
  const initialImport=imports.find(body=>body.import_spec);
  expect(initialImport.import_spec.columns[3]).toEqual({column:4,mode:'excel_date'});
  const before=JSON.parse(await saveReport(page,testInfo.outputPath('mixed-original-report.json')));expect(before.records.find(item=>item.id==='R2').status).toBe('pending_review');
  const records=page.locator('.result-host .evidence-section').filter({has:page.getByRole('heading',{name:/记录状态与来源格值/})});
  const extra=records.locator('.evidence-item').filter({has:page.getByRole('heading',{name:/records\[.*R2$/})});
  await extra.getByLabel('unmatched理由 R2').fill('CSV counterpart contains an additional independently checked row');await extra.getByRole('button',{name:'right_unmatched',exact:true}).click();
  await page.getByRole('button',{name:'应用待处理决定',exact:true}).click();
  await expect(page.getByRole('button',{name:'添加手工决定',exact:true})).toBeEnabled();
  const reviewedBytes=await saveReport(page,testInfo.outputPath('mixed-reviewed-report.json')),reviewed=JSON.parse(reviewedBytes);expect(reviewed.decisions).toHaveLength(1);expect(reviewed.records.find(item=>item.id==='R2').status).toBe('unmatched');
  const reviewedHeading=await page.locator('.result-host h3').first().innerText(),reviewedId=reviewedHeading.match(/revision ([a-f0-9-]+)/)[1];
  const materialReads=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname.includes('/materials/export'))materialReads.push(url.pathname+url.search);});
  acceptConfirmContaining(page,'新建分支');await page.getByRole('button',{name:'从原始比较新建分支',exact:true}).click();
  await expect.poll(()=>page.locator('.result-host h3').first().innerText()).not.toBe(reviewedHeading);
  await expect(page.getByRole('button',{name:'添加手工决定',exact:true})).toBeEnabled();
  const leftCard=page.locator('#imports .source-card').first();
  await expect(leftCard).toContainText('原始文件 SHA-256');await expect(leftCard).toContainText('规范 CSV SHA-256');await expect(leftCard).toContainText('Synthetic');await expect(leftCard).toContainText('4:excel_date');
  expect(materialReads.some(route=>route.endsWith('kind=profile'))).toBe(true);expect(materialReads.some(route=>route.endsWith('kind=manifest'))).toBe(true);
  const branchBytes=await saveReport(page,testInfo.outputPath('mixed-branch-report.json'));expect(JSON.parse(branchBytes).decisions).toEqual([]);expect(JSON.parse(branchBytes).records.find(item=>item.id==='R2').status).toBe('pending_review');
  const provenance=await originalDateProvenance(page);await provenance.screenshot({path:testInfo.outputPath('branch-provenance.png')});await provenance.getByRole('button',{name:'关闭',exact:true}).click();
  const calls=imports.length;acceptConfirmContaining(page,'使用已保存的原始来源资产和转换选择');await page.getByRole('button',{name:'交换左右并重置关联规则',exact:true}).click();
  await expect(page.locator('#imports')).toContainText('已交换并重新导入');expect(imports.slice(calls)).toEqual([{asset_id:imports[1].asset_id,side:'left'},{asset_id:initialImport.asset_id,side:'right',import_spec:initialImport.import_spec}]);
  await expect(page.locator('#imports .source-card').nth(1)).toContainText('规范 CSV SHA-256');await expect(page.locator('.result-host')).toContainText('旧版本（只读）');
  expect(await saveReport(page,testInfo.outputPath('mixed-after-swap-report.json'))).toEqual(branchBytes);
  const replacement=testInfo.outputPath('replacement.csv');await fs.writeFile(replacement,'text_id,numeric_long,decimal,date_serial,padded,boolean\nreplacement,7,7,2099-12-31,00007,1\n');
  await page.getByLabel('右侧来源 XLSX 文件').setInputFiles(replacement);await expect(page.locator('#imports .source-card').nth(1)).toContainText('replacement.csv');await expect(page.locator('#imports')).not.toContainText('规范 CSV SHA-256');
  expect(await saveReport(page,testInfo.outputPath('mixed-after-replacement-report.json'))).toEqual(branchBytes);
  await page.getByRole('button',{name:new RegExp(`^${reviewedId.slice(0,8)} · exit`)}).click();
  await expect(page.locator('.result-host h3').first()).toContainText(reviewedId);expect(await saveReport(page,testInfo.outputPath('mixed-old-reviewed-report.json'))).toEqual(reviewedBytes);
  const old=await originalDateProvenance(page);await old.screenshot({path:testInfo.outputPath('old-revision-provenance.png')});await old.getByRole('button',{name:'关闭',exact:true}).click();
  await fs.writeFile(testInfo.outputPath('mixed-lifecycle-receipt.json'),JSON.stringify({initialImport,swapImports:imports.slice(calls,calls+2),reviewedId,materialReads,originalSheet:'Synthetic',coordinate:'D2',stored:'0',imported:'1904-01-01'},null,2));
});

test('real XLSX conversion physical error and null package rejection preserve old source and report',async({page},testInfo)=>{
  await mixedCompare(page,testInfo);const before=await saveReport(page,testInfo.outputPath('errors-before-report.json'));
  const failures=[];page.on('response',async response=>{if(!new URL(response.url()).pathname.startsWith('/api/jobs/'))return;const data=await response.json().catch(()=>null);if(data?.job?.state==='failed')failures.push(data.job.error);});
  await page.getByLabel('左侧来源 XLSX 文件').setInputFiles(fixture('lo-conversion-1904.xlsx'));
  const physical=await conversionChoices(page,{firstMode:'decimal_lexeme'}),alert=physical.getByRole('alert');
  await expect(alert).toContainText('xlsx_value_mode_mismatch');await expect(alert).toContainText('工作表物理位置：第 2 行');await expect(alert).toContainText('单元格 A2');await expect(alert).not.toContainText('逻辑记录');
  await physical.screenshot({path:testInfo.outputPath('physical-error.png')});await physical.getByRole('button',{name:'取消并保留当前来源'}).click();
  await expect(page.locator('#imports .source-card').first()).toContainText('4:excel_date');expect(await saveReport(page,testInfo.outputPath('errors-after-physical-report.json'))).toEqual(before);
  await page.getByLabel('左侧来源 XLSX 文件').setInputFiles(fixture('lo-formula-reject.xlsx'));
  const rejected=page.getByRole('dialog'),packageAlert=rejected.getByRole('alert');
  await expect(packageAlert).toContainText('xlsx_formula_rejected');await expect(packageAlert).toContainText('工作簿级别');await expect(packageAlert).not.toContainText('单元格');await expect(packageAlert).not.toContainText('物理位置');await expect(packageAlert).not.toContainText('A2');await expect(packageAlert).not.toContainText('xl/');
  await rejected.screenshot({path:testInfo.outputPath('package-error.png')});await rejected.getByRole('button',{name:'取消并保留当前来源'}).click();
  await expect(page.locator('#imports .source-card').first()).toContainText('4:excel_date');expect(await saveReport(page,testInfo.outputPath('errors-after-package-report.json'))).toEqual(before);
  expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({code:'xlsx_value_mode_mismatch',phase:'xlsx',record:2,field:'A2'}),expect.objectContaining({code:'xlsx_formula_rejected',phase:'xlsx',record:null,field:null})]));
  await fs.writeFile(testInfo.outputPath('real-error-dtos.json'),JSON.stringify(failures,null,2));
});
