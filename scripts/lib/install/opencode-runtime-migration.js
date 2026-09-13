'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { readInstallState } = require('../install-state');
const { assertWithinTrustedRoot } = require('../path-safety');

function comparablePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeRelativePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function isManagedRuntimeSource(plan, operation) {
  if (!operation || operation.kind !== 'copy-file' || operation.ownership !== 'managed') {
    return false;
  }

  const source = normalizeRelativePath(operation.sourceRelativePath);
  const relativeDestination = normalizeRelativePath(path.relative(
    plan.targetRoot,
    operation.destinationPath || ''
  ));
  const match = source.match(/^\.opencode\/(plugins|tools)\/(.+\.ts)$/)
    || source.match(/^\.opencode\/dist\/(plugins|tools)\/(.+\.js)$/);
  return Boolean(match) && relativeDestination === `${match[1]}/${match[2]}`;
}

function readManagedFile(plan, operation) {
  assertWithinTrustedRoot(operation.destinationPath, plan.targetRoot, 'inspect OpenCode runtime migration');
  let stat;
  try {
    stat = fs.lstatSync(operation.destinationPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing to migrate non-file OpenCode runtime source: ${operation.destinationPath}`);
  }
  return fs.readFileSync(operation.destinationPath);
}

function assertUnmodifiedManagedSource(plan, operation) {
  const content = readManagedFile(plan, operation);
  if (content === null) {
    return;
  }
  if (!operation.contentSha256) {
    throw new Error(`Refusing to remove unverifiable managed OpenCode runtime source: ${operation.destinationPath}`);
  }
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  if (digest !== operation.contentSha256) {
    throw new Error(`Refusing to remove modified managed OpenCode runtime source: ${operation.destinationPath}`);
  }
}

function prepareOpencodeRuntimeMigration(plan, migration) {
  if (!plan.adapter || plan.adapter.id !== 'opencode-home' || !fs.existsSync(plan.installStatePath)) {
    return { ...migration, opencodeRuntimeOperationsToRemove: [] };
  }

  const previousState = readInstallState(plan.installStatePath);
  const currentDestinations = new Set(plan.operations
    .filter(operation => operation.destinationPath)
    .map(operation => comparablePath(operation.destinationPath)));
  const operationsToRemove = (previousState.operations || []).filter(operation => (
    isManagedRuntimeSource(plan, operation)
    && !currentDestinations.has(comparablePath(operation.destinationPath))
  ));

  for (const operation of operationsToRemove) {
    assertUnmodifiedManagedSource(plan, operation);
  }

  const removedDestinations = new Set(
    operationsToRemove.map(operation => comparablePath(operation.destinationPath))
  );
  return {
    ...migration,
    finalState: {
      ...migration.finalState,
      operations: migration.finalState.operations.filter(operation => (
        !operation.destinationPath
        || !removedDestinations.has(comparablePath(operation.destinationPath))
      )),
    },
    opencodeRuntimeOperationsToRemove: operationsToRemove,
  };
}

function removeLegacyOpencodeRuntimeSources(plan, migration) {
  for (const operation of migration.opencodeRuntimeOperationsToRemove || []) {
    assertUnmodifiedManagedSource(plan, operation);
    if (fs.existsSync(operation.destinationPath)) {
      fs.unlinkSync(operation.destinationPath);
    }
  }
}

module.exports = {
  prepareOpencodeRuntimeMigration,
  removeLegacyOpencodeRuntimeSources,
};
