import { button, element, label } from './dom.mjs';

const MODES = [
  ['stored_text', '保留存储原值（文本）'],
  ['decimal_lexeme', '精确十进制文本'],
  ['excel_date', 'Excel 日期'],
  ['zero_padded_identifier', '按零格式补齐标识符'],
];
const MODE_NAMES = Object.fromEntries(MODES);
const COUNT_NAMES = { blank:'空白单元格', text:'文本单元格', numeric_lexemes:'数值词法单元格', expanded_exponents:'展开指数数值', booleans:'布尔值', dates:'日期', zero_padded_identifiers:'补零标识符' };

function jobStatus(output) { return output?.output ?? output; }
function columnName(number) {
  let result = '', value = number;
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}
function warningName(code) {
  return ({
    hidden_rows_included: '所选范围包含隐藏行', filtered_rows_included: '所选范围包含筛选结果中的行（不重新执行筛选）',
    outside_range_value_cells: '范围外还有有值单元格', outside_range_merges: '范围外还有合并单元格',
    rich_text_formatting_ignored: '忽略了富文本格式',
  })[code] ?? code;
}

// ErrorDTO phase identifies the location domain; the upload extension does not.
export function importErrorLocation(error) {
  if (error.phase === 'xlsx') {
    if (error.record == null && error.field == null) return '工作簿级别失败（服务未提供具体位置）。';
    return `工作表物理位置：${error.record != null ? `第 ${error.record} 行` : ''}${error.field != null ? `${error.record != null ? '，' : ''}单元格 ${error.field}` : ''}。修正后重新导入。`;
  }
  return error.record != null ? `错误位置：含表头的逻辑记录 ${error.record}${error.field != null ? `，字段 ${error.field}` : ''}。修正后重新选择文件。预览数据行号不包含表头。` : '';
}

