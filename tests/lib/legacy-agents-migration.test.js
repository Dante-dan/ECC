'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { createInstallState } = require('../../scripts/lib/install-state');
const { prepareLegacyAgentsMigration, removeLegacyAgentsFiles } = require('../../scripts/lib/install/legacy-agents-migration');
function fixture(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agents-migration-')));
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function prepare(root, source = '.agents/skills/demo.md', destination = path.join(root, source)) {
  const operation = { moduleId: 'legacy', strategy: 'preserve-relative-path', scaffoldOnly: false, kind: 'copy-file', ownership: 'managed', sourceRelativePath: source,
    destinationPath: destination, contentSha256: crypto.createHash('sha256').update('managed').digest('hex') };
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(createInstallState({ adapter: { id: 'codex-home' }, targetRoot: root, installStatePath: statePath, operations: [operation], request: {}, resolution: {}, source: { manifestVersion: 1 } })));
  return prepareLegacyAgentsMigration({ adapter: { id: 'codex-home' }, targetRoot: root,
    installStatePath: statePath }, { finalState: { operations: [operation] }, warnings: [] });
}
function write(file, content = 'managed') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
test('removes verified legacy files and returns actual removed paths', () => fixture(root => {
  const file = path.join(root, '.agents/skills/demo.md'); write(file);
  assert.deepStrictEqual(removeLegacyAgentsFiles(prepare(root), root), [file]);
  assert.ok(!fs.existsSync(file));
}));
test('rejects dot and parent traversal without detaching unrelated files', () => fixture(root => {
  for (const source of ['.agents/../settings.json', '.agents/./demo.md', '.agents/skills/../../settings.json']) {
    const file = path.join(root, source); write(file);
    const migration = prepare(root, source);
    assert.strictEqual(migration.legacyAgentsOperationsToDetach.length, 0);
    removeLegacyAgentsFiles(migration, root); assert.ok(fs.existsSync(file));
  }
}));
test('unsafe ancestor produces warning and preserves outside content', () => fixture(root => {
  const outside = path.join(root, 'outside'); write(path.join(outside, 'demo.md'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  fs.symlinkSync(outside, path.join(home, '.agents'), 'dir');
  const migration = prepare(home, '.agents/demo.md');
  assert.strictEqual(migration.legacyAgentsOperationsToRemove.length, 0);
  assert.ok(migration.warnings.length); assert.ok(fs.existsSync(path.join(outside, 'demo.md')));
}));
test('preserves content changed after preparation', () => fixture(root => {
  const file = path.join(root, '.agents/skills/demo.md'); write(file);
  const migration = prepare(root); fs.writeFileSync(file, 'changed');
  assert.deepStrictEqual(removeLegacyAgentsFiles(migration, root), []);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'changed');
}));
test('quarantine identity check preserves replacement during ancestor swap', () => fixture(root => {
  const file = path.join(root, '.agents/skills/demo.md'); write(file);
  const migration = prepare(root); const outside = path.join(root, 'outside'); write(path.join(outside, 'demo.md'), 'user');
  const rename = fs.renameSync; let swapped = false;
  fs.renameSync = (source, destination) => {
    if (source === file && !swapped) {
      swapped = true; rename(path.dirname(file), path.join(root, 'saved-skills'));
      fs.symlinkSync(outside, path.dirname(file), 'dir');
    }
    return rename(source, destination);
  };
  try { assert.throws(() => removeLegacyAgentsFiles(migration, root), /changed/); }
  finally { fs.renameSync = rename; }
  assert.strictEqual(fs.readFileSync(path.join(outside, 'demo.md'), 'utf8'), 'user');
}));
test('ignores non-home migrations and empty legacy state', () => fixture(root => {
  const migration = { finalState: { operations: [] }, warnings: [] };
  const result = prepareLegacyAgentsMigration({ adapter: { id: 'cursor-project' } }, migration);
  assert.deepStrictEqual(removeLegacyAgentsFiles(result, root), []);
  const empty = prepareLegacyAgentsMigration({ adapter: { id: 'codex-home' },
    targetRoot: root, installStatePath: path.join(root, 'missing.json') }, migration);
  assert.deepStrictEqual(empty.legacyAgentsOperationsToDetach, []);
}));
test('preserves missing, symbolic, modified and unverifiable legacy files', () => fixture(root => {
  const file = path.join(root, '.agents/skills/demo.md');
  assert.strictEqual(prepare(root).legacyAgentsOperationsToRemove.length, 0);
  write(file, 'changed'); assert.ok(prepare(root).warnings.length);
  fs.unlinkSync(file); write(path.join(root, 'user.md'));
  fs.symlinkSync(path.join(root, 'user.md'), file);
  assert.ok(prepare(root).warnings.length); fs.unlinkSync(file); write(file);
  prepare(root);
  const statePath = path.join(root, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  delete state.operations[0].contentSha256; fs.writeFileSync(statePath, JSON.stringify(state));
  const migration = prepareLegacyAgentsMigration({ adapter: { id: 'codex-home' }, targetRoot: root,
    installStatePath: statePath }, { finalState: state, warnings: [] });
  assert.ok(migration.warnings[0].includes('no verified content digest'));
}));
test('digest revalidation preserves same-inode content changed during quarantine', () => fixture(root => {
  const file = path.join(root, '.agents/skills/demo.md'); write(file);
  const migration = prepare(root); const rename = fs.renameSync; let changed = false;
  fs.renameSync = (source, destination) => {
    if (source === file && !changed) { changed = true; fs.writeFileSync(source, 'changed during rename'); }
    return rename(source, destination);
  };
  try { assert.throws(() => removeLegacyAgentsFiles(migration, root), /changed/); }
  finally { fs.renameSync = rename; }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'changed during rename');
}));
