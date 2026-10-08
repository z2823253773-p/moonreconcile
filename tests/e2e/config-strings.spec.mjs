import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import {startWorkbench} from '../../workbench/server.mjs';
import {loadBridgeInvoke} from '../../cli/bridge.mjs';

let app;
test.beforeEach(async()=>{app=await startWorkbench();});
test.afterEach(async()=>{await app?.close();app=null;});
const escaped=s=>JSON.stringify(s).slice(1,-1);
const lines=items=>items.map(s=>s===''?'\\e':escaped(s)).join('\n');
const csvCell=s=>'"'+s.replaceAll('"','""')+'"';
async function open(page){try{await page.goto(`${app.origin}/#token=${app.token}`);}catch(error){error.message=error.message.replaceAll(app.token,'[redacted]');if(error.stack)error.stack=error.stack.replaceAll(app.token,'[redacted]');throw error;}await expect(page.getByRole('heading',{name:'MoonReconcile 工作台'})).toBeVisible();await expect.poll(()=>page.evaluate(()=>location.hash==='')).toBe(true);}
async function sources(page,headers){const buffer=Buffer.from(headers.map(csvCell).join(',')+'\n'+headers.map(()=> 'v').join(',')+'\n');for(const side of ['左','右']){await page.getByLabel(`${side}侧来源 CSV 文件`).setInputFiles({name:'developer-synthetic.csv',mimeType:'text/csv',buffer});await expect(page.getByLabel(`${side}侧来源 CSV 文件`)).toBeEnabled();}}
async function check(page){await page.getByRole('button',{name:'校验并保存规则',exact:true}).click();await expect(page.getByRole('button',{name:'导出已校验配置',exact:true})).toBeEnabled();}
async function download(page,info,name){const pending=page.waitForEvent('download');await page.getByRole('button',{name:'导出已校验配置',exact:true}).click();const file=info.outputPath(name);await (await pending).saveAs(file);return fs.readFile(file,'utf8');}
async function importConfig(page,config){await page.getByLabel('导入配置 JSON').setInputFiles({name:'developer-config.json',mimeType:'application/json',buffer:Buffer.from(typeof config==='string'?config:JSON.stringify(config))});await expect(page.getByRole('button',{name:'导出已校验配置',exact:true})).toBeEnabled();}
const block=(card,title)=>card.locator('section.editor-block').filter({has:card.page().getByRole('heading',{name:new RegExp(`^${title}`)})});

