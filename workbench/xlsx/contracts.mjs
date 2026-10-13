export const XLSX_LIMITS = Object.freeze({
  compressed_bytes: 67108864,
  entries: 2048,
  actual_unzip_bytes: 268435456,
  xml_bytes: 67108864,
  xml_depth: 64,
  cell_bytes: 65536,
  csv_bytes: 67108864,
  data_rows: 100000,
  columns: 256,
});

export const XLSX_ERROR_CODES = Object.freeze([
  'invalid_xlsx', 'unsupported_xlsx_feature', 'invalid_import_spec', 'xlsx_source_mismatch',
  'xlsx_formula_rejected', 'xlsx_cell_error', 'xlsx_value_mode_mismatch', 'xlsx_date_rejected',
  'xlsx_numeric_limit', 'xlsx_limit_exceeded', 'xlsx_conversion_mismatch',
]);

const fail = code => { const error = new Error(code === 'unsupported_xlsx_feature' ? 'Unsupported workbook feature.' : 'Invalid workbook.'); error.code = code; error.phase = 'xlsx'; return error; };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function isXlsxErrorCode(value) { return XLSX_ERROR_CODES.includes(value); }

export function assertImportSpec(value, inventory) {
  const keys = ['schema_version','source_sha256','sheet_id','header_row','column_start','column_end','last_row','columns','formula_policy'];
  if (!exact(value, keys) || value.schema_version !== 1 || !sha(value.source_sha256) || value.formula_policy !== 'reject' ||
      !Number.isSafeInteger(value.header_row) || value.header_row < 1 || value.header_row > 1048576 ||
      !Number.isSafeInteger(value.column_start) || value.column_start < 1 || value.column_start > 16384 ||
      !Number.isSafeInteger(value.column_end) || value.column_end < value.column_start || value.column_end > 16384 ||
      value.column_end - value.column_start + 1 > XLSX_LIMITS.columns || !Number.isSafeInteger(value.last_row) ||
      value.last_row < value.header_row || value.last_row > 1048576 || value.last_row - value.header_row > XLSX_LIMITS.data_rows ||
      !Array.isArray(value.columns) || value.columns.length !== value.column_end - value.column_start + 1) throw fail('invalid_import_spec');
  if (inventory?.source?.sha256 !== value.source_sha256) throw fail('xlsx_source_mismatch');
  const sheet = inventory?.sheets?.find(item => item.sheet_id === value.sheet_id);
  if (!sheet || !sheet.selectable) throw fail('invalid_import_spec');
  const modes = new Set(['stored_text','decimal_lexeme','excel_date','zero_padded_identifier']);
  for (let index = 0; index < value.columns.length; index += 1) {
    const column = value.columns[index];
    if (!exact(column, ['column','mode']) || column.column !== value.column_start + index || !modes.has(column.mode)) throw fail('invalid_import_spec');
  }
  return value;
}

export function projectWorkbook(inventory, asset_id) {
  if (!inventory || !inventory.source || typeof asset_id !== 'string') throw fail('invalid_xlsx');
  return {
    xlsx_api_version: 1,
    asset_id,
    source_sha256: inventory.source.sha256,
    date_system: inventory.date_system,
    sheets: inventory.sheets.map(({ sheet_id, name, state, kind, selectable, value_cells, min_row, max_row, min_column, max_column }) => ({
      sheet_id, name, state, kind, selectable, value_cells, min_row, max_row, min_column, max_column,
    })),
  };
}
