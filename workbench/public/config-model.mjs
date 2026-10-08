const record = (entries = []) => {
  const value = Object.create(null);
  for (const [key, item] of entries) Object.defineProperty(value, key, { value: item, enumerable: true, configurable: true, writable: true });
  return value;
};

const strictInteger = (value) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : String(value);
  const text = String(value ?? '0');
  if (!/^\d+$/.test(text)) return text;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : text;
};

export function configToForm(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('配置必须是对象');
  const mapRows = (value) => Object.keys(value ?? {}).map((key) => ({ key, value: value[key] }));
  return {
    schema_version: config.schema_version ?? 1,
    draft: config.draft ?? false,
    fields: (config.fields ?? []).map((field) => ({
      name: field.name ?? '', left: field.left ?? '', right: field.right ?? '', type: field.type ?? '',
      compare: field.compare ?? true, trim_ascii: field.trim_ascii ?? false, lower_ascii: field.lower_ascii ?? false,
      left_values: mapRows(field.left_values), right_values: mapRows(field.right_values),
      missing: [...(field.missing ?? [])], both_missing: field.both_missing ?? 'equal',
      abs_tol: field.abs_tol ?? '0', rel_tol: field.rel_tol ?? '0', days_tol: field.days_tol ?? 0,
    })),
    key: [...(config.key ?? [])], ignore_left: [...(config.ignore_left ?? [])], ignore_right: [...(config.ignore_right ?? [])],
    candidates: config.candidates == null ? null : {
      fields: (config.candidates.fields ?? []).map((candidate) => ({ field: candidate.field ?? '', metric: candidate.metric ?? '', weight: candidate.weight ?? 1 })),
      threshold: config.candidates.threshold ?? 1,
      blocking: (config.candidates.blocking ?? []).map((group) => [...group]),
    },
  };
}

export function formToConfig(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new TypeError('表单模型必须是对象');
  const mapObject = (rows, label) => {
    const pairs = new Map();
    for (const entry of rows ?? []) {
      const key = String(entry.key ?? '');
      if (pairs.has(key)) throw new TypeError(`${label}存在重复键：${key}`);
      pairs.set(key, String(entry.value ?? ''));
    }
    return record(pairs);
  };
  const fields = (model.fields ?? []).map((field) => ({
    name: String(field.name ?? ''), left: field.left === '' ? null : String(field.left ?? ''),
    right: field.right === '' ? null : String(field.right ?? ''), type: field.type === '' ? null : String(field.type ?? ''),
    compare: Boolean(field.compare), trim_ascii: Boolean(field.trim_ascii), lower_ascii: Boolean(field.lower_ascii),
    left_values: mapObject(field.left_values, `${field.name || '字段'} 左侧映射`),
    right_values: mapObject(field.right_values, `${field.name || '字段'} 右侧映射`),
    missing: [...(field.missing ?? [])].map(String), both_missing: String(field.both_missing ?? 'equal'),
    // Tolerances are user-authored decimal strings. Never coerce them through Number.
    abs_tol: String(field.abs_tol ?? '0'), rel_tol: String(field.rel_tol ?? '0'), days_tol: strictInteger(field.days_tol),
  }));
  const output = { schema_version: model.schema_version ?? 1, fields, key: [...(model.key ?? [])], ignore_left: [...(model.ignore_left ?? [])], ignore_right: [...(model.ignore_right ?? [])] };
  if (model.candidates != null) output.candidates = {
    fields: (model.candidates.fields ?? []).map((candidate) => ({ field: String(candidate.field ?? ''), metric: String(candidate.metric ?? ''), weight: strictInteger(candidate.weight ?? 1) })),
    threshold: strictInteger(model.candidates.threshold ?? 1),
    blocking: (model.candidates.blocking ?? []).map((group) => [...group]),
  };
  return output;
}


// JSON string contents without enclosing quotes: ordinary text stays readable,
// while native input/textarea normalization never touches actual control bytes.
export const encodeString = (value) => JSON.stringify(String(value)).slice(1, -1)
  .replace(/[\u007f-\u009f\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function decodeString(text) {
  try { return JSON.parse(`"${text}"`); }
  catch { throw new TypeError('转义文本不完整或无效，请使用 \\\\、\\n、\\r、\\t 或 \\uXXXX。'); }
}
export const encodeStringList = (items) => items.map((item) => item === '' ? '\\e' : encodeString(item)).join('\n');
export const decodeStringList = (text) => text.split('\n').filter((line) => line !== '').map((line) => line === '\\e' ? '' : decodeString(line));