test('lossless Config strings: actual browser import, edit, save and reimport preserve LF CR CRLF and backslashes',async({page},info)=>{
  const invoke=await loadBridgeInvoke();
  const names=['LF\nfield','CR\rfield','CRLF\r\nfield'],ignored=['LF\nignored','CR\rignored','CRLF\r\nignored'];
  const map=JSON.parse('{"__proto__":"proto","constructor":"constructor value","toString":"string value","":"empty key","10":"ten","2":"two"}');map['literal\\n']='line\nvalue';map['key\r\nvalue']='value\r\nend';
  const config={schema_version:1,fields:names.map(name=>({name,left:name,right:name,type:'text',left_values:map,right_values:map,missing:['','missing\nLF','missing\rCR','missing\r\nCRLF','literal\\n']})),key:[names[0]],ignore_left:ignored,ignore_right:ignored,candidates:{fields:names.map(field=>({field,metric:'exact',weight:1})),threshold:1,blocking:[names,[],['']]}};
  // Empty blocking references are invalid in core, tested independently as UI draft below.
  config.candidates.blocking=[names];
  const canonical=JSON.parse(invoke(JSON.stringify({op:'check_config',config})));expect(canonical.ok).toBe(true);
  await open(page);await sources(page,[...names,...ignored]);await importConfig(page,config);
  const imported=JSON.parse(await download(page,info,'untouched.json'));expect(imported).toEqual(canonical.config);
  const cards=page.locator('.field-card');
  await fs.writeFile(info.outputPath('map-row-order.json'),JSON.stringify({coreKeys:Object.keys(canonical.config.fields[0].left_values),assetKeys:Object.keys(imported.fields[0].left_values),domKeys:await block(cards.first(),'左侧值映射').getByLabel('原值',{exact:true}).evaluateAll(nodes=>nodes.map(node=>node.value))},null,2));
  for(let i=0;i<3;i++){
    await expect(cards.nth(i).getByLabel('逻辑字段名',{exact:true})).toHaveValue(escaped(names[i]));
    for(const side of ['左','右'])await expect(cards.nth(i).getByRole('combobox',{name:`${side}侧来源列`,exact:true})).toHaveValue(names[i]);
  }
  await page.getByText('候选匹配（可选）',{exact:true}).click();
  for(let i=0;i<3;i++)await expect(page.getByLabel('评分逻辑字段',{exact:true}).nth(i)).toHaveValue(escaped(names[i]));
  await expect(page.getByLabel('主键字段（每行一项）',{exact:true})).toHaveValue(lines([names[0]]));
  await expect(page.getByLabel('忽略左侧列（每行一项）',{exact:true})).toHaveValue(lines(ignored));
  await expect(page.getByLabel('分组 1 字段',{exact:true})).toHaveValue(lines(names));
  const edited=structuredClone(canonical.config),newNames=names.map(n=>n+'\\edited');
  for(let i=0;i<3;i++){
    await cards.nth(i).getByLabel('逻辑字段名',{exact:true}).fill(escaped(newNames[i]));edited.fields[i].name=newNames[i];
    for(const side of ['左','右'])await cards.nth(i).getByRole('combobox',{name:`${side}侧来源列`,exact:true}).selectOption({value:names[i]});
    for(const [title,key] of [['左侧值映射','left_values'],['右侧值映射','right_values']]){
      const rows=block(cards.nth(i),title).locator('.map-row');
      for(let j=0;j<await rows.count();j++){
        // The HTTP asset is canonicalized independently of direct bridge JSON key insertion order.
        const original=Object.keys(imported.fields[i][key])[j];
        await expect(rows.nth(j).getByLabel('原值',{exact:true})).toHaveValue(escaped(original));
        await expect(rows.nth(j).getByLabel('映射为',{exact:true})).toHaveValue(escaped(edited.fields[i][key][original]));
        const changed=edited.fields[i][key][original]+'\r\n\\n',newKey=original.includes('\\')||original.includes('\r')?original+'\n':original;
        await rows.nth(j).getByLabel('原值',{exact:true}).fill(escaped(newKey));await rows.nth(j).getByLabel('映射为',{exact:true}).fill(escaped(changed));delete edited.fields[i][key][original];Object.defineProperty(edited.fields[i][key],newKey,{value:changed,writable:true,enumerable:true,configurable:true});
      }
    }
    const missing=cards.nth(i).getByLabel('缺失标记值',{exact:true});
    for(let j=0;j<5;j++){await expect(missing.nth(j)).toHaveValue(escaped(edited.fields[i].missing[j]));if(j>0)edited.fields[i].missing[j]+='\r\n\\n';await missing.nth(j).fill(escaped(edited.fields[i].missing[j]));}
    await page.getByLabel('评分逻辑字段',{exact:true}).nth(i).fill(escaped(newNames[i]));edited.candidates.fields[i].field=newNames[i];
  }
  await page.getByLabel('主键字段（每行一项）',{exact:true}).fill(lines([newNames[0]]));edited.key=[newNames[0]];
  for(const side of ['左','右'])await page.getByLabel(`忽略${side}侧列（每行一项）`,{exact:true}).fill(lines(ignored));
  await page.getByLabel('分组 1 字段',{exact:true}).fill(lines(newNames));edited.candidates.blocking=[newNames];
  await check(page);
  const saved=await download(page,info,'edited.json');const expected=JSON.parse(invoke(JSON.stringify({op:'check_config',config:edited})));expect(expected.ok).toBe(true);expect(JSON.parse(saved)).toEqual(expected.config);
  await importConfig(page,saved);expect(await download(page,info,'reimported.json')).toBe(saved);
  await page.getByRole('button',{name:'运行核心比较',exact:true}).click();await expect(page.locator('.result-summary')).toBeVisible();
  await fs.writeFile(info.outputPath('observations.json'),JSON.stringify({synthetic:true,browser:page.context().browser().version(),canonical:expected.config,core_check:true,core_compare:true},null,2));
});

