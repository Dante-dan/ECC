'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const runtimePath = path.resolve(__dirname, '../../scripts/hooks/hookify-runtime.js');
const MAX_BYTES = 64 * 1024;
const ruleText = name => '---\nname: ' + name + '\nevent: bash\naction: block\npattern: BLOCK_ME\n---\nLocal policy.\n';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ecc-hookify-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '.claude');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'hookify.race.local.md');
  fs.writeFileSync(file, ruleText('trusted'));
  const descriptors = new Set();
  const reads = [];
  const flags = [];
  const io = {
    ...fs,
    constants: { ...fs.constants, ...(options.noFollow === false ? { O_NOFOLLOW: 0 } : {}) },
    openSync(name, openFlags, ...args) {
      if (name === file && options.beforeOpen) options.beforeOpen({ root, directory, file });
      if (options.requireNonblocking) assert.ok(openFlags & fs.constants.O_NONBLOCK);
      const fd = fs.openSync(name, openFlags, ...args);
      descriptors.add(fd);
      flags.push(openFlags);
      return fd;
    },
    readFileSync(fd, ...args) {
      if (descriptors.has(fd) && options.beforeRead) options.beforeRead({ root, directory, file });
      const result = fs.readFileSync(fd, ...args);
      if (descriptors.has(fd)) reads.push(Buffer.byteLength(result));
      return result;
    },
    readSync(fd, buffer, offset, length, position) {
      if (options.beforeRead) options.beforeRead({ root, directory, file });
      const size = fs.readSync(fd, buffer, offset, options.shortReads ? Math.min(7, length) : length, position);
      reads.push(size);
      return size;
    },
    closeSync(fd) {
      fs.closeSync(fd);
      descriptors.delete(fd);
    },
  };
  const copy = new Module(runtimePath, module);
  copy.filename = runtimePath;
  copy.paths = Module._nodeModulePaths(path.dirname(runtimePath));
  const localRequire = createRequire(runtimePath);
  copy.require = name => name === 'fs' ? io : localRequire(name);
  copy._compile(fs.readFileSync(runtimePath, 'utf8'), runtimePath);
  return { root, directory, file, io, runtime: copy.exports, descriptors, reads, flags };
}

function rejected(result, context) {
  assert.equal(result.rules.length, 0, 'raced content must not become a rule');
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], /changed|symbolic|regular|exceeds|EIO/);
  assert.equal(context.descriptors.size, 0, 'every opened rule descriptor must close');
}

test('growth after metadata validation cannot read over the rule ceiling plus one byte', t => {
  let grown = false;
  const context = fixture(t, { beforeRead({ file }) {
    if (grown) return;
    grown = true;
    fs.appendFileSync(file, 'x'.repeat(MAX_BYTES * 4));
  } });
  rejected(context.runtime.loadRules(context.root), context);
  assert.ok(grown, 'the real file must grow at the read boundary');
  assert.ok(context.reads.reduce((sum, size) => sum + size, 0) <= MAX_BYTES + 1);
});

test('same-inode replacement during reading is rejected before parsing', t => {
  let replaced = false;
  const context = fixture(t, { beforeRead({ file }) {
    if (replaced) return;
    replaced = true;
    fs.writeFileSync(file, ruleText('outside'));
    fs.utimesSync(file, new Date(2000), new Date(2000));
  } });
  rejected(context.runtime.loadRules(context.root), context);
});

test('permission changes during reading invalidate the pinned rule snapshot', t => {
  if (process.platform === 'win32') { t.skip('POSIX file modes required'); return; }
  let changed = false;
  const context = fixture(t, { beforeRead({ file }) {
    if (changed) return;
    changed = true;
    fs.chmodSync(file, 0o600);
  } });
  fs.chmodSync(context.file, 0o644);
  rejected(context.runtime.loadRules(context.root), context);
});

