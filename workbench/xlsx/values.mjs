import { XLSX_LIMITS } from './contracts.mjs';

const fail = code => { const error = new Error('Invalid spreadsheet value.'); error.code = code; error.phase = 'xlsx'; return error; };
const MODES = new Set(['stored_text','decimal_lexeme','excel_date','zero_padded_identifier']);
const TYPES = new Set(['blank','text','numeric','boolean']);
const utf8Length = value => Buffer.byteLength(value, 'utf8');

function validateLimits(limits) {
  if (!limits || Object.keys(limits).length !== Object.keys(XLSX_LIMITS).length ||
      Object.keys(XLSX_LIMITS).some(key => !Object.hasOwn(limits,key) || !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > XLSX_LIMITS[key])) throw fail('invalid_xlsx');
}

/** Expand an XML numeric cell lexeme using bounded string operations only. */
export function expandDecimalLexeme(value, limits = XLSX_LIMITS) {
  validateLimits(limits);
  if (typeof value !== 'string' || utf8Length(value) > limits.cell_bytes) throw fail('xlsx_numeric_limit');
  const match = /^([+-]?)([0-9]+)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(value);
  if (!match || match[2] === '' ) throw fail('xlsx_numeric_limit');
  const [, sign, whole, fraction = '', exponentText = '0'] = match;
  if (value.includes('.') && fraction.length === 0 && !/[eE]/.test(value)) { if (utf8Length(value) > limits.cell_bytes) throw fail('xlsx_numeric_limit'); return value; }
  if (!/[eE]/.test(value)) return value;
  if (exponentText.length > 7) throw fail('xlsx_numeric_limit');
  const exponentBig = BigInt(exponentText);
  if (exponentBig > 65536n || exponentBig < -65536n) throw fail('xlsx_numeric_limit');
  const exponent = Number(exponentBig);
  const digits = whole + fraction;
  const point = whole.length + exponent;
  const resultLength = point <= 0 ? 2 + -point + digits.length : point >= digits.length ? point : digits.length + 1;
  const signLength = sign ? 1 : 0;
  if (resultLength + signLength > limits.cell_bytes) throw fail('xlsx_numeric_limit');
  let output;
  if (point <= 0) output = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) output = `${digits}${'0'.repeat(point - digits.length)}`;
  else output = `${digits.slice(0,point)}.${digits.slice(point)}`;
  output = `${sign}${output}`;
  if (utf8Length(output) > limits.cell_bytes) throw fail('xlsx_numeric_limit');
  return output;
}

/** Decode the SpreadsheetML Xstring escape layer once, after XML parsing. */
export function decodeSpreadsheetText(value) {
  if (typeof value !== 'string') throw fail('xlsx_value_mode_mismatch');
  const units = [];
  for (let i = 0; i < value.length;) {
    const match = /^_x([0-9A-Fa-f]{4})_/.exec(value.slice(i));
    if (!match) { units.push(value[i]); i += 1; continue; }
    const unit = Number.parseInt(match[1], 16);
    const end = i + match[0].length;
    // _x005F_xNNNN_ denotes a literal escape token, not a second escape pass.
    if (unit === 0x5f) {
      const tail = /^x[0-9A-Fa-f]{4}_/.exec(value.slice(end));
      if (tail) { units.push(`_x${tail[0].slice(1,-1)}_`); i = end + tail[0].length; continue; }
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = /^_x([0-9A-Fa-f]{4})_/.exec(value.slice(end));
      if (!low) throw fail('xlsx_value_mode_mismatch');
      const lowUnit = Number.parseInt(low[1],16);
      if (lowUnit < 0xdc00 || lowUnit > 0xdfff) throw fail('xlsx_value_mode_mismatch');
      units.push(String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + lowUnit - 0xdc00));
      i = end + low[0].length; continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw fail('xlsx_value_mode_mismatch');
    units.push(String.fromCharCode(unit)); i = end;
  }
  return units.join('');
}

function dateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${String(date.getUTCFullYear()).padStart(4,'0')}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}

export function excelSerialDate(value, dateSystem, limits = XLSX_LIMITS) {
  if (!['1900','1904'].includes(dateSystem)) throw fail('xlsx_date_rejected');
  const expanded = expandDecimalLexeme(value, limits);
  if (expanded.startsWith('-')) throw fail('xlsx_date_rejected');
  const dayLexeme = expanded.split('.',1)[0];
  const dayBig = BigInt(dayLexeme || '0');
  const max = dateSystem === '1900' ? 2958465n : 2957003n;
  if (dayBig > max || dateSystem === '1900' && dayBig === 60n) throw fail('xlsx_date_rejected');
  const days = Number(dayBig);
  if (dateSystem === '1904') return dateParts(1904,1,1 + days);
  return dateParts(1899,12,31 + (days > 60 ? days - 1 : days));
}

function validCell(cell, limits) {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell) ||
      Object.keys(cell).sort().join(',') !== 'column,coordinate,row,stored_value,style_index,type' ||
      typeof cell.coordinate !== 'string' || !Number.isSafeInteger(cell.row) || cell.row < 1 || cell.row > 1048576 ||
      !Number.isSafeInteger(cell.column) || cell.column < 1 || cell.column > 16384 || !TYPES.has(cell.type) ||
      typeof cell.stored_value !== 'string' || utf8Length(cell.stored_value) > limits.cell_bytes ||
      !(cell.style_index === null || Number.isSafeInteger(cell.style_index) && cell.style_index >= 0 && cell.style_index <= 2147483647)) throw fail('invalid_xlsx');
}

export function convertCell(cell, mode, context) {
  const limits = context?.limits ?? XLSX_LIMITS;
  validateLimits(limits); validCell(cell,limits);
  if (!MODES.has(mode)) throw fail('invalid_import_spec');
  const { type, stored_value: stored } = cell;
  if (type === 'blank' || stored === '') return {value:'',category:'blank',expanded:false};
  if (type === 'text') {
    if (mode !== 'stored_text') throw fail('xlsx_value_mode_mismatch');
    return {value:decodeSpreadsheetText(stored),category:'text',expanded:false};
  }
  if (type === 'boolean') {
    if (mode !== 'stored_text' || !['0','1'].includes(stored)) throw fail('xlsx_value_mode_mismatch');
    return {value:stored === '1' ? 'TRUE' : 'FALSE',category:'booleans',expanded:false};
  }
  if (type !== 'numeric') throw fail('xlsx_value_mode_mismatch');
  if (mode === 'stored_text') return {value:stored,category:'text',expanded:false};
  if (mode === 'decimal_lexeme') {
    const value=expandDecimalLexeme(stored,limits);
    return {value,category:'numeric_lexemes',expanded:/[eE]/.test(stored)};
  }
  if (mode === 'excel_date') return {value:excelSerialDate(stored,context.date_system,limits),category:'dates',expanded:false};
  if (mode === 'zero_padded_identifier') {
    const format=context.number_format;
    if (typeof format !== 'string' || !/^0+$/.test(format) || !/^(0|[1-9][0-9]*)$/.test(stored) || stored.length > format.length) throw fail('xlsx_value_mode_mismatch');
    const value=`${'0'.repeat(format.length-stored.length)}${stored}`;
    if (utf8Length(value)>limits.cell_bytes) throw fail('xlsx_numeric_limit');
    return {value,category:'zero_padded_identifiers',expanded:false};
  }
  throw fail('xlsx_value_mode_mismatch');
}