test('blank multiline form creates encoded scalar map missing and references without JSON editing',async({page},info)=>{
  const name='id\r\nline',ignored='unused\rcolumn';await open(page);await sources(page,[name,ignored]);
  await page.getByRole('button',{name:'从当前列生成空白草稿',exact:true}).click();const cards=page.locator('.field-card');await expect(cards).toHaveCount(2);await cards.last().getByRole('button',{name:'删除字段',exact:true}).click();
  await cards.first().getByLabel('逻辑字段名',{exact:true}).fill('created\\nname');await cards.first().getByLabel('类型（必选）').selectOption('text');
  for(const side of ['左','右'])await cards.first().getByRole('combobox',{name:`${side}侧来源列`,exact:true}).selectOption({value:name});
  const mapping=block(cards.first(),'左侧值映射');await mapping.getByRole('button',{name:'添加',exact:true}).click();await mapping.getByLabel('原值',{exact:true}).fill('literal\\\\n');await mapping.getByLabel('映射为',{exact:true}).fill('value\\r\\nnext');
  await mapping.getByRole('button',{name:'添加',exact:true}).click();await mapping.getByLabel('原值',{exact:true}).last().fill('__proto__');await mapping.getByLabel('映射为',{exact:true}).last().fill('created\\nprototype');
  const missing=block(cards.first(),'缺失标记');await missing.getByRole('button',{name:'添加',exact:true}).click();await expect(missing.getByLabel('缺失标记值')).toHaveValue('');
  await page.getByLabel('主键字段（每行一项）').fill('created\\nname');for(const side of ['左','右'])await page.getByLabel(`忽略${side}侧列（每行一项）`).fill('unused\\rcolumn');
  await page.getByText('候选匹配（可选）',{exact:true}).click();await page.getByLabel('启用候选规则').check();
  const details=page.locator('details').filter({has:page.getByText('候选匹配（可选）',{exact:true})});await expect(details).toHaveJSProperty('open',true);
  await block(details,'候选评分字段').getByRole('button',{name:'添加',exact:true}).click();await expect(details).toHaveJSProperty('open',true);
  await fs.writeFile(info.outputPath('candidate-accessible-dom.txt'),await details.ariaSnapshot());
  await fs.writeFile(info.outputPath('candidate-label-dom.json'),JSON.stringify(await details.locator('label').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,html:node.outerHTML}))),null,2));
  await page.getByLabel('评分逻辑字段').fill('created\\nname');await page.getByRole('combobox',{name:'指标',exact:true}).selectOption('exact');
  await page.getByRole('button',{name:'添加 Blocking 分组'}).click();await expect(details).toHaveJSProperty('open',true);
  await page.getByLabel('分组 1 字段').fill('created\\nname');await check(page);
  const saved=JSON.parse(await download(page,info,'created.json'));expect(saved.fields[0].name).toBe('created\nname');expect(saved.fields[0].left).toBe(name);expect(saved.fields[0].left_values).toEqual(JSON.parse('{"literal\\\\n":"value\\r\\nnext","__proto__":"created\\nprototype"}'));expect(saved.fields[0].missing).toEqual(['']);expect(saved.key).toEqual(['created\nname']);expect(saved.ignore_left).toEqual([ignored]);expect(saved.candidates.blocking).toEqual([['created\nname']]);
});

test('candidate details remains open through add delete pagination and validation renders',async({page})=>{
  const fields=Array.from({length:51},(_,i)=>({name:`f${i}`,left:`f${i}`,right:`f${i}`,type:'text'}));
  await open(page);await sources(page,fields.map(f=>f.name));await importConfig(page,{schema_version:1,fields,key:[],candidates:{fields:fields.map(f=>({field:f.name,metric:'exact',weight:1})),threshold:1,blocking:[]}});
  await page.getByText('候选匹配（可选）',{exact:true}).click();const details=page.locator('details').filter({has:page.getByText('候选匹配（可选）',{exact:true})});
  const scoring=block(details,'候选评分字段');await scoring.getByRole('button',{name:'下一页',exact:true}).click();await expect(details).toHaveJSProperty('open',true);
  await scoring.getByRole('button',{name:'添加',exact:true}).click();await expect(details).toHaveJSProperty('open',true);
  await scoring.getByRole('button',{name:'删除评分字段',exact:true}).last().click();await expect(details).toHaveJSProperty('open',true);
  await scoring.getByRole('button',{name:'上一页',exact:true}).click();await expect(details).toHaveJSProperty('open',true);await check(page);await expect(details).toHaveJSProperty('open',true);
});