test('path replacement after opening cannot substitute or retain a stale rule', t => {
  let replaced = false;
  const context = fixture(t, { beforeRead({ file }) {
    if (replaced) return;
    replaced = true;
    fs.renameSync(file, file + '.original');
    fs.writeFileSync(file, ruleText('outside'));
  } });
  rejected(context.runtime.loadRules(context.root), context);
});

test('replacement of the rule directory cannot read outside-project rule data', t => {
  if (process.platform === 'win32') { t.skip('directory symlink creation requires POSIX'); return; }
  let replaced = false;
  const context = fixture(t, { beforeOpen({ root, directory }) {
    if (replaced) return;
    replaced = true;
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'hookify.race.local.md'), ruleText('outside'));
    fs.renameSync(directory, path.join(root, 'original'));
    fs.symlinkSync(outside, directory);
  } });
  rejected(context.runtime.loadRules(context.root), context);
  assert.equal(context.reads.length, 0, 'no outside-project bytes may be read');
});

test('platforms without O_NOFOLLOW reject a raced leaf symlink before any read', t => {
  if (process.platform === 'win32') { t.skip('symlink creation requires developer mode'); return; }
  let replaced = false;
  const context = fixture(t, { noFollow: false, beforeOpen({ root, file }) {
    if (replaced) return;
    replaced = true;
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, ruleText('outside'));
    fs.unlinkSync(file);
    fs.symlinkSync(outside, file);
  } });
  rejected(context.runtime.loadRules(context.root), context);
  assert.equal(context.reads.length, 0, 'the fallback must reject before consuming bytes');
});

test('a different real rule directory is rejected before reading its contents', t => {
  let replaced = false;
  const context = fixture(t, { beforeOpen({ root, directory }) {
    if (replaced) return;
    replaced = true;
    fs.renameSync(directory, path.join(root, 'original'));
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'hookify.race.local.md'), ruleText('outside'));
  } });
  rejected(context.runtime.loadRules(context.root), context);
  assert.equal(context.reads.length, 0);
});

test('a disappeared rule is diagnosed without opening or reading another file', t => {
  const context = fixture(t, { beforeOpen({ file }) { fs.unlinkSync(file); } });
  const result = context.runtime.loadRules(context.root);
  assert.deepEqual(result.rules, []);
  assert.match(result.diagnostics[0], /ENOENT/);
  assert.equal(context.descriptors.size, 0);
  assert.equal(context.reads.length, 0);
});

test('premature EOF cannot turn an incomplete file snapshot into a rule', t => {
  const context = fixture(t);
  context.io.readSync = () => 0;
  rejected(context.runtime.loadRules(context.root), context);
});

test('short descriptor reads load a stable rule exactly at the byte limit', t => {
  const context = fixture(t, { shortReads: true });
  const text = ruleText('trusted');
  fs.writeFileSync(context.file, text + 'x'.repeat(MAX_BYTES - Buffer.byteLength(text)));
  const result = context.runtime.loadRules(context.root);
  assert.deepEqual(result.rules.map(rule => rule.name), ['trusted']);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(context.reads.reduce((sum, size) => sum + size, 0), MAX_BYTES);
  assert.equal(context.descriptors.size, 0);
});

test('read failures close the descriptor and report a bounded diagnostic', t => {
  const context = fixture(t, { beforeRead() {
    const error = new Error('EIO injected read failure');
    error.code = 'EIO';
    throw error;
  } });
  rejected(context.runtime.loadRules(context.root), context);
});

test('a FIFO is opened nonblocking and rejected without consuming bytes', t => {
  if (process.platform === 'win32') { t.skip('POSIX FIFO required'); return; }
  const context = fixture(t, { requireNonblocking: true });
  fs.unlinkSync(context.file);
  assert.equal(spawnSync('mkfifo', [context.file]).status, 0);
  rejected(context.runtime.loadRules(context.root), context);
  assert.ok(context.flags[0] & fs.constants.O_NONBLOCK);
  assert.equal(context.reads.length, 0);
});
