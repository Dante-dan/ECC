'use strict';

const { StringDecoder } = require('string_decoder');

const DEFAULT_MAX_STDIN = 1024 * 1024;
const DEFAULT_STDIN_TIMEOUT_MS = 3000;

function resolveStdinTimeout(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2147483647
    ? parsed
    : DEFAULT_STDIN_TIMEOUT_MS;
}

function resolveMaxStdin(value, options = {}) {
  const writeDiagnostic = options.writeDiagnostic || (() => {});
  if (value === undefined || value === '') return DEFAULT_MAX_STDIN;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    writeDiagnostic(
      '[Hook] ECC_HOOK_INPUT_MAX_BYTES must be a positive safe integer; using the 1 MiB default\n'
    );
    return DEFAULT_MAX_STDIN;
  }
  if (parsed > DEFAULT_MAX_STDIN) {
    writeDiagnostic(
      '[Hook] ECC_HOOK_INPUT_MAX_BYTES exceeds the 1 MiB safety maximum; clamping to 1 MiB\n'
    );
    return DEFAULT_MAX_STDIN;
  }
  return parsed;
}

function readStdinRaw(stream = process.stdin, options = {}) {
  const maxStdin = options.maxStdin || DEFAULT_MAX_STDIN;
  const decoder = new StringDecoder('utf8');
  let raw = '';
  let acceptedBytes = 0;
  let truncated = options.truncated === true;

  return new Promise(resolve => {
    let settled = false;
    const onData = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (typeof options.onChunk === 'function') options.onChunk(buffer);
      const remaining = Math.max(0, maxStdin - acceptedBytes);
      const accepted = buffer.subarray(0, remaining);
      if (accepted.length > 0) {
        raw += decoder.write(accepted);
        acceptedBytes += accepted.length;
      }
      if (accepted.length < buffer.length) truncated = true;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', finish);
      stream.removeListener('close', finishIncomplete);
      // Stop reading an open pipe so a fulfilled read does not keep the hook alive.
      stream.pause();
      if (!truncated) raw += decoder.end();
      resolve({ raw, truncated });
    };
    const finishIncomplete = () => {
      if (settled) return;
      truncated = true;
      finish();
    };
    stream.on('data', onData);
    stream.once('end', finish);
    // A transport error or premature close can leave a syntactically plausible
    // prefix behind. Mark it incomplete so safety hooks remain fail closed.
    stream.once('error', finishIncomplete);
    stream.once('close', finishIncomplete);
    // An overall deadline also bounds a parent that keeps sending small chunks.
    const timer = setTimeout(finishIncomplete, resolveStdinTimeout(
      options.timeoutMs ?? process.env.ECC_HOOK_INPUT_TIMEOUT_MS
    ));
    timer.unref();
  });
}

module.exports = {
  DEFAULT_MAX_STDIN,
  DEFAULT_STDIN_TIMEOUT_MS,
  resolveStdinTimeout,
  readStdinRaw,
  resolveMaxStdin
};
