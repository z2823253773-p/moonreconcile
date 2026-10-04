import { button, element, label } from './dom.mjs';

export function renderReviewView({ pending, stale, busy, onAdd, onApply, refresh }) {
  const box = element('section', { className: 'review-editor' }); box.append(element('h4', { text: '版本化人工复核' }));
  box.append(element('p', { text: '建议分数只用于排序线索，不代表概率，也不会自动接受。已应用动作只读；新增动作先进入待应用区，整批交核心校验。理由由核心按决定类型和候选关系校验。' }));
  const form = element('div', { className: 'form-grid' });
  const action = element('select', {}, [['accept','accept'],['reject','reject'],['left_unmatched','left_unmatched'],['right_unmatched','right_unmatched']].map(([value,text]) => element('option',{value,text})));
  const left = element('input', { type: 'text', placeholder: 'left_id（可空）', 'aria-label': '手工 left_id' });
  const right = element('input', { type: 'text', placeholder: 'right_id（可空）', 'aria-label': '手工 right_id' });
  const reason = element('input', { type: 'text', placeholder: '填写决定理由', 'aria-label': '手工决定理由' });
  form.append(label('动作', action), label('左侧 ID', left), label('右侧 ID', right), label('理由', reason), button('添加手工决定', () => onAdd(action.value, left.value, right.value, reason.value), { disabled: stale || busy }));
  box.append(form);
  const pendingList = element('div', { className: 'decision-list' });
  pending.forEach((decision, index) => pendingList.append(element('div', { className: 'decision-row' }, [element('pre', { text: JSON.stringify(decision) }), button('移除待应用动作', () => { pending.splice(index, 1); refresh(); }, { className: 'danger', disabled: stale || busy })])));
  box.append(element('h5', { text: `待应用（${pending.length}）` }), pendingList);
  const file = element('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': '导入累计决定 CSV', disabled: stale || busy });
  file.addEventListener('change', () => { if (file.files?.[0]) void onApply(file.files[0]); });
  box.append(label('上传累计决定 CSV（交核心解析和冲突校验）', file));
  box.append(button(busy ? '正在应用…' : '应用待处理决定', () => void onApply(), { disabled: stale || busy || !pending.length }));
  return box;
}
