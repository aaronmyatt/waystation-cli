// ──────────────────────────────────────────────────────────────────────────
// Vendored JSON Pointer (RFC 6901) implementation.
//
// Source: https://github.com/janl/node-jsonpointer (MIT)
// This is a TypeScript port — semantics preserved exactly, including:
//   • tilde escaping (~0 → ~, ~1 → /)
//   • array-append using the "-" token
//   • prototype-pollution guards (refuses to set __proto__/constructor/prototype)
//   • undefined-deletes-key behaviour in `set(...)`
//
// Why vendored, not depended-on:
// The upstream package is CJS-only and tiny; we want a zero-runtime-dep core
// usable from Deno *and* from Node (via JSR), so we inline the source rather
// than ship a transitive dependency. See the project plan for context.
//
// RFC 6901 — JSON Pointer: https://datatracker.ietf.org/doc/html/rfc6901
// ──────────────────────────────────────────────────────────────────────────

// Matches any tilde in a token; cheap fast-path before running the full escape.
const hasEscape = /~/;
// Matches the two escape sequences defined by RFC 6901 §3.
const escapeMatcher = /~[01]/g;

function escapeReplacer(m: string): string {
  switch (m) {
    case '~1':
      return '/';
    case '~0':
      return '~';
  }
  // Defensive: the regex above only matches ~0/~1; an unknown match means the
  // regex and replacer drifted out of sync — fail loudly rather than silently.
  throw new Error('Invalid tilde escape: ' + m);
}

/**
 * Unescape a single JSON Pointer reference token (RFC 6901 §4).
 * Returns the input unchanged if it contains no tilde escapes — this skips the
 * regex replace on the common case (most pointer segments are plain).
 */
function untilde(str: string): string {
  if (!hasEscape.test(str)) return str;
  return str.replace(escapeMatcher, escapeReplacer);
}

// A compiled pointer is the split form: e.g. "/a/b/0" → ["", "a", "b", "0"].
// The leading empty string is required by RFC 6901 — the pointer starts at /.
type CompiledPointer = string[];

/**
 * Internal walker used by `set`. Builds intermediate objects/arrays on demand
 * and writes the leaf value. Mirrors upstream exactly — see node-jsonpointer.
 */
function setter(obj: any, pointer: CompiledPointer, value: unknown): unknown {
  let part: string | number = '';
  let hasNextPart = false;

  for (let p = 1, len = pointer.length; p < len;) {
    // Guard against prototype pollution. These keys are *never* legal JSON
    // pointer targets in our domain, and writing to them is almost always a
    // bug or attack. Refuse silently (return the obj unchanged) — same as
    // upstream behaviour.
    if (
      pointer[p] === 'constructor' || pointer[p] === 'prototype' ||
      pointer[p] === '__proto__'
    ) return obj;

    part = untilde(pointer[p++]);
    hasNextPart = len > p;

    if (typeof obj[part as any] === 'undefined') {
      // RFC 6901 §4: "-" is a special array-append token. If we're indexing
      // into an array and see "-", coerce it to the array's current length so
      // the new element lands at the end.
      if (Array.isArray(obj) && part === '-') {
        part = obj.length;
      }

      if (hasNextPart) {
        // Decide whether the missing intermediate should be an array or object.
        // Heuristic: if the *next* token looks numeric (or is "-"), create an
        // array; otherwise an object. Matches upstream.
        if (
          (pointer[p] !== '' && (pointer[p] as any) < Infinity) ||
          pointer[p] === '-'
        ) {
          obj[part as any] = [];
        } else {
          obj[part as any] = {};
        }
      }
    }

    if (!hasNextPart) break;
    obj = obj[part as any];
  }

  const oldValue = obj[part as any];
  // Per upstream: passing `undefined` is the documented way to delete a key.
  if (value === undefined) delete obj[part as any];
  else obj[part as any] = value;
  return oldValue;
}

