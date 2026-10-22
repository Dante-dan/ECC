#!/usr/bin/env node
'use strict';

const { runPostBash } = require('./bash-hook-dispatcher');

const { readStdinRaw, resolveMaxStdin } = require('./hook-input');

readStdinRaw(process.stdin, {
  maxStdin: resolveMaxStdin(process.env.ECC_HOOK_INPUT_MAX_BYTES)
}).then(({ raw, truncated }) => {
  // Never run audit/side-effect hooks on an incomplete request.
  if (truncated) return;
  const result = runPostBash(raw);
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}).catch(error => {
  process.stderr.write(`[Hook] post-bash dispatcher failed: ${error.message}\n`);
  process.exitCode = 0;
});
