/**
 * Regression tests for bounded hook stdin reads.
 */

'use strict';

const assert = require('assert');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const path = require('path');
const { readStdinRaw, resolveStdinTimeout, DEFAULT_STDIN_TIMEOUT_MS } = require('../../scripts/hooks/hook-input');
const { run: runConfigProtection } = require('../../scripts/hooks/config-protection');

const TEST_STDIN_LIMIT = 1024;
const STREAM_SETTLEMENT_TIMEOUT_MS = 500;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function readFromErroredStream(partialInput) {
  const stream = new PassThrough();
  const resultPromise = readStdinRaw(stream, { maxStdin: TEST_STDIN_LIMIT });
  stream.write(partialInput);
  stream.destroy(new Error('simulated stdin read failure'));
  return resultPromise;
}

async function readFromClosedStream(partialInput) {
  const stream = new PassThrough();
  const resultPromise = readStdinRaw(stream, { maxStdin: TEST_STDIN_LIMIT });
  stream.write(partialInput);
  stream.destroy();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('readStdinRaw did not settle after stream close')),
      STREAM_SETTLEMENT_TIMEOUT_MS
    );
    resultPromise.then(
      result => {
        clearTimeout(timer);
        resolve(result);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function withDeadline(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stdin read did not meet its deadline')), 1000);
    promise.then(
      result => { clearTimeout(timer); resolve(result); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function runWithOpenStdin(script, args = [], input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../../scripts/hooks', script), ...args], {
      env: { ...process.env, ECC_HOOK_INPUT_TIMEOUT_MS: '40', ECC_HOOK_PROFILE: 'standard' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    child.stdin.on('error', () => {});
    if (input) child.stdin.write(input);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} kept waiting for EOF`));
    }, 1500);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

async function runTests() {
  console.log('\nHook input reader tests:');

  let passed = 0;
  let failed = 0;

  if (
    await test('clean end preserves complete input', async () => {
      const stream = new PassThrough();
      const resultPromise = readStdinRaw(stream, { maxStdin: TEST_STDIN_LIMIT });
      stream.end('{"complete":true}');

      assert.deepStrictEqual(await resultPromise, {
        raw: '{"complete":true}',
        truncated: false
      });
    })
  )
    passed++;
  else failed++;

  if (
    await test('stream error marks partial input as truncated', async () => {
      const partialInput = '{"tool_name":"Write","tool_input":{';
      const result = await readFromErroredStream(partialInput);

      assert.strictEqual(result.raw, partialInput);
      assert.strictEqual(result.truncated, true);
    })
  )
    passed++;
  else failed++;

  if (
    await test('close without end marks partial input as truncated', async () => {
      const partialInput = '{"tool_name":"Write","tool_input":{';
      const result = await readFromClosedStream(partialInput);

      assert.strictEqual(result.raw, partialInput);
      assert.strictEqual(result.truncated, true);
    })
  )
    passed++;
  else failed++;

  if (
    await test('errored partial PreToolUse input remains fail closed', async () => {
      const partialInput = '{"tool_name":"Write","tool_input":{"file_path":".eslintrc.js"';
      const inputResult = await readFromErroredStream(partialInput);
      const hookResult = runConfigProtection(inputResult.raw, {
        truncated: inputResult.truncated,
        maxStdin: TEST_STDIN_LIMIT
      });

      assert.strictEqual(inputResult.truncated, true);
      assert.strictEqual(hookResult.exitCode, 2);
      assert.match(hookResult.stderr, /Refusing to bypass config-protection/);
    })
  )
    passed++;
  else failed++;

  for (const [name, fn] of [
    ['timeout configuration rejects invalid or overflowing timer delays', async () => {
      for (const value of [undefined, '', 'no', '0', '-1', '1.5', '2147483648']) {
        assert.strictEqual(resolveStdinTimeout(value), DEFAULT_STDIN_TIMEOUT_MS);
      }
      assert.strictEqual(resolveStdinTimeout('50'), 50);
    }],
    ['open empty stream settles as incomplete', async () => {
      const stream = new PassThrough();
      const result = await withDeadline(readStdinRaw(stream, { timeoutMs: 20 }));
      assert.deepStrictEqual(result, { raw: '', truncated: true });
      assert.strictEqual(stream.listenerCount('data'), 0);
      stream.destroy();
    }],
    ['deadline preserves received input and safety hooks remain fail closed', async () => {
      const stream = new PassThrough();
      const pending = readStdinRaw(stream, { timeoutMs: 20 });
      stream.write('{"tool_name":"Write","tool_input":{"file_path":".eslintrc.js"}}');
      const result = await withDeadline(pending);
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(runConfigProtection(result.raw, { truncated: result.truncated }).exitCode, 2);
      stream.write('ignored after deadline');
      assert.ok(!result.raw.includes('ignored'));
      stream.destroy();
    }],
    ['deadline does not reset when more chunks arrive', async () => {
      const stream = new PassThrough();
      const pending = readStdinRaw(stream, { timeoutMs: 30 });
      const writer = setInterval(() => stream.write('x'), 5);
      try {
        const result = await withDeadline(pending);
        assert.strictEqual(result.truncated, true);
      } finally {
        clearInterval(writer);
        stream.destroy();
      }
    }],
    ['normal EOF cancels deadline and releases listeners', async () => {
      const stream = new PassThrough();
      const pending = readStdinRaw(stream, { timeoutMs: 20 });
      stream.end('{}');
      assert.deepStrictEqual(await pending, { raw: '{}', truncated: false });
      assert.strictEqual(stream.listenerCount('data'), 0);
      await new Promise(resolve => setTimeout(resolve, 40));
    }],
    ['hook entry points exit while parent holds stdin open', async () => {
      for (const [script, args, expected, input] of [
        ['run-with-flags.js', ['pre:write:doc-file-warning', 'scripts/hooks/doc-file-warning.js', 'standard,strict'], 0],
        ['run-with-flags.js', ['pre:config-protection', 'scripts/hooks/config-protection.js', 'standard,strict'], 2, '{"tool_name":"Write","tool_input":{"file_path":".eslintrc.js"}}'],
        ['pre-bash-dispatcher.js', [], 2],
        ['post-bash-dispatcher.js', [], 0],
        ['bash-hook-dispatcher.js', ['pre'], 2],
        ['bash-hook-dispatcher.js', ['post'], 0]
      ]) {
        const result = await runWithOpenStdin(script, args, input);
        assert.strictEqual(result.code, expected, `${script}: ${result.stderr}`);
      }
    }]
  ]) {
    if (await test(name, fn)) passed++; else failed++;
  }

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