/**
 * Parse a JSON Pointer string into its compiled (split) form. Accepts an
 * already-split array as a convenience for callers that hold pre-parsed paths.
 *
 * Throws on malformed input — empty strings and root pointers ("") are valid
 * and return `[""]`; anything not starting with "/" is rejected.
 */
function compilePointer(pointer: string | (string | number)[]): CompiledPointer {
  if (typeof pointer === 'string') {
    const parts = pointer.split('/');
    if (parts[0] === '') return parts;
    throw new Error('Invalid JSON pointer.');
  } else if (Array.isArray(pointer)) {
    for (const part of pointer) {
      if (typeof part !== 'string' && typeof part !== 'number') {
        throw new Error('Invalid JSON pointer. Must be of type string or number.');
      }
    }
    return pointer.map((p) => String(p));
  }
  throw new Error('Invalid JSON pointer.');
}

/**
 * Read the value at `pointer` inside `obj`. Returns `undefined` if any
 * intermediate node is missing or not an object.
 *
 * @example
 *   get({ a: { b: 1 } }, '/a/b') // → 1
 *   get({ a: [10, 20] }, '/a/1') // → 20
 *   get({}, '/missing/path')      // → undefined
 */
export function get(obj: any, pointer: string | (string | number)[]): any {
  if (typeof obj !== 'object') throw new Error('Invalid input object.');
  const compiled = compilePointer(pointer);
  const len = compiled.length;
  // The root pointer "" splits to [""] — returns the object itself.
  if (len === 1) return obj;

  for (let p = 1; p < len;) {
    obj = obj[untilde(compiled[p++])];
    if (len === p) return obj;
    if (typeof obj !== 'object' || obj === null) return undefined;
  }
}

/**
 * Write `value` at `pointer` inside `obj`, creating intermediate
 * objects/arrays as needed. Pass `undefined` to delete the leaf key.
 * Returns the old value (or `undefined`).
 *
 * @example
 *   const o = { a: { b: 1 } };
 *   set(o, '/a/b', 2);            // o.a.b === 2
 *   set(o, '/a/c/-', 'first');    // o.a.c === ['first']
 *   set(o, '/a/b', undefined);    // deletes o.a.b
 */
export function set(
  obj: any,
  pointer: string | (string | number)[],
  value: unknown,
): unknown {
  if (typeof obj !== 'object') throw new Error('Invalid input object.');
  const compiled = compilePointer(pointer);
  if (compiled.length === 0) throw new Error('Invalid JSON pointer for set.');
  return setter(obj, compiled, value);
}

/**
 * Pre-compile a pointer for repeated use. Useful in hot loops where the same
 * path is read/written many times.
 *
 * @example
 *   const nameAt = compile('/flow/name');
 *   nameAt.get(aggregate);
 *   nameAt.set(aggregate, 'Renamed');
 */
export function compile(pointer: string | (string | number)[]): {
  get: (object: any) => any;
  set: (object: any, value: unknown) => unknown;
} {
  const compiled = compilePointer(pointer);
  return {
    get: function (object: any) {
      return get(object, compiled);
    },
    set: function (object: any, value: unknown) {
      return set(object, compiled, value);
    },
  };
}

// ── REPL examples ────────────────────────────────────────────────────────
// import * as jp from './vendor/jsonpointer.ts';
//
// // 1. Read & write inside a flow aggregate
// const agg = { flow: { name: 'A', id: 'f1' }, matches: [] as any[] };
// jp.set(agg, '/flow/name', 'Renamed');     // agg.flow.name === 'Renamed'
// jp.get(agg, '/flow/name');                 // 'Renamed'
//
// // 2. Append a match (RFC 6901 "-" token)
// jp.set(agg, '/matches/-', { content_kind: 'note' });
// jp.get(agg, '/matches/0/content_kind');    // 'note'
//
// // 3. Pre-compiled pointer reused
// const titlePtr = jp.compile('/matches/0/step_content/title');
// titlePtr.set(agg, 'Hello');                 // creates step_content along the way
// titlePtr.get(agg);                          // 'Hello'
