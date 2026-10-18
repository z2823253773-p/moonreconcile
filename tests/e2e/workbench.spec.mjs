import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startWorkbench } from '../../workbench/server.mjs';
import { loadBridgeInvoke } from '../../cli/bridge.mjs';
import { run } from '../../cli/main.mjs';

let app;
test.beforeEach(async()=>{app=await startWorkbench({xlsxEnabled:false});});
test.afterEach(async()=>{await app?.close();app=null;});
const panel=page=>page.locator('.export-panel');
const result=page=>page.locator('.result-host');
const section=(page,title)=>result(page).locator('.evidence-section').filter({has:page.getByRole('heading',{name:new RegExp(`^${title}`)})});
async function openWorkbench(page) {
  // Authentication navigation is never traced, recorded, or attached.
  try{await page.goto(`${app.origin}/#token=${app.token}`);}catch(error){error.message=error.message.replaceAll(app.token,'[redacted]');if(error.stack)error.stack=error.stack.replaceAll(app.token,'[redacted]');throw error;}
  await expect(page.getByRole('heading',{name:'MoonReconcile 工作台'})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>location.hash==='')).toBe(true);
  expect((await page.evaluate(()=>location.href)).includes(app.token)).toBe(false);
}
async function saveDownload(page,button,file) {
  const pending=page.waitForEvent('download');await button.click();const download=await pending;
  await download.saveAs(file);return file;
}
async function cliOracle({left,right,config,decisions,root}) {
  await fs.mkdir(root,{recursive:true});const invoke=await loadBridgeInvoke();
  const compared=path.join(root,'cli-compare'),resolved=path.join(root,'cli-resolved');
  const options={invoke,cwd:root,stdout:()=>{},stderr:()=>{}};
  expect([0,1,3]).toContain(await run(['compare',left,right,'--config',config,'--out',compared],options));
  expect([0,1,3]).toContain(await run(['resolve',compared,'--decisions',decisions,'--out',resolved],options));
  return fs.readFile(path.join(resolved,'report.json'));
}
async function checkRules(page) {
  await page.getByRole('button',{name:'校验并保存规则',exact:true}).click();
  await expect(page.locator('.notice.success.validation-summary')).toBeVisible();
  await expect(page.getByRole('button',{name:'运行核心比较',exact:true})).toBeEnabled();
}
async function compare(page) {
  await page.getByRole('button',{name:'运行核心比较',exact:true}).click();
  await expect(result(page).locator('.result-summary')).toBeVisible();
  await expect(page.getByRole('button',{name:'添加手工决定',exact:true})).toBeEnabled();
  await expect(section(page,'记录状态与来源格值').locator('.evidence-item')).not.toHaveCount(0);
}
async function revisionText(page){return result(page).getByRole('heading',{name:/^结果 revision/}).innerText();}
async function applyPending(page) {
  const before=await revisionText(page);await page.getByRole('button',{name:'应用待处理决定',exact:true}).click();
  await expect.poll(()=>revisionText(page)).not.toBe(before);
  await expect(page.getByRole('button',{name:'添加手工决定',exact:true})).toBeEnabled();
}
async function branch(page) {
  const before=await revisionText(page);page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'从原始比较新建分支',exact:true}).click();
  await expect.poll(()=>revisionText(page)).not.toBe(before);
  await expect(page.getByRole('button',{name:'添加手工决定',exact:true})).toBeEnabled();
}
async function manual(page,action,left,right='',reason='') {
  await page.getByRole('combobox',{name:'动作',exact:true}).selectOption(action);
  await page.getByLabel('手工 left_id').fill(left);await page.getByLabel('手工 right_id').fill(right);
  await page.getByLabel('手工决定理由').fill(reason);await page.getByRole('button',{name:'添加手工决定',exact:true}).click();
}
async function downloadEvidence(page,root,prefix='ui') {
  const report=await saveDownload(page,panel(page).getByRole('button',{name:'下载 report.json',exact:true}),path.join(root,`${prefix}-report.json`));
  const decisions=await saveDownload(page,panel(page).getByRole('button',{name:'下载 decisions.csv',exact:true}),path.join(root,`${prefix}-decisions.csv`));
  const config=await saveDownload(page,page.getByRole('button',{name:'导出已校验配置',exact:true}),path.join(root,`${prefix}-config.json`));
  return {report,decisions,config};
}
async function keyboardAndNarrow(page,testInfo) {
  await page.setViewportSize({width:390,height:844});
  const names=['运行核心比较','添加手工决定','从原始比较新建分支','下载 report.json','下载 summary.md','下载 decisions.csv','下载完整运行 ZIP','恢复 ZIP 工作包','重置本机工作台'];
  for(const name of names){const control=page.getByRole('button',{name,exact:true});await control.scrollIntoViewIfNeeded();const box=await control.boundingBox();expect(box,name).not.toBeNull();expect(box.x,name).toBeGreaterThanOrEqual(0);expect(box.x+box.width,name).toBeLessThanOrEqual(390);}
  // Use real Tab navigation through the complete document, without programmatic
  // focus of the targets. The only evaluate calls observe DOM focus and bounds.
  await page.getByRole('heading',{name:'MoonReconcile 工作台'}).click();
  const reached=new Set();
  for(let i=0;i<600&&reached.size<names.length;i++){
    await page.keyboard.press('Tab');
    const name=await page.evaluate(()=>document.activeElement?.tagName==='BUTTON'?document.activeElement.textContent:null);
    if(names.includes(name))reached.add(name);
  }
  expect([...reached].sort()).toEqual([...names].sort());
  await page.screenshot({path:testInfo.outputPath('orders-restored-390.png'),fullPage:true});await page.screenshot({path:testInfo.outputPath('orders-restored-390-controls.png')});
}

