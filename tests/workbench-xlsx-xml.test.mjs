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

test('handles a reference split across input chunks followed by a UTF-8 code point', () => {
  const source = `<t>${'x'.repeat(4092)}&#60;🙂</t>`;
  assert.equal(new TextEncoder().encode(source.slice(0, source.indexOf('&#60;'))).length, 4095);
  assert.equal(new TextEncoder().encode(source.slice(0, source.indexOf('🙂'))).length, 4100);
  const events = eventsFor(source);
  assert.equal(events.filter(event => event.type === 'text').map(event => event.value).join(''), `${'x'.repeat(4092)}<🙂`);
});

test('preserves a four-byte UTF-8 character at every split across byte 4096', () => {
  for (const emojiOffset of [4093, 4094, 4095]) {
    const source = `<t>${'x'.repeat(emojiOffset - 3)}🙂</t>`;
    const bytes = new TextEncoder().encode(source);
    assert.equal(new TextEncoder().encode(source.slice(0, source.indexOf('🙂'))).length, emojiOffset);
    assert.deepEqual([...bytes.subarray(emojiOffset, emojiOffset + 4)], [0xf0, 0x9f, 0x99, 0x82]);
    assert.ok(emojiOffset < 4096 && emojiOffset + 4 > 4096);
    const events = eventsFor(source);
    assert.equal(events.filter(event => event.type === 'text').map(event => event.value).join(''), `${'x'.repeat(emojiOffset - 3)}🙂`);
    assert.equal(events.filter(event => event.type === 'close').length, 1);
  }
});

test('accepts decimal and hexadecimal supplementary-character references', () => {
  assert.deepEqual(eventsFor('<t>&#128578;&#x1F642;</t>'), [
    { type: 'open', uri: '', local: 't', attributes: [] },
    { type: 'text', value: '🙂🙂' },
    { type: 'close', uri: '', local: 't' },
  ]);
});

test('rejects high and low surrogate numeric references instead of emitting text', () => {
  for (const reference of ['&#xD800;', '&#xDBFF;', '&#xDC00;', '&#xDFFF;', '&#55296;', '&#56319;', '&#56320;', '&#57343;']) {
    const events = [];
    assert.throws(() => parseXmlEvents(new TextEncoder().encode(`<t>${reference}</t>`), {
      onEvent: event => events.push(event),
      limits: { xml_bytes: 65536, xml_depth: 64 }, part: 'surrogate.xml',
    }), error => error.code === 'invalid_xlsx', reference);
    assert.deepEqual(events, [{ type: 'open', uri: '', local: 't', attributes: [] }], reference);
  }
});

test('rejects invalid UTF-8 sequences crossing byte 4096 without completing XML', () => {
  const prefix = new TextEncoder().encode(`<t>${'x'.repeat(4092)}`);
  const suffix = new TextEncoder().encode('</t>');
  assert.equal(prefix.byteLength, 4095);
  for (const invalidSequence of [[0xf0, 0x28, 0x8c, 0xbc], [0xed, 0xa0, 0x80]]) {
    const bytes = Uint8Array.from([...prefix, ...invalidSequence, ...suffix]);
    assert.equal(bytes[4095], invalidSequence[0]);
    assert.equal(bytes[4096], invalidSequence[1]);
    const events = [];
    assert.throws(() => parseXmlEvents(bytes, {
      onEvent: event => events.push(event),
      limits: { xml_bytes: 65536, xml_depth: 64 }, part: 'encoding.xml',
    }), error => error.code === 'invalid_xlsx');
    assert.deepEqual(events, [{ type: 'open', uri: '', local: 't', attributes: [] }]);
  }
});

