import test from 'node:test';
import assert from 'node:assert/strict';
import { convertCell, decodeSpreadsheetText, excelSerialDate, expandDecimalLexeme } from '../workbench/xlsx/values.mjs';
import { XLSX_LIMITS } from '../workbench/xlsx/contracts.mjs';

const cell = (type, stored_value, style_index = null) => ({ coordinate:'A1', row:1, column:1, type, stored_value, style_index });
const context = (number_format='General', date_system='1900', limits=XLSX_LIMITS) => ({ number_format, date_system, limits });

test('decimal lexemes expand exactly without floating point or unbounded allocation', () => {
  assert.equal(expandDecimalLexeme('9007199254740993', XLSX_LIMITS), '9007199254740993');
  assert.equal(expandDecimalLexeme('+001.2300', XLSX_LIMITS), '+001.2300');
  assert.equal(expandDecimalLexeme('-001.2300E+1', XLSX_LIMITS), '-0012.300');
  assert.equal(expandDecimalLexeme('123456789012345678901234567890', XLSX_LIMITS), '123456789012345678901234567890');
  assert.equal(expandDecimalLexeme('1.2300E+2', XLSX_LIMITS), '123.00');
  assert.equal(expandDecimalLexeme('1.2E-3', XLSX_LIMITS), '0.0012');
  assert.throws(() => expandDecimalLexeme('1E+65537', XLSX_LIMITS), e => e.code === 'xlsx_numeric_limit');
  assert.throws(() => expandDecimalLexeme('1E+65536', { ...XLSX_LIMITS, cell_bytes: 3 }), e => e.code === 'xlsx_numeric_limit');
  for (const v of ['1e','NaN','Infinity','-']) assert.throws(() => expandDecimalLexeme(v, XLSX_LIMITS));
});

test('each explicit mode converts only compatible stored cell types', () => {
  assert.deepEqual(convertCell(cell('blank',''), 'excel_date', context()), { value:'', category:'blank', expanded:false });
  assert.equal(convertCell(cell('text',' 00123 '), 'stored_text', context()).value, ' 00123 ');
  assert.equal(convertCell(cell('numeric','1.2300E+2'), 'decimal_lexeme', context()).value, '123.00');
  assert.equal(convertCell(cell('numeric','123'), 'zero_padded_identifier', context('00000')).value, '00123');
  assert.equal(convertCell(cell('boolean','1'), 'stored_text', context()).value, 'TRUE');
  assert.equal(convertCell(cell('boolean','0'), 'stored_text', context()).value, 'FALSE');
  assert.throws(() => convertCell(cell('text','1'), 'decimal_lexeme', context()), e => e.code === 'xlsx_value_mode_mismatch');
  assert.throws(() => convertCell(cell('numeric','1.5'), 'zero_padded_identifier', context('00000')), e => e.code === 'xlsx_value_mode_mismatch');
  assert.throws(() => convertCell(cell('numeric','123'), 'zero_padded_identifier', context('000-00')), e => e.code === 'xlsx_value_mode_mismatch');
});

test('Excel serial conversion honors both systems, leap-day bug and year ceiling', () => {
  assert.equal(excelSerialDate('59','1900'), '1900-02-28');
  assert.throws(() => excelSerialDate('60','1900'), e => e.code === 'xlsx_date_rejected');
  assert.equal(excelSerialDate('61','1900'), '1900-03-01');
  assert.throws(() => excelSerialDate('0.5','1900'), e => e.code === 'xlsx_date_rejected');
  assert.equal(excelSerialDate('0','1904'), '1904-01-01');
  assert.equal(excelSerialDate('59','1904'), '1904-02-29');
  assert.equal(excelSerialDate('61','1904'), '1904-03-02');
  assert.throws(() => excelSerialDate('-1','1900'), e => e.code === 'xlsx_date_rejected');
  assert.throws(() => excelSerialDate('2958466','1900'), e => e.code === 'xlsx_date_rejected');
});

test('spreadsheet text escape decoding is single pass and preserves ordinary text', () => {
  assert.equal(decodeSpreadsheetText('00123 雪🙂\r\n  x  '), '00123 雪🙂\r\n  x  ');
  assert.equal(decodeSpreadsheetText('_x005F_x0061_'), '_x0061_');
  assert.equal(decodeSpreadsheetText('_x000D_'), '\r');
  assert.throws(() => decodeSpreadsheetText('_xD800_'));
});