test('orders blank form → L3 apply → downloads → ZIP/reset/restore → branch and cumulative file replay match CLI bytes',async({page},testInfo)=>{
  const root=testInfo.outputPath('orders');await fs.mkdir(root,{recursive:true});
  const left=path.join(root,'left.csv'),right=path.join(root,'right.csv');
  // Original 3/2 orders values and distinct headers, with explicit two-sided
  // localized status mapping exercised through the blank form.
  await fs.writeFile(left,(await fs.readFile('examples/orders/left.csv','utf8')).replaceAll(',paid,',',已支付,'));
  await fs.writeFile(right,(await fs.readFile('examples/orders/right.csv','utf8')).replace('已支付','settled'));
  await openWorkbench(page);await page.getByLabel('左侧来源 CSV 文件').setInputFiles(left);
  await expect(page.locator('#imports')).toContainText('完整校验 3 行');
  await page.getByLabel('右侧来源 CSV 文件').setInputFiles(right);await expect(page.locator('#imports')).toContainText('完整校验 2 行');
  await page.getByRole('button',{name:'从当前列生成空白草稿',exact:true}).click();
  const fields=page.locator('.field-card');await expect(fields).toHaveCount(8);
  while(await fields.count()>4)await fields.last().getByRole('button',{name:'删除字段',exact:true}).click();
  for(const [index,rightColumn,type] of [[0,'external_ref','text'],[1,'state','text'],[2,'total','decimal'],[3,'settled_on','date']]){
    await fields.nth(index).getByRole('combobox',{name:'右侧来源列',exact:true}).selectOption(rightColumn);
    await fields.nth(index).getByLabel('类型（必选）').selectOption(type);
  }
  await fields.nth(0).getByLabel('参与逐行比较',{exact:true}).uncheck();
  await page.getByLabel('主键字段（每行一项）').fill('order_id');
  await fields.nth(2).getByLabel('绝对容差（十进制字符串）').fill('0.02');
  for(const [title,value] of [['左侧值映射','已支付'],['右侧值映射','settled']]){
    const block=fields.nth(1).locator('section.editor-block').filter({has:page.getByRole('heading',{name:new RegExp(`^${title}`)})});
    await block.getByRole('button',{name:'添加',exact:true}).click();
    await block.locator('.map-row').last().getByLabel('原值',{exact:true}).fill(value);
    await block.locator('.map-row').last().getByLabel('映射为',{exact:true}).fill('paid');
  }
  await checkRules(page);
  const keyboardDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出已校验配置'}).focus();await page.keyboard.press('Enter');
  await (await keyboardDownload).saveAs(path.join(root,'keyboard-config.json'));
  const configured=JSON.parse(await fs.readFile(path.join(root,'keyboard-config.json'),'utf8'));
  expect(configured.key).toEqual(['order_id']);expect(configured.fields[2].abs_tol).toBe('0.02');expect(configured.fields[1].left_values).toEqual({'已支付':'paid'});expect(configured.fields[1].right_values).toEqual({settled:'paid'});
  await compare(page);
  await expect(section(page,'字段差异及完整证据')).toContainText('different');
  await manual(page,'accept','L1','R1');await expect(result(page).locator('.notice.error')).toContainText('精确键配对已锁定');
  await expect(section(page,'已配对记录')).toContainText('exact_key');
  const l3=section(page,'记录状态与来源格值').locator('.evidence-item').filter({has:page.getByRole('heading',{name:/records\[.*L3$/})});
  await expect(l3).toHaveCount(1);await l3.getByLabel('unmatched理由 L3').fill('核对后确认左侧独有');await l3.getByRole('button',{name:'left_unmatched',exact:true}).click();
  await expect(panel(page)).toContainText('待应用决定：1 项');
  // Pending notice is observed before any source replacement.
  await applyPending(page);await expect(panel(page)).toContainText('待应用决定：0 项');
  const evidence=await downloadEvidence(page,root);await saveDownload(page,panel(page).getByRole('button',{name:'下载 summary.md',exact:true}),path.join(root,'ui-summary.md'));
  const reportBytes=await fs.readFile(evidence.report),reportJson=JSON.parse(reportBytes);
  expect(reportJson.decisions).toEqual([expect.objectContaining({action:'left_unmatched',left_id:'L3'})]);
  expect(reportJson.fields.some(item=>item.status==='different')).toBe(true);
  expect(reportBytes).toEqual(await cliOracle({left,right,...evidence,root:path.join(root,'cli')}));
  const bundle=await saveDownload(page,panel(page).getByRole('button',{name:'下载完整运行 ZIP',exact:true}),path.join(root,'orders.zip'));
  const changedRight=path.join(root,'changed.csv');await fs.writeFile(changedRight,'external_ref,state,total,settled_on\nA,settled,100.00,2026-09-01\n');
  await page.getByLabel('右侧来源 CSV 文件').setInputFiles(changedRight);await expect(result(page)).toContainText('旧版本（只读）');
  await expect(page.getByRole('button',{name:'应用待处理决定',exact:true})).toBeDisabled();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'重置本机工作台',exact:true}).click();
  await expect(panel(page)).toContainText('本机工作台已重置');await expect(page.locator('#imports .source-meta')).toHaveCount(0);
  await page.getByLabel('选择 MoonReconcile ZIP 工作包',{exact:true}).setInputFiles(bundle);await page.getByRole('button',{name:'恢复 ZIP 工作包',exact:true}).click();
  await expect(panel(page)).toContainText('ZIP 已重放验证并恢复');await expect(page.locator('#imports')).toContainText('完整校验 3 行');await expect(page.locator('#imports')).toContainText('完整校验 2 行');
  await expect(page.locator('.notice.success.validation-summary')).toBeVisible();await expect(section(page,'已应用决定（只读）')).toContainText('left_unmatched');
  await expect(panel(page)).toContainText('待应用决定：0 项');const restored=await downloadEvidence(page,root,'restored');expect(await fs.readFile(restored.report)).toEqual(reportBytes);
  expect(await fs.readFile(restored.report)).toEqual(await cliOracle({left,right,...restored,root:path.join(root,'restored-cli')}));
  await keyboardAndNarrow(page,testInfo);
  await branch(page);const clean=await downloadEvidence(page,root,'branch');expect(JSON.parse(await fs.readFile(clean.report)).decisions).toEqual([]);
  expect(JSON.parse(await fs.readFile(clean.report)).records.find(item=>item.id==='L3').status).toBe('pending_review');
  const before=await revisionText(page);await page.getByLabel('导入累计决定 CSV').setInputFiles(evidence.decisions);await expect.poll(()=>revisionText(page)).not.toBe(before);
  const replayed=await downloadEvidence(page,root,'replayed');expect(await fs.readFile(replayed.report)).toEqual(reportBytes);
});

