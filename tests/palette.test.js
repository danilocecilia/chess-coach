import test from 'node:test';
import assert from 'node:assert/strict';

import { check, ratio, luminance } from '../scripts/validate_palette.js';

test('black on white is 21:1 and a colour on itself is 1:1', () => {
  // The arithmetic before the palette: if these are wrong every other number
  // on this page is wrong too, and plausibly so.
  assert.equal(Math.round(ratio('#000000', '#ffffff')), 21);
  assert.equal(ratio('#81b64c', '#81b64c'), 1);
  assert.ok(luminance('#fff') === luminance('#ffffff'), 'short hex is the long one');
});

test('every pair that meets on screen clears the ratio it needs', () => {
  const bad = check().filter((c) => !c.ok);
  const said = bad.map((c) => `${c.mode} ${c.what}: ${c.got.toFixed(2)}:1, needs ${c.need}`);
  assert.deepEqual(said, [], `contrast failures:\n  ${said.join('\n  ')}`);
});

test('the check actually covers both themes and the overlay', () => {
  // A green suite proves nothing if the checks quietly stopped being generated.
  const rows = check();
  for (const mode of ['dark', 'light', 'any']) {
    assert.ok(rows.some((r) => r.mode === mode), `nothing checked for ${mode}`);
  }
  assert.ok(rows.length >= 30, `only ${rows.length} pairs checked`);
});

test('the coach green is held to a different bar as a mark than as a fill', () => {
  // The design system shipped one green for both and measured it only against
  // dark, where it passes. On a white page it is a 2.1:1 focus ring. This is
  // the regression that split brand (fill) from brand-ink (mark).
  const rows = check();
  const ring = rows.filter((r) => r.what.includes('focus ring'));
  assert.ok(ring.length >= 2, 'the focus ring is checked on each ground');
  for (const r of ring) assert.ok(r.got >= 3, `${r.mode} focus ring is ${r.got.toFixed(2)}:1`);

  const fill = rows.find((r) => r.what === 'on-brand text on brand');
  assert.ok(fill.got >= 4.5, 'ink on the green fill stays readable');
});
