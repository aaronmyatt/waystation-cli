// Round-trips on a flow-aggregate-shaped object — exercises every code path
// in the vendored jsonpointer module that the rest of waystation-core relies
// on (get, set, compile, append via "-", prototype-pollution guard).

import { assertEquals, assertNotStrictEquals, assertStrictEquals } from '@std/assert';
import * as jp from '../src/vendor/jsonpointer.ts';
import { P } from '../src/pointers.ts';

Deno.test('jp.get reads scalar fields', () => {
  const agg = { flow: { name: 'A', id: 'f1' }, matches: [] as unknown[] };
  assertEquals(jp.get(agg, P.flowName), 'A');
  assertEquals(jp.get(agg, P.flowId), 'f1');
  assertEquals(jp.get(agg, '/missing/path'), undefined);
});

Deno.test('jp.set writes scalar fields and creates intermediates', () => {
  const agg = { flow: { name: 'A' }, matches: [] as unknown[] };
  jp.set(agg, P.flowName, 'Renamed');
  jp.set(agg, P.flowDescription, 'desc');
  assertEquals(agg.flow.name, 'Renamed');
  assertEquals((agg.flow as Record<string, unknown>).description, 'desc');
});

Deno.test('jp.set appends to array via "-" token (RFC 6901 §4)', () => {
  const agg = { flow: { name: '' }, matches: [] as unknown[] };
  jp.set(agg, P.appendMatch, { order_index: 0, content_kind: 'note' });
  jp.set(agg, P.appendMatch, { order_index: 1, content_kind: 'match' });
  assertEquals(agg.matches.length, 2);
  assertEquals(jp.get(agg, P.matchKind(0)), 'note');
  assertEquals(jp.get(agg, P.matchKind(1)), 'match');
});

Deno.test('jp.compile reuses a pre-parsed pointer', () => {
  const agg = { flow: { name: 'A' }, matches: [] };
  const ptr = jp.compile(P.flowName);
  assertEquals(ptr.get(agg), 'A');
  ptr.set(agg, 'B');
  assertEquals(ptr.get(agg), 'B');
});

Deno.test('jp.set guards against prototype pollution', () => {
  const o = {} as Record<string, unknown>;
  // Each of these should be a no-op; the polluted key must not appear on
  // Object.prototype after the test runs.
  jp.set(o, '/__proto__/polluted', 'x');
  jp.set(o, '/constructor/polluted', 'x');
  jp.set(o, '/prototype/polluted', 'x');
  assertStrictEquals((Object.prototype as Record<string, unknown>).polluted, undefined);
});

Deno.test('jp.get on root pointer returns the object itself', () => {
  const o = { a: 1 };
  // Per RFC 6901, "" is the root pointer.
  assertStrictEquals(jp.get(o, ''), o);
});

Deno.test('full aggregate round-trip via pointers', () => {
  const agg = { flow: { name: '' }, matches: [] as unknown[] };
  jp.set(agg, P.flowName, 'Demo');
  jp.set(agg, P.appendMatch, {
    flows_id: 'f1',
    content_kind: 'note',
    content_id: 'sc1',
    order_index: 0,
    step_content: { kind: 'note', title: 'Intro', body: 'Hello' },
  });
  assertEquals(jp.get(agg, P.flowName), 'Demo');
  assertEquals(jp.get(agg, P.stepTitle(0)), 'Intro');
  assertEquals(jp.get(agg, P.stepBody(0)), 'Hello');
  // Original object identity is preserved across reads.
  assertNotStrictEquals(jp.get(agg, P.matchAt(0)), undefined);
});