test('catalog form threshold, core manual reason rejection, competing reject/accept/unmatched, conflict preservation and CSV replay',async({page},testInfo)=>{
  const root=testInfo.outputPath('catalog');await fs.mkdir(root,{recursive:true});await openWorkbench(page);
  await page.getByRole('button',{name:'载入合成 catalog 示例',exact:true}).click();await expect(page.locator('#imports')).toContainText('完整校验 2 行');
  const candidates=page.locator('#config details.config-group').filter({has:page.getByText('候选匹配（可选）',{exact:true})});await candidates.locator('summary').click();
  await page.getByLabel('候选阈值（1–10000 严格整数）').fill('9000');await checkRules(page);await compare(page);
  const baseline=await downloadEvidence(page,root,'baseline');
  await manual(page,'accept','L1','R1');await page.getByRole('button',{name:'应用待处理决定',exact:true}).click();
  await expect(result(page).locator('.notice.error')).toContainText('manual_override_needs_reason');await expect(result(page).locator('.notice.error')).toContainText('决定数据行 1');await expect(panel(page)).toContainText('待应用决定：1 项');
  const failed=await saveDownload(page,panel(page).getByRole('button',{name:'下载 report.json',exact:true}),path.join(root,'failed-report.json'));expect(await fs.readFile(failed)).toEqual(await fs.readFile(baseline.report));
  await page.getByRole('button',{name:'移除待应用动作',exact:true}).click();await expect(panel(page)).toContainText('待应用决定：0 项');
  await expect(candidates).toHaveJSProperty('open',true);await page.getByLabel('候选阈值（1–10000 严格整数）').fill('8000');await checkRules(page);await compare(page);
  const candidateSection=section(page,'所有竞争候选与诊断');await expect(candidateSection.locator('.evidence-item')).toHaveCount(2);
  const highest=candidateSection.locator('.evidence-item').filter({has:page.getByRole('heading',{name:/L1\/R2$/})}),competitor=candidateSection.locator('.evidence-item').filter({has:page.getByRole('heading',{name:/L1\/R1$/})});
  expect(JSON.parse(await highest.locator('pre').innerText()).score).toBe(10000);expect(JSON.parse(await competitor.locator('pre').innerText()).score).toBe(8000);
  await highest.getByRole('button',{name:'reject 此配对',exact:true}).click();await competitor.getByRole('button',{name:'accept 此配对',exact:true}).click();
  const r2=section(page,'记录状态与来源格值').locator('.evidence-item').filter({has:page.getByRole('heading',{name:/records\[.*R2$/})});await r2.getByLabel('unmatched理由 R2').fill('核对后确认右侧独有');await r2.getByRole('button',{name:'right_unmatched',exact:true}).click();
  await expect(panel(page)).toContainText('待应用决定：3 项');await applyPending(page);const reviewed=await downloadEvidence(page,root,'reviewed');
  const bytes=await fs.readFile(reviewed.report);expect(JSON.parse(bytes).decisions).toHaveLength(3);expect(bytes).toEqual(await cliOracle({left:path.resolve('examples/catalog/left.csv'),right:path.resolve('examples/catalog/right.csv'),...reviewed,root:path.join(root,'cli')}));
  await manual(page,'accept','L1','R2','测试冲突');await page.getByRole('button',{name:'应用待处理决定',exact:true}).click();await expect(result(page).locator('.notice.error')).toContainText('conflicting_decisions');
  const conflict=await saveDownload(page,panel(page).getByRole('button',{name:'下载 report.json',exact:true}),path.join(root,'conflict-report.json'));expect(await fs.readFile(conflict)).toEqual(bytes);await expect(panel(page)).toContainText('待应用决定：1 项');await page.getByRole('button',{name:'移除待应用动作',exact:true}).click();
  await branch(page);const before=await revisionText(page);await page.getByLabel('导入累计决定 CSV').setInputFiles(reviewed.decisions);await expect.poll(()=>revisionText(page)).not.toBe(before);const replayed=await downloadEvidence(page,root,'replayed');expect(await fs.readFile(replayed.report)).toEqual(bytes);
  await page.screenshot({path:testInfo.outputPath('catalog-review.png'),fullPage:true});
});

test('HTML and long Chinese are text; malformed CSV and invalid config preserve precise locations',async({page},testInfo)=>{
  const root=testInfo.outputPath('safe-text');await fs.mkdir(root,{recursive:true});const csv=path.join(root,'safe.csv'),long='中文'.repeat(1500);
  await fs.writeFile(csv,'<img src=x onerror=alert(1)>,memo\n1,'+long+'\n');await openWorkbench(page);
  const dialogs=[];page.on('dialog',dialog=>{dialogs.push(dialog.message());void dialog.dismiss();});await page.getByLabel('左侧来源 CSV 文件').setInputFiles(csv);await expect(page.locator('#imports')).toContainText('<img src=x onerror=alert(1)>');await expect(page.locator('#imports img')).toHaveCount(0);
  await page.getByRole('button',{name:'查看完整值',exact:true}).click();await expect(page.getByRole('dialog').locator('pre')).toHaveText(long);await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();expect(dialogs).toEqual([]);
  const broken=path.join(root,'broken.csv');await fs.writeFile(broken,'id,value\n1,one\n2,"unfinished\n');await page.getByLabel('右侧来源 CSV 文件').setInputFiles(broken);
  const parserError=page.locator('#imports [role=alert]').filter({hasText:'invalid_csv'}).last();await expect(parserError).toContainText('逻辑记录 3');
  await page.getByRole('button',{name:'载入合成 orders 示例',exact:true}).click();await expect(page.locator('#imports')).toContainText('完整校验 3 行');
  const invalid=path.join(root,'invalid-config.json');await fs.writeFile(invalid,JSON.stringify({schema_version:1,fields:[{name:'id',left:'order_id',right:'external_ref',type:'unsupported'}],key:['id']}));
  await page.getByLabel('导入配置 JSON',{exact:true}).setInputFiles(invalid);const error=page.locator('#config').getByRole('alert');await expect(error).toContainText('字段');await expect(error).toContainText('错误码');await expect(error).toContainText('阶段');
  await page.screenshot({path:testInfo.outputPath('safe-errors.png'),fullPage:true});
});

test('real core compare cancellation preserves the last published report and releases all controls',async({page},testInfo)=>{
  const root=testInfo.outputPath('cancel');await fs.mkdir(root,{recursive:true});const bridge=path.join(root,'slow-bridge.mjs'),flag=path.join(root,'slow.flag');
  const core=pathToFileURL(path.resolve('_build/js/debug/build/cmd/bridge/bridge.js')).href;
  await fs.writeFile(bridge,`import fs from 'node:fs';import {invoke_bridge as core} from ${JSON.stringify(core)};export function invoke_bridge(s){if(fs.existsSync(${JSON.stringify(flag)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);return core(s);}`);
  await app.close();app=await startWorkbench({bridgePath:bridge,xlsxEnabled:false});await openWorkbench(page);await page.getByRole('button',{name:'载入合成 orders 示例',exact:true}).click();await expect(page.locator('#imports')).toContainText('完整校验 3 行');await compare(page);
  const saved=await downloadEvidence(page,root,'before');await fs.writeFile(flag,'delay');await page.getByRole('button',{name:'运行核心比较',exact:true}).click();await page.getByRole('button',{name:'取消当前任务',exact:true}).click();
  await expect(page.getByRole('button',{name:'运行核心比较',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'取消当前任务',exact:true})).toHaveCount(0);
  await expect(page.locator('#run [role=alert]')).toContainText('取消');await expect(result(page).locator('.result-summary')).toBeVisible();const after=await saveDownload(page,panel(page).getByRole('button',{name:'下载 report.json',exact:true}),path.join(root,'after-report.json'));expect(await fs.readFile(after)).toEqual(await fs.readFile(saved.report));
  await expect(page.getByLabel('左侧来源 CSV 文件')).toBeEnabled();await expect(page.getByRole('button',{name:'恢复 ZIP 工作包',exact:true})).toBeEnabled();
});

test('resource-limited comparison stays incomplete and exit 3 after UI review',async({page},testInfo)=>{
  const root=testInfo.outputPath('incomplete');await fs.mkdir(root,{recursive:true});const left=path.join(root,'left.csv'),right=path.join(root,'right.csv');
  const csv='id,label\n'+Array.from({length:101},(_,i)=>`${i+1},same\n`).join('');await fs.writeFile(left,csv);await fs.writeFile(right,csv);
  await openWorkbench(page);await page.getByLabel('左侧来源 CSV 文件').setInputFiles(left);await expect(page.locator('#imports')).toContainText('完整校验 101 行');await page.getByLabel('右侧来源 CSV 文件').setInputFiles(right);
  await expect(page.getByRole('button',{name:'从当前列生成空白草稿',exact:true})).toBeEnabled();await page.getByRole('button',{name:'从当前列生成空白草稿',exact:true}).click();
  const fields=page.locator('.field-card');await expect(fields).toHaveCount(2);for(let i=0;i<2;i++)await fields.nth(i).getByLabel('类型（必选）').selectOption('text');await fields.nth(0).getByLabel('参与逐行比较',{exact:true}).uncheck();
  const candidates=page.locator('#config details.config-group').filter({has:page.getByText('候选匹配（可选）',{exact:true})});await candidates.locator('summary').click();await page.getByLabel('启用候选规则',{exact:true}).check();
  // Native details stays open after enabling candidates and adding a row.
  await expect(candidates).toHaveJSProperty('open',true);const rows=candidates.locator('.editor-block').filter({has:page.getByRole('heading',{name:/^候选评分字段/})});await rows.getByRole('button',{name:'添加',exact:true}).click();await expect(candidates).toHaveJSProperty('open',true);
  await page.getByLabel('评分逻辑字段',{exact:true}).fill('label');await page.getByRole('combobox',{name:'指标',exact:true}).selectOption('exact');await page.getByLabel('权重（1–10000 严格整数）').fill('10000');await page.getByLabel('候选阈值（1–10000 严格整数）').fill('10000');await checkRules(page);await compare(page);
  await expect(result(page).locator('.result-summary')).toContainText('incomplete');await manual(page,'left_unmatched','L101','','明确核对');await applyPending(page);
  const evidence=await downloadEvidence(page,root);const report=JSON.parse(await fs.readFile(evidence.report));expect(report.exit_code).toBe(3);expect(report.computation.status).toBe('incomplete');expect(report.decisions).toHaveLength(1);
  expect(await fs.readFile(evidence.report)).toEqual(await cliOracle({left,right,...evidence,root:path.join(root,'cli')}));
});