export function renderXlsxSelection({ root, api, asset, side, onConfirmed, onCancel, onTaskState = () => {} }) {
  let disposed = false, busy = false, workbook = null, converted = null, issue = '';
  const sideName = side === 'left' ? '左侧' : '右侧';
  const dialog = element('dialog', { className: 'xlsx-selection' });
  document.body.append(dialog);
  const selection = { sheet: null, header: null, start: null, end: null, last: null, modes: [] };
  const render = () => {
    if (disposed) return;
    dialog.replaceChildren(element('h2', { text: `${sideName} XLSX 导入选择` }));
    dialog.append(element('p', { className: 'notice', text: '先选择一张可见工作表、矩形范围和每列转换方式。每次转换都绑定到原始工作簿 SHA-256；公式策略固定为拒绝。' }));
    dialog.append(element('p', { className: 'source-meta', text: `原始文件：${asset.name} · ${asset.bytes.toLocaleString()} 字节` }));
    dialog.append(element('p', { className: 'source-meta', text: `原始文件 SHA-256：${asset.sha256}` }));
    if (issue) dialog.append(element('p', { className: 'notice error', role: 'alert', text: `${issue.label}（${issue.error.code ?? '错误'}）：${issue.error.message} ${importErrorLocation(issue.error)}` }));
    if (!workbook && !issue) {
      dialog.append(element('p', { className: 'notice', role: 'status', text: '正在读取工作簿清单…' }));
    } else if (workbook && !converted) {
      const sheet = element('select', { disabled: busy }, [
        element('option', { value: '', text: '请选择工作表（无默认项）' }),
        ...workbook.sheets.map(item => element('option', { value: item.sheet_id, disabled: !item.selectable, text: `${item.name} · ${item.state} · ${item.kind}${item.selectable ? '' : '（不可选）'}` })),
      ]);
      sheet.setAttribute('aria-label', '工作表'); sheet.value = selection.sheet ?? '';
      sheet.addEventListener('change', () => { selection.sheet = sheet.value || null; selection.modes = []; render(); });
      dialog.append(label('工作表', sheet));
      const current = workbook.sheets.find(item => item.sheet_id === selection.sheet);
      const range = element('div', { className: 'form-grid xlsx-range' });
      for (const [key, title, min, max] of [['header','标题行',1,1048576],['start','起始列',1,16384],['end','结束列',1,16384],['last','最后一行',1,1048576]]) {
        const input = element('input', { type: 'text', inputmode: 'numeric', value: selection[key] ?? '', placeholder: '手动输入；无默认项', disabled: busy || !current, 'aria-label': title });
        input.addEventListener('input', () => { selection[key] = input.value; selection.modes = []; });
        range.append(label(title, input));
      }
      dialog.append(range);
      dialog.append(button('更新范围和转换方式', () => { selection.modes = []; render(); }, { className: 'secondary', disabled: busy || !current }));
      const start = Number(selection.start), end = Number(selection.end), width = end - start + 1;
      const modes = element('div', { className: 'xlsx-modes' });
      if (current && Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && width <= 256) {
        while (selection.modes.length < width) selection.modes.push('');
        selection.modes.length = width;
        for (let index = 0; index < width; index += 1) {
          const col = start + index, select = element('select', { disabled: busy }, [element('option', { value: '', text: '请选择转换方式（必选）' }), ...MODES.map(([value,text]) => element('option', { value, text }))]);
          select.setAttribute('aria-label', `第 ${col} 列转换方式`); select.value = selection.modes[index] ?? '';
          select.addEventListener('change', () => { selection.modes[index] = select.value; render(); });
          modes.append(label(`第 ${col} 列 · ${columnName(col)}`, select));
        }
      }
      dialog.append(element('fieldset', { className: 'xlsx-mode-fieldset', disabled: busy || !current }, [element('legend', { text: '每列的转换方式' }), modes]));
      const header = Number(selection.header), last = Number(selection.last);
      const valid = current?.selectable && Number.isInteger(header) && Number.isInteger(start) && Number.isInteger(end) && Number.isInteger(last) && header >= 1 && header <= 1048576 && start >= 1 && end >= start && end <= 16384 && width <= 256 && last >= header && last <= 1048576 && last - header <= 100000 && selection.modes.length === width && selection.modes.every(mode => MODES.some(([known]) => known === mode));
      const summary = valid ? `将导入 ${current.name}!${columnName(start)}${header}:${columnName(end)}${last}；${width} 列均已明确选择转换方式。空白数据行会保留在行映射中。` : '请完成工作表、标题行、列范围、最后一行和每列转换方式。数值范围受工作表格式上限约束。';
      dialog.append(element('p', { className: 'notice xlsx-spec-summary', role: 'note', text: summary }));
      dialog.append(button(busy ? '正在转换…' : '检查选择并转换', () => { if (valid) void convert({ current, header, start, end, last, width }); }, { disabled: busy || !valid }));
    } else if (converted) {
      dialog.append(element('h3', { tabindex: '-1', text: '转换完成；请检查摘要后再绑定来源' }));
      dialog.append(element('p', { text: `工作表 ${converted.manifest.worksheet.name} · 日期系统 ${converted.manifest.worksheet.date_system} · ${converted.manifest.row_mapping.row_count} 条数据记录 × ${converted.preview.column_count} 列` }));
      dialog.append(element('p', { text: `原始文件 SHA-256：${asset.sha256}` }));
      dialog.append(element('p', { text: `规范 CSV SHA-256：${converted.import.sha256}` }));
      dialog.append(element('h4', { text: '转换计数' }));
      dialog.append(element('ul', {}, Object.entries(converted.manifest.conversion_counts).map(([code,count]) => element('li', { text: `${COUNT_NAMES[code] ?? code}：${count}` }))));
      dialog.append(element('p', { text: '导入后的原值（逐列模式）' }));
      dialog.append(element('ul', {}, converted.importSpec.columns.map(column => element('li', { text: `${columnName(column.column)}：${MODE_NAMES[column.mode]}（${column.mode}）` }))));
      dialog.append(element('h4', { text: '转换警告' }));
      dialog.append(converted.manifest.warnings.length ? element('ul', {}, converted.manifest.warnings.map(item => element('li', { text: `${warningName(item.code)} · ${item.code}：${item.count}` }))) : element('p', { className: 'notice success', text: '此范围没有转换警告。' }));
      dialog.append(element('p', { text: `行映射：物理第 ${converted.manifest.row_mapping.header_row} 行作为表头；数据从物理第 ${converted.manifest.row_mapping.data_first_row} 行开始，共 ${converted.manifest.row_mapping.row_count} 条（空白记录保留）。列 ${columnName(converted.manifest.row_mapping.column_start)}–${columnName(converted.manifest.row_mapping.column_end)}。` }));
      dialog.append(button('绑定为' + sideName + '来源', () => {
        if (busy || !globalThis.confirm(`确认将 ${asset.name} 的工作表 ${converted.manifest.worksheet.name} 转换结果绑定为${sideName}来源？原始文件与规范 CSV 哈希已分别显示。`)) return;
        busy = true; render();
        Promise.resolve(onConfirmed({ ...converted, asset, profile: { import_spec: converted.importSpec }, label: asset.name }))
          .then(() => dispose())
          .catch(error => { busy = false; issue = { label: '来源未替换', error }; render(); });
      }, { disabled: busy }));
      dialog.append(button('修改选择并重新转换', () => { converted = null; issue = ''; selection.modes = []; render(); }, { className: 'secondary', disabled: busy }));
    }
    dialog.append(button('取消并保留当前来源', () => { if (!busy) { onCancel(); dispose(); } }, { className: 'secondary', disabled: busy }));
    if (converted) { dialog.scrollTop = 0; dialog.querySelector('h3')?.focus({ preventScroll: true }); }
  };
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (busy) return;
    onCancel(); dispose();
  });
  async function waitFor(route, body) {
    onTaskState({ job_id: null, phase: '正在提交 XLSX 任务', state: 'running' });
    try { const accepted = await api.request(route, { method: 'POST', body }); onTaskState({ job_id: accepted.job_id, phase: '正在读取或转换 XLSX', state: 'running' }); return jobStatus(await api.waitJob(accepted.job_id)); }
    finally { onTaskState(null); }
  }
  async function convert({ current, header, start, end, last, width }) {
    const importSpec = { schema_version: 1, source_sha256: asset.sha256, sheet_id: current.sheet_id, header_row: header, column_start: start, column_end: end, last_row: last, columns: selection.modes.map((mode,index) => ({ column: start + index, mode })), formula_policy: 'reject' };
    const rectangle = `${current.name}!${columnName(start)}${header}:${columnName(end)}${last}`;
    if (!globalThis.confirm(`转换前确认：${rectangle}，${width} 列的模式已逐列选择。公式固定拒绝，空白行保留。提交转换？`)) return;
    busy = true; issue = ''; render();
    try {
      const result = await waitFor('/api/imports', { asset_id: asset.asset_id, side, import_spec: importSpec });
      const manifestBlob = await api.download(`/api/imports/${result.import.import_id}/materials/export?kind=manifest`);
      const manifest = JSON.parse(await manifestBlob.text());
      if (manifest.source.sha256 !== asset.sha256 || manifest.canonical_csv.sha256 !== result.import.sha256 || manifest.row_mapping.header_row !== header || manifest.row_mapping.column_start !== start || manifest.row_mapping.column_end !== end || manifest.row_mapping.row_count !== result.preview.row_count) throw new Error('转换清单与本次选择或导入结果不一致。');
      converted = { import: result.import, preview: result.preview, importSpec, manifest };
    } catch (error) { issue = { label: 'XLSX 转换失败', error }; }
    finally { busy = false; render(); }
  }
  async function catalog() {
    try { const output = await waitFor('/api/xlsx/catalog', { asset_id: asset.asset_id }); workbook = output.workbook; }
    catch (error) { issue = { label: '工作簿清单读取失败', error }; }
    finally { render(); }
  }
  function dispose() { if (disposed) return; disposed = true; dialog.close?.(); dialog.remove(); }
  render(); dialog.showModal(); void catalog();
  return { dispose };
}