test('idle reminder waits 30 minutes, resets on real input and leaves work usable',async({page})=>{
  await page.clock.install();await open(page);await sources(page,['id']);await page.getByRole('button',{name:'从当前列生成空白草稿',exact:true}).click();await expect(page.locator('.field-card')).toHaveCount(1);
  await page.clock.fastForward(29*60*1000);await expect(page.locator('.idle-reminder')).toHaveCount(0);
  await page.getByLabel('逻辑字段名',{exact:true}).fill('kept-rule');await page.getByLabel('类型（必选）').selectOption('text');
  await page.clock.fastForward(29*60*1000);await expect(page.locator('.idle-reminder')).toHaveCount(0);
  await page.clock.fastForward(60*1000);await expect(page.locator('.idle-reminder')).toBeVisible({timeout:1500});await expect(page.getByLabel('逻辑字段名',{exact:true})).toHaveValue('kept-rule');await expect(page.getByRole('button',{name:'校验并保存规则',exact:true})).toBeEnabled();
  await page.getByLabel('逻辑字段名',{exact:true}).fill('still-kept');await expect(page.locator('.idle-reminder')).toHaveCount(0);await page.clock.fastForward(30*60*1000);await expect(page.locator('.idle-reminder')).toBeVisible();await expect(page.getByLabel('逻辑字段名',{exact:true})).toHaveValue('still-kept');
  await check(page);await expect(page.locator('.idle-reminder')).toHaveCount(0);
});

test('invalid escape drafts survive native rerenders and pagination, follow retained rows and clear with deleted controls',async({page},info)=>{
  const fields=Array.from({length:51},(_,i)=>({name:`f${i}`,left:`f${i}`,right:`f${i}`,type:'text',missing:i===0?Array.from({length:51},(_,j)=>`missing-${j}`):[]}));
  const config={schema_version:1,fields,key:[],candidates:{fields:[{field:'f0',metric:'exact',weight:1}],threshold:1,blocking:[['f0'],['f1']]}};
  await open(page);await sources(page,fields.map(f=>f.name));await importConfig(page,config);
  const save=page.getByRole('button',{name:'校验并保存规则',exact:true}),cards=page.locator('.field-card');
  await cards.first().getByLabel('逻辑字段名',{exact:true}).fill('unfinished\\');await expect(save).toBeDisabled();
  await sources(page,fields.map(f=>f.name));await expect(cards.first().getByLabel('逻辑字段名',{exact:true})).toHaveValue('unfinished\\');await expect(save).toBeDisabled();
  const logical=block(page.locator('#config'),'逻辑字段').locator(':scope > .pager');await logical.getByRole('button',{name:'下一页',exact:true}).click();await expect(save).toBeDisabled();await logical.getByRole('button',{name:'上一页',exact:true}).click();
  await expect(cards.first().getByLabel('逻辑字段名',{exact:true})).toHaveValue('unfinished\\');await cards.first().getByLabel('逻辑字段名',{exact:true}).fill('f0');
  const missing=block(cards.first(),'缺失标记');await missing.getByRole('button',{name:'下一页',exact:true}).click();await missing.getByLabel('缺失标记值').fill('bad\\u');
  await missing.getByRole('button',{name:'上一页',exact:true}).click();await missing.getByRole('button',{name:'删除缺失标记',exact:true}).first().click();
  await expect(missing.getByLabel('缺失标记值',{exact:true}).last()).toHaveValue('bad\\u');await expect(save).toBeDisabled();
  await missing.getByRole('button',{name:'删除缺失标记',exact:true}).last().click();await expect(save).toBeEnabled();
  await page.getByText('候选匹配（可选）',{exact:true}).click();await page.getByLabel('分组 2 字段',{exact:true}).fill('bad\\');await page.getByRole('button',{name:'删除分组',exact:true}).first().click();
  await expect(page.getByLabel('分组 1 字段',{exact:true})).toHaveValue('bad\\');await expect(save).toBeDisabled();await page.getByRole('button',{name:'删除分组',exact:true}).click();await expect(save).toBeEnabled();
  await page.getByLabel('评分逻辑字段',{exact:true}).fill('bad\\');await page.getByRole('button',{name:'添加 Blocking 分组',exact:true}).click();await page.getByLabel('分组 1 字段',{exact:true}).fill('bad\\');await expect(save).toBeDisabled();
  await page.getByLabel('启用候选规则',{exact:true}).uncheck();await expect(save).toBeEnabled();
  // Empty reference item is submitted as [""], not silently rewritten to [].
  await page.getByLabel('主键字段（每行一项）',{exact:true}).fill('\\e');await save.click();await expect(page.locator('#config').getByRole('alert')).toContainText('invalid_config');await expect(page.getByLabel('主键字段（每行一项）',{exact:true})).toHaveValue('\\e');
  await page.getByLabel('主键字段（每行一项）',{exact:true}).fill('');await check(page);
  const saved=JSON.parse(await download(page,info,'deleted-drafts.json'));expect(saved.fields[0].name).toBe('f0');expect(saved.fields[0].missing).toEqual(Array.from({length:49},(_,j)=>`missing-${j+1}`));expect(saved.key).toEqual([]);expect(saved.candidates).toBeNull();
});
