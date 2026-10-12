import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseXmlEvents } from '../workbench/xlsx/xml.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/xlsx/xml-cases.json', import.meta.url), 'utf8'));

function eventsFor(source) {
  const events = [];
  parseXmlEvents(new TextEncoder().encode(source), {
    onEvent: event => events.push(event),
    limits: { xml_bytes: 65536, xml_depth: 64 },
    part: 'counterexample.xml',
  });
  return events;
}

test('numeric_refs_stay_text', () => {
  const events = eventsFor('<t>&#60;b&#62;x&#60;/b&#62;</t>');
  assert.deepEqual(events, [
    { type: 'open', uri: '', local: 't', attributes: [] },
    { type: 'text', value: '<b>x</b>' },
    { type: 'close', uri: '', local: 't' },
  ]);
  assert.equal(events.some(event => event.type === 'open' && event.local === 'b'), false);
});

test('ampersand_ref_decodes_once', () => {
  assert.deepEqual(eventsFor('<t>&#38;lt;</t>'), [
    { type: 'open', uri: '', local: 't', attributes: [] },
    { type: 'text', value: '&lt;' },
    { type: 'close', uri: '', local: 't' },
  ]);
});

test('quoted_attribute_remains_syntax_safe', () => {
  assert.deepEqual(eventsFor('<t a="&#34;">x</t>'), [
    { type: 'open', uri: '', local: 't', attributes: [{ uri: '', local: 'a', value: '"' }] },
    { type: 'text', value: 'x' },
    { type: 'close', uri: '', local: 't' },
  ]);
});

test('decodes decimal hexadecimal and predefined references exactly once', () => {
  const events = eventsFor('<t>&#65;&#x42;&amp;&lt;&gt;&quot;&apos;</t>');
  assert.equal(events.find(event => event.type === 'text').value, 'AB&<>"\'');
});

test('keeps CDATA distinguishable and preserves its literal characters', () => {
  assert.deepEqual(eventsFor('<t>a<![CDATA[&lt;b>]]>c</t>'), [
    { type: 'open', uri: '', local: 't', attributes: [] },
    { type: 'text', value: 'a' },
    { type: 'cdata', value: '&lt;b>' },
    { type: 'text', value: 'c' },
    { type: 'close', uri: '', local: 't' },
  ]);
});

test('normalizes literal line endings while preserving numeric carriage returns', () => {
  const events = eventsFor('<t>one\r\ntwo&#13;three</t>');
  assert.equal(events.filter(event => event.type === 'text').map(event => event.value).join(''), 'one\ntwo\rthree');
});

test('handles references and UTF-8 code points split across input chunks', () => {
  const source = `<t>${'x'.repeat(4092)}&#60;🙂</t>`;
  const events = eventsFor(source);
  assert.equal(events.filter(event => event.type === 'text').map(event => event.value).join(''), `${'x'.repeat(4092)}<🙂`);
});

test('rejects malformed markup and does not continue emitting events after the error', () => {
  const malformedNesting = [];
  assert.throws(() => parseXmlEvents(new TextEncoder().encode('<a><b></a>'), {
    onEvent: event => malformedNesting.push(event),
    limits: { xml_bytes: 65536, xml_depth: 64 },
    part: 'counterexample.xml',
  }), error => error.code === 'invalid_xlsx');
  assert.deepEqual(malformedNesting.map(event => `${event.type}:${event.local}`), ['open:a', 'open:b', 'close:b']);

  const malformedAttribute = [];
  assert.throws(() => parseXmlEvents(new TextEncoder().encode('<a x="1></a>'), {
    onEvent: event => malformedAttribute.push(event),
    limits: { xml_bytes: 65536, xml_depth: 64 },
    part: 'counterexample.xml',
  }), error => error.code === 'invalid_xlsx');
  assert.deepEqual(malformedAttribute, []);
});

test('rejects DTDs custom and external entities', () => {
  for (const source of [
    '<!DOCTYPE t [<!ENTITY x "y">]><t>&x;</t>',
    '<!DOCTYPE t SYSTEM "file:///etc/passwd"><t/>',
  ]) {
    assert.throws(() => parseXmlEvents(new TextEncoder().encode(source), {
      onEvent() {}, limits: { xml_bytes: 65536, xml_depth: 64 }, part: 'counterexample.xml',
    }), error => error.code === 'unsupported_xlsx_feature' && !error.message.includes('/etc/passwd'));
  }
});

test('rejects XInclude markup without fetching or resolving it', () => {
  assert.throws(() => eventsFor('<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="file:///etc/passwd"/>'),
    error => error.code === 'unsupported_xlsx_feature');
});

test('enforces the XML depth limit at 64 and rejects 65', () => {
  const sourceAtDepth = depth => `${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`;
  assert.doesNotThrow(() => parseXmlEvents(new TextEncoder().encode(sourceAtDepth(64)), {
    onEvent() {}, limits: { xml_bytes: 1024, xml_depth: 64 }, part: 'depth.xml',
  }));
  assert.throws(() => parseXmlEvents(new TextEncoder().encode(sourceAtDepth(65)), {
    onEvent() {}, limits: { xml_bytes: 1024, xml_depth: 64 }, part: 'depth.xml',
  }), error => error.code === 'xlsx_limit_exceeded');
});

test('enforces the XML byte limit before emitting any events', () => {
  const events = [];
  assert.throws(() => parseXmlEvents(new TextEncoder().encode('<root/>'), {
    onEvent: event => events.push(event), limits: { xml_bytes: 6, xml_depth: 64 }, part: 'large.xml',
  }), error => error.code === 'xlsx_limit_exceeded');
  assert.deepEqual(events, []);
});

test('preserves namespace-expanded element and attribute names', () => {
  assert.deepEqual(eventsFor('<p:t xmlns:p="urn:t" p:a="v"/>'), [
    { type: 'open', uri: 'urn:t', local: 't', attributes: [
      { uri: 'http://www.w3.org/2000/xmlns/', local: 'p', value: 'urn:t' },
      { uri: 'urn:t', local: 'a', value: 'v' },
    ] },
    { type: 'close', uri: 'urn:t', local: 't' },
  ]);
});

test('fixture vectors agree with event parsing and reject policy', () => {
  for (const item of fixture.cases) {
    if (item.reject) {
      const errorCode = item.reject;
      assert.throws(() => eventsFor(item.xml), error => error.code === errorCode, item.id);
      continue;
    }
    const events = eventsFor(item.xml);
    const open = events.find(event => event.type === 'open');
    assert.equal(open.local, item.root, item.id);
    assert.equal(events.filter(event => event.type === 'open').length - 1, item.children, item.id);
    assert.equal(events.filter(event => event.type === 'text' || event.type === 'cdata').map(event => event.value).join(''), item.text, item.id);
    if (item.attributes) assert.deepEqual(Object.fromEntries(open.attributes.map(attr => [attr.local, attr.value])), item.attributes, item.id);
  }
});

test('rejects XML 1.1 declarations, non-UTF-8 declarations and invalid UTF-8', () => {
  for (const bytes of [
    new TextEncoder().encode('<?xml version="1.1"?><t/>'),
    new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><t/>'),
    Uint8Array.from([0x3c, 0x74, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x74, 0x3e]),
  ]) {
    assert.throws(() => parseXmlEvents(bytes, {
      onEvent() {}, limits: { xml_bytes: 1024, xml_depth: 64 }, part: 'encoding.xml',
    }), error => error.code === 'invalid_xlsx');
  }
});
