import { button, element } from './dom.mjs';
import { renderReviewView } from './review-view.mjs';

const COLLECTIONS = ['fields', 'candidates', 'records', 'issues', 'pairs', 'decisions'];
const FILTERS = {
  fields: [['status', '状态'], ['field', '逻辑字段'], ['left_id', '左侧记录 ID'], ['right_id', '右侧记录 ID']],
  candidates: [['left_id', '左侧记录 ID'], ['right_id', '右侧记录 ID'], ['suggested', '建议项 true/false']],
  records: [['side', '侧别 left/right'], ['status', '状态']],
};

export function renderResultView({ root, store, api, summary, onPublished, onSucceeded = () => {}, onPendingChange = () => {}, history = [], onSelectHistory, isCurrentHead = () => true }) {
  let disposed = false, activeJob = null, loading = false, collectionRoot, notice = '', evidenceExport = null, reviewActionControls = [];
  const revision = summary.revision, startGeneration = store.generation();
  const pages = new Map(COLLECTIONS.map(name => [name, { offset: 0, nextOffset: 0, hasMore: false, previousOffsets: [], limit: 20, filters: {}, items: [], total: 0, loaded: false, busy: false }]));
  let applied = [], pending = store.get().revision?.revision_id===revision.revision_id?(store.get().pending_decisions??[]).map(item=>({...item})):[], lockedPairs = new Set(), pairLockLoaded = false, imported = { left: null, right: null };
  const selected = () => !disposed && store.get().revision?.revision_id === revision.revision_id;
  const current = () => selected() && store.generation() === startGeneration;
  const headCurrent = () => typeof isCurrentHead === 'function' ? isCurrentHead(revision) : Boolean(isCurrentHead);
  const stale = () => !current() || store.get().stale || !headCurrent();
  const endpoint = collection => `/api/runs/${revision.revision_id}/${collection}`;
  const refreshReviewControls = () => {
    const commonDisabled = stale() || loading || Boolean(store.get().active_job);
    for (const control of root.querySelectorAll('.review-editor button,.review-editor input')) control.disabled = commonDisabled || !pairLockLoaded;
    for (const control of reviewActionControls) control.node.disabled = commonDisabled || (control.requiresLocks && !pairLockLoaded) || control.locked;
  };
  const syncPending=()=>{store.update({pending_decisions:pending.map(item=>({...item}))});onPendingChange(pending.map(item=>({...item})));};

  const render = () => {
    if (disposed) return;
    reviewActionControls = [];
    root.replaceChildren(element('h3', { text: `结果 revision ${revision.revision_id}${stale() ? ' · 旧版本（只读）' : ''}` }));
    if (stale()) root.append(element('p', { className: 'notice warning', role: 'status', text: '来源或规则已变化；此版本保留查看和导出，当前输入完成新比较前不可应用决定。' }));
    if (notice) root.append(element('p', { className: 'notice error', role: 'alert', text: notice }));
    if (evidenceExport) root.append(button('下载超出显示预算的完整证据 JSON', () => void download(evidenceExport, 'evidence.json'), { className: 'secondary' }));
    if (history.length > 1) {
      const versions = element('div', { className:'toolbar', role:'group', 'aria-label':'本会话历史版本' });
      versions.append(element('span',{text:'本会话版本：'}));
      for (const saved of history) versions.append(button(`${saved.revision_id.slice(0,8)}${saved.revision_id===revision.revision_id?'（当前查看）':''} · exit ${saved.exit_code}`,()=>void onSelectHistory(saved),{className:saved.revision_id===revision.revision_id?'':'secondary',disabled:saved.revision_id===revision.revision_id}));
      root.append(versions);
    }
    const c = summary.computation ?? {}, s = summary.summary ?? {};
    root.append(element('dl', { className: 'result-summary' }, [
      element('dt', { text: '计算状态' }), element('dd', { text: c.status ?? '未知' }),
      element('dt', { text: '退出码' }), element('dd', { text: revision.exit_code }),
      element('dt', { text: '左右配对 / 未匹配 / 待复核 / 未处理' }), element('dd', { text: JSON.stringify(s.per_side ?? {}) }),
      element('dt', { text: '字段相同 / 规则等价 / 不同 / 无效' }), element('dd', { text: JSON.stringify(s.fields ?? {}) }),
      element('dt', { text: '未解决记录 / 候选数量' }), element('dd', { text: `${s.unresolved_count ?? '—'} / ${s.candidate_count ?? '—'}` }),
      element('dt', { text: 'Result.structure' }), element('dd', { text: JSON.stringify(summary.structure ?? {}) }),
      element('dt', { text: 'Result.key_issues' }), element('dd', { text: JSON.stringify(summary.issues ?? []) }),
      element('dt', { text: 'computation.issues' }), element('dd', { text: JSON.stringify(c.issues ?? []) }),
    ]));
    root.append(element('div', { className: 'toolbar' }, [
      button('从原始比较新建分支', () => void branch(), { className: 'secondary', disabled: !headCurrent() || loading || Boolean(store.get().active_job) }),
    ]));
    collectionRoot = element('div', { className: 'result-collections' });
    for (const name of COLLECTIONS) collectionRoot.append(renderCollection(name));
    root.append(collectionRoot, renderReview());
    if (activeJob) root.append(element('p', { className: 'notice', role: 'status', text: `${activeJob.label}：${activeJob.phase ?? '处理中'}。` }), button('取消当前任务', () => void cancel(), { className: 'danger' }));
    refreshReviewControls();
  };

  function renderCollection(name) {
    const state = pages.get(name), box = element('section', { className: 'evidence-section' });
    const title = { fields: '字段差异及完整证据', candidates: '所有竞争候选与诊断', records: '记录状态与来源格值', issues: '键和结构问题', pairs: '已配对记录', decisions: '已应用决定（只读）' }[name];
    box.append(element('h4', { text: `${title}${state.loaded ? `（${state.total}）` : ''}` }));
    const controls = element('div', { className: 'toolbar' });
    for (const [key, caption] of FILTERS[name] ?? []) {
      const input = element('input', { type: 'text', value: state.filters[key] ?? '', placeholder: caption, 'aria-label': caption });
      input.addEventListener('change', () => { state.filters[key] = input.value; state.offset = 0;state.previousOffsets=[]; void loadCollection(name); });
      controls.append(input);
    }
    if (FILTERS[name]) box.append(controls);
    if (!state.loaded && !state.busy) box.append(button(`加载${title}`, () => void loadCollection(name), { className: 'secondary' }));
    if (state.busy) box.append(element('p', { text: '正在读取本版本证据…' }));
    const list = element('div', { className: 'evidence-list' });
    for (const { source_index, item } of state.items) {
      const card = element('article', { className: 'evidence-item' });
      card.append(element('h5', { text: `${name}[${source_index}]${item.status ? ` · ${item.status}` : ''}${item.field ? ` · ${item.field}` : ''}${item.left_id || item.right_id ? ` · ${item.left_id ?? ''}/${item.right_id ?? ''}` : item.id ?? ''}` }));
      card.append(element('pre', { text: JSON.stringify(item, null, 2) }));
      card.append(button('下载此项完整 JSON 证据', () => void download(`/api/runs/${revision.revision_id}/items/${name}/${source_index}/export`, `${name}-${source_index}.json`), { className: 'secondary' }));
      if (name === 'candidates') {
        const locked = lockedPairs.has(JSON.stringify([item.left_id, item.right_id]));
        const reason = element('input', { type: 'text', placeholder: '决定理由（候选外手工 accept 必填）', 'aria-label': `理由 ${item.left_id}/${item.right_id}` });
        const accept = button('accept 此配对', () => addPending('accept', item.left_id, item.right_id, reason.value), { className:'review-action candidate-review-action', disabled: stale() || loading || !pairLockLoaded || locked });
        const reject = button('reject 此配对', () => addPending('reject', item.left_id, item.right_id, reason.value), { className: 'secondary review-action candidate-review-action', disabled: stale() || loading || !pairLockLoaded || locked });
        reviewActionControls.push({ node: accept, locked, requiresLocks: true }, { node: reject, locked, requiresLocks: true });
        card.append(reason, accept, reject);
        if (locked) card.append(element('span', { className: 'notice', text: '此精确键配对已锁定，只读。' }));
      }
      if (name === 'records' && ['pending_review', 'unprocessed'].includes(item.status)) {
        const side = item.side;
        const reason = element('input', { type: 'text', placeholder: '决定理由（可交核心校验）', 'aria-label': `unmatched理由 ${item.id}` });
        const unmatched = button(side === 'left' ? 'left_unmatched' : 'right_unmatched', () => addPending(side === 'left' ? 'left_unmatched' : 'right_unmatched', side === 'left' ? item.id : null, side === 'right' ? item.id : null, reason.value), { className:'review-action', disabled: stale() || loading });
        reviewActionControls.push({ node: unmatched, locked: false, requiresLocks: false });
        card.append(reason, unmatched);
      }
      if (name === 'records') for (const column of imported[item.side]?.headers ?? []) card.append(button(`查看 ${column} 原值`, () => void showCell(item.side, item.record, column), { className: 'secondary' }));
      list.append(card);
    }
    box.append(list);
    if (state.loaded) {
      const nav = element('div', { className: 'pager' });
      nav.append(button('上一页', () => { state.offset = state.previousOffsets.pop() ?? 0; void loadCollection(name); }, { disabled: state.busy || state.previousOffsets.length === 0 }));
      nav.append(element('span', { text: `${state.offset + 1}–${Math.min(state.offset + state.items.length, state.total)} / ${state.total}` }));
      nav.append(button('下一页', () => { state.previousOffsets.push(state.offset); state.offset = state.nextOffset; void loadCollection(name); }, { disabled: state.busy || !state.hasMore }));
      box.append(nav);
    }
    return box;
  }

  function renderReview() {
    return renderReviewView({ pending, stale: stale(), busy: loading || Boolean(store.get().active_job) || !pairLockLoaded, onAdd: addPending, onApply: apply, refresh: () => { syncPending(); render(); } });
  }

  function addPending(action, left_id, right_id, reason) {
    if (stale() || loading || store.get().active_job) { notice = '来源或规则已变化，或任务尚未结束，不能向此版本添加决定。'; render(); return; }
    if (action === 'accept' && lockedPairs.has(JSON.stringify([left_id, right_id]))) { notice = '精确键配对已锁定。'; render(); return; }
    if (action === 'reject' && lockedPairs.has(JSON.stringify([left_id, right_id]))) { notice = '精确键配对已锁定。'; render(); return; }
    pending.push({ action, left_id: left_id || null, right_id: right_id || null, reason: reason ?? '' });syncPending(); notice = ''; render();
  }

  async function loadCollection(name) {
    const state = pages.get(name); if (state.busy || disposed) return;
    state.busy = true; const generation = store.generation(), selected = revision.revision_id;
    if (!state.loaded) render();
    try {
      const requestOffset=state.offset;
      const query = new URLSearchParams({ offset: String(requestOffset), limit: String(state.limit), ...Object.fromEntries(Object.entries(state.filters).filter(([,v]) => v !== '')) });
      const response = await api.request(`${endpoint(name)}?${query}`);
      if (disposed || selected !== revision.revision_id || selected !== store.get().revision?.revision_id || generation !== store.generation()) return;
      state.offset=response.offset;state.nextOffset=response.next_offset;state.hasMore=response.has_more;
      if(response.has_more&&!response.items.length)throw new Error('分页未前进，已停止以避免跳过或重复证据。');
      state.items = response.items; state.total = response.total; state.loaded = true;
      evidenceExport = null;
      if (name === 'decisions') applied = response.items.map(({item}) => item);
      if (name === 'candidates' && !response.items.length && response.total > 0) { state.offset = 0; }
    } catch (error) { notice = `读取${name}失败：${error.message}`; evidenceExport = error.message.match(/\/api\/runs\/[A-Za-z0-9_/?=&.-]+/)?.[0] ?? null; }
    finally { state.busy = false; if (!disposed) render(); }
  }

  async function allAppliedDecisions() {
    const all = []; let offset = 0, total = null;
    do {
      const generation = store.generation();
      const response = await api.request(`${endpoint('decisions')}?offset=${offset}&limit=100`);
      if (!selected() || generation !== store.generation()) throw new Error('选择的版本或来源已变化，已停止读取决定页。');
      if (total === null) total = response.total;
      all.push(...response.items.map(({item}) => item)); offset = response.next_offset;
      if (!response.items.length && offset < total) throw new Error('决定分页不完整，未提交累计 CSV。');
    } while (offset < total);
    return all;
  }

  async function loadReviewLocks() {
    const generation = store.generation(); let offset = 0, total = null; const found = new Set();
    try {
      do {
        const response = await api.request(`${endpoint('pairs')}?offset=${offset}&limit=100`);
        if (!selected() || generation !== store.generation()) return;
        if (total === null) total = response.total;
        for (const {item} of response.items) if (item.source === 'exact_key') found.add(JSON.stringify([item.left_id,item.right_id]));
        offset = response.next_offset;
        if (!response.items.length && offset < total) throw new Error('精确配对锁定信息分页不完整。');
      } while (offset < total);
      lockedPairs = found; pairLockLoaded = true; render();
    } catch (error) { notice = `无法完整读取精确配对锁定信息，复核操作暂不可用：${error.message}`; render(); }
  }

  async function apply(file = null) {
    if (stale() || loading || store.get().active_job) return;
    const pendingSnapshot = pending.map(decision => ({ ...decision }));
    loading = true; notice = ''; activeJob = { label: '版本化复核', phase: '读取全部已应用决定' };
    store.update({ active_job: { job_id: null, phase: '读取全部已应用决定', state: 'running' } });render();
    const generation = store.generation();
    let successRegistered = false;
    try {
      let decisionsAsset;
      if (file) decisionsAsset = await api.upload('decisions', file);
      else {
        const { buildCumulativeCsv } = await import('./review-model.mjs');
        const everyApplied = await allAppliedDecisions();
        if (generation !== store.generation() || !current()) throw new Error('来源或选中版本已变化，未提交决定。');
        const blob = new Blob([buildCumulativeCsv(everyApplied, pendingSnapshot)], { type: 'text/csv' });
        Object.defineProperty(blob, 'name', { value: 'decisions.csv' });
        decisionsAsset = await api.upload('decisions', blob);
      }
      if (generation !== store.generation() || !current()) throw new Error('来源或选中版本已变化，未提交决定。');
      const accepted = await api.request(endpoint('reviews'), { method: 'POST', body: { base_revision: revision.revision_id, decisions_asset_id: decisionsAsset.asset_id } });
      activeJob = { job_id: accepted.job_id, label: '版本化复核', phase: '核心 resolve' };store.update({active_job:{job_id:accepted.job_id,phase:'resolving',state:'running'}});render();
      const job = await api.waitJob(accepted.job_id);
      onSucceeded(revision, job.output.revision);
      successRegistered = true;
      if (generation !== store.generation() || !current()) throw new Error('复核已完成；新版本已登记到历史记录，但当前选择或输入已变化，未覆盖当前工作台。');
      pending = [];syncPending(); await onPublished(job.output.revision);
    } catch (error) { notice = formatTaskFailure(successRegistered ? '复核已成功，新版本已登记到历史；未覆盖当前选择或输入。' : '复核未发布；原报告与待应用动作保留。', error); }
    finally { loading = false; activeJob = null;if(store.get().active_job)store.update({active_job:null});render(); }
  }

  async function branch() {
    if (!headCurrent() || loading || store.get().active_job || !globalThis.confirm('新建分支会从本版本绑定的原始 CSV 与配置重新运行核心 compare，并清除已应用决定；当前工作台文件与规则将切回该版本输入。继续？')) return;
    loading = true; activeJob = { label: '从原始比较新建分支', phase: '核心 compare' }; notice = '';store.update({active_job:{job_id:null,phase:'从原始快照重新比较',state:'running'}});render(); const generation = store.generation();
    let successRegistered = false;
    try {
      const accepted = await api.request(`/api/runs/${revision.revision_id}/branch`, { method: 'POST', body: {} });
      activeJob = { job_id: accepted.job_id, label: '从原始比较新建分支', phase: '核心 compare' };store.update({active_job:{job_id:accepted.job_id,phase:'comparing',state:'running'}}); render();
      const job = await api.waitJob(accepted.job_id);
      onSucceeded(revision, job.output.revision);
      successRegistered = true;
      if (generation !== store.generation() || !selected()) throw new Error('分支比较已完成；新版本已登记到历史记录，但当前选择或输入已变化，未覆盖当前工作台。');
      pending = [];syncPending(); await onPublished(job.output.revision, { branch: true });
    } catch (error) { notice = formatTaskFailure(successRegistered ? '分支比较成功，新版本已登记到历史；未覆盖当前选择或输入。' : '分支未发布；原报告保留。', error); }
    finally { loading = false; activeJob = null;if(store.get().active_job)store.update({active_job:null}); render(); }
  }

  async function showCell(side, record, column) {
    if (loading || store.get().active_job) return;
    const generation = store.generation();
    const reservation = { job_id:null, phase:'读取来源格值', state:'running' };
    store.update({active_job:reservation});
    try {
      const xlsx=imported[side]?.format==='xlsx';
      const accepted = await api.request(`/api/runs/${revision.revision_id}/${xlsx?'source-cell':'cell'}`, { method: 'POST', body: { side, record, column } });
      reservation.job_id=accepted.job_id;
      const job = await api.waitJob(accepted.job_id);
      if (!selected() || generation !== store.generation()) return;
      const dialog = element('dialog');
      dialog.append(element('h3', { text: `${side} · 数据记录 ${record} · ${column}` }));
      if(xlsx){const cell=job.output.source_cell;dialog.append(element('p',{text:`原始工作簿：${cell.sheet_name} · ${cell.coordinate} · ${cell.cell_type} · ${cell.mode}`}),element('h4',{text:'存储的原值'}),element('pre',{text:cell.stored_value}),element('h4',{text:'导入后的原值'}),element('pre',{text:cell.imported_value}),element('p',{text:`数字格式：${cell.number_format}`}));}
      else dialog.append(element('pre', { text: job.output.cell.value }));
      dialog.append(button('关闭', () => dialog.close())); document.body.append(dialog); dialog.showModal();
    } catch (error) { notice = `单元格读取失败：${error.message}`; render(); }
    finally { if(store.get().active_job===reservation)store.update({active_job:null}); }
  }

  async function download(path, name) { try { const blob = await api.download(path), url = URL.createObjectURL(blob), a = element('a', { href: url, download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 0); } catch (error) { notice = error.message; render(); } }
  async function cancel() { if (activeJob?.job_id) try { await api.request(`/api/jobs/${activeJob.job_id}`, { method: 'DELETE' }); } catch (error) { notice = error.message; render(); } }
  async function bindImports() {
    const generation = store.generation();
    try {
      const [leftMeta, rightMeta] = await Promise.all([api.request(`/api/imports/${revision.left_import_id}`), api.request(`/api/imports/${revision.right_import_id}`)]);
      if (!selected() || generation !== store.generation()) return;
      imported = { left: leftMeta.import, right: rightMeta.import };
      if (!disposed) render();
    } catch (error) { notice = `原始导入信息不可读：${error.message}`; render(); }
  }
  let observedGeneration = startGeneration;
  let observedJob = store.get().active_job;
  const disposeSubscription = store.subscribe(() => { if (!disposed) { const generation=store.generation(),job=store.get().active_job,jobChanged=job!==observedJob;observedJob=job;if(generation!==observedGeneration){observedGeneration=generation;pending=[];syncPending();render();}else if(jobChanged)render();refreshReviewControls(); } });
  render();
  void bindImports();
  void loadReviewLocks();
  for (const name of COLLECTIONS) void loadCollection(name);
  const dispose = () => { disposed = true; disposeSubscription(); root.replaceChildren(); };
  dispose.refresh = render;
  return dispose;
}

export function formatTaskFailure(prefix, error) {
  const details = [];
  const code = typeof error?.code === 'string' ? error.code : error?.cancelled ? 'job_cancelled' : null;
  const phase = typeof error?.phase === 'string' ? error.phase : error?.job?.phase;
  const side = typeof error?.side === 'string' ? error.side : null;
  const record = Number.isSafeInteger(error?.record) && error.record > 0 ? error.record : null;
  const field = typeof error?.field === 'string' && error.field ? error.field : null;
  if (code) details.push(`错误码 ${code}`);
  if (phase) details.push(`阶段 ${phase}`);
  if (side) details.push(`侧别 ${side}`);
  if (record) {
    const csvRecord = ['invalid_csv', 'invalid_row_width', 'invalid_header', 'input_limit_exceeded'].includes(code);
    const decisionRow = phase === 'decisions' && ['invalid_decision', 'invalid_decision_schema', 'invalid_decision_action', 'decision_limit_exceeded', 'locked_exact_pair', 'conflicting_decisions', 'manual_override_needs_reason'].includes(code);
    const location = csvRecord ? 'CSV 逻辑记录（含表头）' : decisionRow ? '决定数据行' : '核心记录号';
    details.push(`${location} ${record}`);
  }
  if (field) details.push(`字段 ${field}`);
  const message = typeof error?.message === 'string' ? error.message : '任务失败';
  return `${prefix}${message}${details.length ? `（${details.join('；')}）` : ''}`;
}