test('rejects truncated UTF-8 at the final decoder flush on and across byte 4096', () => {
  // A complete root makes an ignored trailing partial sequence look successful.
  const prefix = new TextEncoder().encode(`<t>${'x'.repeat(4088)}</t>`);
  assert.equal(prefix.byteLength, 4095);
  for (const incompleteSequence of [[0xf0], [0xf0, 0x9f], [0xf0, 0x9f, 0x99]]) {
    const bytes = Uint8Array.from([...prefix, ...incompleteSequence]);
    assert.equal(bytes[4095], 0xf0);
    assert.equal(bytes.byteLength, 4095 + incompleteSequence.length);
    const events = [];
    assert.throws(() => parseXmlEvents(bytes, {
      onEvent: event => events.push(event),
      limits: { xml_bytes: 65536, xml_depth: 64 }, part: 'encoding.xml',
    }), error => error.code === 'invalid_xlsx');
    assert.deepEqual(events, [
      { type: 'open', uri: '', local: 't', attributes: [] },
      { type: 'text', value: 'x'.repeat(4088) },
      { type: 'close', uri: '', local: 't' },
    ]);
  }
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

test('rejects caller depth limits above the frozen ceiling before emitting events', () => {
  const events = [];
  const bytes = new TextEncoder().encode(`${'<a>'.repeat(65)}${'</a>'.repeat(65)}`);
  assert.throws(() => parseXmlEvents(bytes, {
    onEvent: event => events.push(event), limits: { xml_bytes: 1024, xml_depth: 65 }, part: 'depth.xml',
  }), error => error.code === 'invalid_xlsx');
  assert.deepEqual(events, []);
});

test('rejects caller byte limits above the frozen ceiling even for small XML', () => {
  const events = [];
  assert.throws(() => parseXmlEvents(new TextEncoder().encode('<t/>'), {
    onEvent: event => events.push(event), limits: { xml_bytes: 67108865, xml_depth: 64 }, part: 'large.xml',
  }), error => error.code === 'invalid_xlsx');
  assert.deepEqual(events, []);
});

test('accepts the frozen ceilings and retains lower testing limits', () => {
  assert.doesNotThrow(() => parseXmlEvents(new TextEncoder().encode('<t/>'), {
    onEvent() {}, limits: { xml_bytes: 67108864, xml_depth: 64 }, part: 'limits.xml',
  }));
  assert.doesNotThrow(() => parseXmlEvents(new TextEncoder().encode('<a><b/></a>'), {
    onEvent() {}, limits: { xml_bytes: 11, xml_depth: 2 }, part: 'limits.xml',
  }));
  assert.throws(() => parseXmlEvents(new TextEncoder().encode('<a><b><c/></b></a>'), {
    onEvent() {}, limits: { xml_bytes: 1024, xml_depth: 2 }, part: 'limits.xml',
  }), error => error.code === 'xlsx_limit_exceeded');
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

test('strict comment and PI option preserves default events and XML declaration', () => {
 const source=Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!--before--><?task before?><r>x<!--inside--><?task inside?></r><!--after--><?task after?>');
 const baseline=[];
 parseXmlEvents(source,{onEvent:e=>baseline.push(e),limits:{xml_bytes:67108864,xml_depth:64}});
 for(const option of [undefined,false]){const events=[];parseXmlEvents(source,{onEvent:e=>events.push(e),limits:{xml_bytes:67108864,xml_depth:64},rejectCommentsAndProcessingInstructions:option});assert.deepEqual(events,baseline);}
 const events=[];parseXmlEvents(Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><r/>'),{onEvent:e=>events.push(e),limits:{xml_bytes:67108864,xml_depth:64},rejectCommentsAndProcessingInstructions:true});assert.equal(events.length,2);
});
for(const token of ['<!--comment-->','<?task value?>'])for(const where of ['before','inside','after','boundary'])test(`strict helper rejects real ${token} ${where}`,()=>{
 const xml=where==='before'?`${token}<r/>`:where==='after'?`<r/>${token}`:where==='boundary'?`<r>${' '.repeat(4090)}${token}</r>`:`<r>${token}</r>`;
 assert.throws(()=>parseXmlEvents(Buffer.from(xml),{onEvent:()=>{},limits:{xml_bytes:67108864,xml_depth:64},rejectCommentsAndProcessingInstructions:true}),e=>e.name==='XlsxXmlError'&&e.code==='unsupported_xlsx_feature'&&e.phase==='xlsx');
});
for(const option of [null,0,'true',{},[]])test(`strict helper invalid option ${JSON.stringify(option)} fails before events`,()=>{
 let events=0;assert.throws(()=>parseXmlEvents(Buffer.from('<r/>'),{onEvent:()=>events++,limits:{xml_bytes:67108864,xml_depth:64},rejectCommentsAndProcessingInstructions:option}),e=>e.code==='invalid_xlsx');assert.equal(events,0);
});
test('strict helper does not confuse literal comment or PI strings with markup',()=>{
 const events=[];parseXmlEvents(Buffer.from('<r><![CDATA[<!--literal--> <?literal?>]]>&lt;!--text--&gt;&lt;?text?&gt;</r>'),{onEvent:e=>events.push(e),limits:{xml_bytes:67108864,xml_depth:64},rejectCommentsAndProcessingInstructions:true});
 assert.equal(events.filter(e=>['text','cdata'].includes(e.type)).map(e=>e.value).join(''),'<!--literal--> <?literal?>'+'<!--text--><?text?>');
});
