// Sponsor CRUD round-trip — uses a temp DATA_DIR so we don't touch the
// project's real data/ directory.
//
// IMPORTANT: DATA_DIR must be set BEFORE we import db.js, because db.js
// reads it at module-load time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sponsor-test-'));
process.env.DATA_DIR = tmpDir;

const { sponsors } = await import('../server/db.js');
const { UPLOADS_DIR } = await import('../server/db.js');

test('sponsors: list/get/create/update/remove round-trip', () => {
  // empty list
  assert.deepEqual(sponsors.list(), []);

  // create (provide image_path directly — the upload step is handled by
  // the /api/sponsors route, not the DB helper)
  const id1 = sponsors.create({
    name: 'DC Auto Parts',
    image_path: 'sponsor-test-1.png',
    link: 'https://example.com',
    position: 'top-right',
    interval_seconds: 10,
    active: 1,
  });
  assert.ok(Number.isInteger(id1) && id1 > 0);

  const id2 = sponsors.create({
    name: 'Local Cafe',
    image_path: 'sponsor-test-2.png',
    link: null,
    position: 'center-banner',
    interval_seconds: 5,
    active: 0, // inactive
  });

  // list
  const all = sponsors.list();
  assert.equal(all.length, 2);

  // get
  const row1 = sponsors.get(id1);
  assert.equal(row1.name, 'DC Auto Parts');
  assert.equal(row1.image_path, 'sponsor-test-1.png');
  assert.equal(row1.link, 'https://example.com');
  assert.equal(row1.position, 'top-right');
  assert.equal(row1.interval_seconds, 10);
  assert.equal(row1.active, 1);

  // active-only filter
  const activeOnly = sponsors.list({ activeOnly: true });
  assert.equal(activeOnly.length, 1);
  assert.equal(activeOnly[0].id, id1);

  // update
  sponsors.update(id1, { interval_seconds: 15, active: 0 });
  const updated = sponsors.get(id1);
  assert.equal(updated.interval_seconds, 15);
  assert.equal(updated.active, 0);

  // update again with name change
  sponsors.update(id1, { name: 'DC Auto Parts Ltd' });
  assert.equal(sponsors.get(id1).name, 'DC Auto Parts Ltd');

  // remove
  sponsors.remove(id1);
  assert.equal(sponsors.get(id1), undefined);

  const after = sponsors.list();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, id2);
});

test('sponsors: interval_seconds is clamped and defaulted', () => {
  const tooSmall = sponsors.create({
    name: 'A', image_path: 'a.png', position: 'top-left', interval_seconds: -5, active: 1,
  });
  assert.equal(sponsors.get(tooSmall).interval_seconds, 1);

  const tooBig = sponsors.create({
    name: 'B', image_path: 'b.png', position: 'top-left', interval_seconds: 999999, active: 1,
  });
  assert.equal(sponsors.get(tooBig).interval_seconds, 600);

  const defaulted = sponsors.create({
    name: 'C', image_path: 'c.png', position: 'top-left', active: 1,
  });
  assert.equal(sponsors.get(defaulted).interval_seconds, 8);
});

test('UPLOADS_DIR is the temp DATA_DIR subdir', () => {
  assert.equal(UPLOADS_DIR, path.join(tmpDir, 'uploads'));
  assert.ok(fs.existsSync(UPLOADS_DIR));
});

// Best-effort cleanup after the test process exits. node --test runs files
// in their own process so this only nukes our own scratch dir.
test('cleanup temp dir', () => {
  // no-op marker; the actual cleanup happens after this file finishes
});

// Synchronous final cleanup (after all tests in this file have run).
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});