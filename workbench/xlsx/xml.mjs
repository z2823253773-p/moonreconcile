import { SaxesParser } from 'saxes';

const XINCLUDE = 'http://www.w3.org/2001/XInclude';
const CHUNK_BYTES = 4096;
const MAX_XML_BYTES = 67108864;
const MAX_XML_DEPTH = 64;

function safePartName(value) {
  if (typeof value !== 'string' || value.length > 256) return 'xml';
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) ||
      value.split('/').some(segment => segment === '.' || segment === '..') || /^[A-Za-z]:/.test(value)) return 'xml';
  return value;
}

function xmlError(code, part, position = undefined) {
  const error = new Error(code === 'unsupported_xlsx_feature' ? 'Unsupported XML feature.' : 'Invalid XML.');
  error.name = 'XlsxXmlError';
  error.code = code;
  error.phase = 'xlsx';
  error.part = part;
  if (Number.isSafeInteger(position) && position >= 0) error.position = position;
  return error;
}

/**
 * Parse one bounded UTF-8 XML part and emit namespace-expanded XML events.
 * Character references are decoded by the XML tokenizer exactly once.
 * Caller limits may lower the frozen ceilings; raising either is invalid.
 */
export function parseXmlEvents(bytes, { onEvent, limits, part } = {}) {
  const partName = safePartName(part);
  if (!(bytes instanceof Uint8Array) || typeof onEvent !== 'function' || !limits ||
      !Number.isSafeInteger(limits.xml_bytes) || limits.xml_bytes < 0 || limits.xml_bytes > MAX_XML_BYTES ||
      !Number.isSafeInteger(limits.xml_depth) || limits.xml_depth < 1 || limits.xml_depth > MAX_XML_DEPTH) {
    throw xmlError('invalid_xlsx', partName);
  }
  if (bytes.byteLength > limits.xml_bytes) throw xmlError('xlsx_limit_exceeded', partName);

  const parser = new SaxesParser({ xmlns: true, fragment: false, position: true, defaultXMLVersion: '1.0' });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let depth = 0;

  const fail = (code) => { throw xmlError(code, partName, parser.position); };
  const emit = (event) => {
    try { onEvent(event); }
    catch { fail('invalid_xlsx'); }
  };

  parser.on('xmldecl', declaration => {
    if (declaration.version !== '1.0' ||
        (declaration.encoding !== undefined && !/^utf-8$/i.test(declaration.encoding))) {
      fail('invalid_xlsx');
    }
  });
  parser.on('doctype', () => fail('unsupported_xlsx_feature'));
  parser.on('error', () => fail('invalid_xlsx'));
  parser.on('opentag', tag => {
    depth += 1;
    if (depth > limits.xml_depth) fail('xlsx_limit_exceeded');
    if (tag.uri === XINCLUDE && tag.local === 'include') fail('unsupported_xlsx_feature');
    const attributes = Object.values(tag.attributes).map(attribute => ({
      uri: attribute.uri || '',
      local: attribute.local,
      value: attribute.value,
    }));
    emit({ type: 'open', uri: tag.uri || '', local: tag.local, attributes });
  });
  parser.on('text', value => emit({ type: 'text', value }));
  parser.on('cdata', value => emit({ type: 'cdata', value }));
  parser.on('closetag', tag => {
    emit({ type: 'close', uri: tag.uri || '', local: tag.local });
    depth -= 1;
  });

  try {
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      const end = Math.min(bytes.byteLength, offset + CHUNK_BYTES);
      parser.write(decoder.decode(bytes.subarray(offset, end), { stream: true }));
    }
    parser.write(decoder.decode());
    parser.close();
  } catch (error) {
    if (error?.name === 'XlsxXmlError') throw error;
    fail('invalid_xlsx');
  }
  if (depth !== 0) fail('invalid_xlsx');
}