test('mode and type matrix keeps blanks empty and rejects every incompatible conversion', () => {
  for (const mode of ['stored_text','decimal_lexeme','excel_date','zero_padded_identifier']) {
    assert.equal(convertCell(cell('blank',''),mode,context('00000')).value,'');
  }
  for (const type of ['text','boolean']) {
    for (const mode of ['decimal_lexeme','excel_date','zero_padded_identifier']) {
      assert.throws(() => convertCell(cell(type,type==='text'?'1':'1'),mode,context('00000')),
        e => e.code==='xlsx_value_mode_mismatch');
    }
  }
  assert.equal(convertCell(cell('numeric','+0001.2300'),'decimal_lexeme',context()).value,'+0001.2300');
  assert.equal(convertCell(cell('numeric','1.2300E+2'),'decimal_lexeme',context()).value,'123.00');
  for (const format of ['000-00','0.00','0;[Red]0','00/00']) {
    assert.throws(() => convertCell(cell('numeric','123'),'zero_padded_identifier',context(format)),
      e => e.code==='xlsx_value_mode_mismatch');
  }
});

test('date conversions bound the Gregorian year and reject fractional day parts', () => {
  assert.throws(() => excelSerialDate('61.999','1900'), e => e.code === 'xlsx_date_rejected');
  assert.equal(excelSerialDate('60','1904'),'1904-03-01');
  assert.equal(excelSerialDate('2958465','1900'),'9999-12-31');
  assert.equal(excelSerialDate('2957003','1904'),'9999-12-31');
});

test('Xstring decoding combines valid surrogate pairs and never recurses', () => {
  assert.equal(decodeSpreadsheetText('_xD83D__xDE42_'),'🙂');
  assert.equal(decodeSpreadsheetText('_x005F_x003C_'),'_x003C_');
  assert.equal(decodeSpreadsheetText('&lt;b&gt;'),'&lt;b&gt;');
  assert.throws(() => decodeSpreadsheetText('_xD800_'),e=>e.code==='xlsx_value_mode_mismatch');
});

for (const value of ['NaN','Infinity','-','+','1e',' 1','.']) {
  test(`I2 numeric stored_text validates grammar: ${value}`, () => {
    assert.throws(() => convertCell(cell('numeric',value),'stored_text',context()), e => e.code==='xlsx_numeric_limit');
  });
}
test('I2 numeric grammar permits leading points and zero-leading bounded exponents', () => {
  for (const [input,output] of [['.5','.5'],['+.5E+1','+5'],['1e00000000','1'],['1.e+00000002','100']]) assert.equal(expandDecimalLexeme(input),output);
  assert.deepEqual(convertCell(cell('numeric','+.50e00000000'),'stored_text',context()),{value:'+.50e00000000',category:'text',expanded:false});
  assert.throws(() => convertCell(cell('numeric','1e65537'),'stored_text',context()),e=>e.code==='xlsx_numeric_limit');
});
test('I1 dates normalize exact integral values without dropping time', () => {
  for (const value of ['61.000','6.1e1','+00061.0']) assert.equal(excelSerialDate(value,'1900'),'1900-03-01');
  for (const value of ['.5','61.0001','-0','-0.0']) assert.throws(()=>excelSerialDate(value,'1900'),e=>e.code==='xlsx_date_rejected');
});
for (const [input,output] of [['123456','123456'],['00123','00123'],['123.0','00123'],['1.23e2','00123'],['+123','00123'],['.0','00000']]) {
  test(`I3 zero identifiers normalize exact integral value ${input}`,()=>assert.equal(convertCell(cell('numeric',input),'zero_padded_identifier',context('00000')).value,output));
}
test('I3 zero identifier format and nonnegative integral domain are bounded',()=>{
  assert.throws(()=>convertCell(cell('numeric','1'),'zero_padded_identifier',context('0'.repeat(257))),e=>e.code==='xlsx_value_mode_mismatch');
  assert.equal(convertCell(cell('numeric','1'),'zero_padded_identifier',context('0'.repeat(256))).value.length,256);
  for(const input of ['-1','-0','1.001'])assert.throws(()=>convertCell(cell('numeric',input),'zero_padded_identifier',context('00000')),e=>e.code==='xlsx_value_mode_mismatch');
});

test('I2 numeric grammar consumes the complete lexeme including line endings',()=>{
  for(const input of ['1\n','1\r','1\u2028','1\u2029'])assert.throws(()=>convertCell(cell('numeric',input),'stored_text',context()),e=>e.code==='xlsx_numeric_limit');
});
test('I3 zero-only number formats reject trailing line endings',()=>{
  for(const format of ['0\n','0\r','0\u2028','0\u2029'])assert.throws(()=>convertCell(cell('numeric','1'),'zero_padded_identifier',context(format)),e=>e.code==='xlsx_value_mode_mismatch');
});
