'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { readInstallState } = require('../install-state');
const { assertWithinTrustedRoot } = require('../path-safety');

const HOME_TARGET_IDS = new Set(['claude-home', 'codex-home']);

function comparablePath(filePath) {
  const resolvedPath = path.resolve(filePath);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/');
}

function isLegacyAgentsOperation(plan, operation) {
  if (
    !operation
    || operation.kind !== 'copy-file'
    || operation.ownership !== 'managed'
    || typeof operation.destinationPath !== 'string'
  ) {
    return false;
  }

  const sourceRelativePath = normalizeRelativePath(operation.sourceRelativePath);
  if (!sourceRelativePath.startsWith('.agents/')) {
    return false;
  }

  const expectedDestination = path.join(
    plan.targetRoot,
    ...sourceRelativePath.split('/')
  );
  return comparablePath(operation.destinationPath) === comparablePath(expectedDestination);
}

function inspectLegacyAgentsOperation(plan, operation) {
  assertWithinTrustedRoot(
    operation.destinationPath,
    plan.targetRoot,
    'inspect legacy managed .agents file'
  );

  let stat;
  try {
    stat = fs.lstatSync(operation.destinationPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { removable: false, warning: null };
    }
    throw error;
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      removable: false,
      warning: `Preserved legacy .agents path ${operation.destinationPath}: it is not a regular file.`,
    };
  }

  if (!/^[a-f0-9]{64}$/i.test(operation.contentSha256 || '')) {
    return {
      removable: false,
      warning: `Preserved legacy .agents file ${operation.destinationPath}: install-state has no verified content digest.`,
    };
  }

  const contentSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(operation.destinationPath))
    .digest('hex');
  if (contentSha256 !== operation.contentSha256.toLowerCase()) {
    return {
      removable: false,
      warning: `Preserved modified legacy .agents file ${operation.destinationPath} and released it from ECC management.`,
    };
  }

  return { removable: true, warning: null };
}

function prepareLegacyAgentsMigration(plan, migration) {
  if (!HOME_TARGET_IDS.has(plan && plan.adapter && plan.adapter.id)) {
    return {
      ...migration,
      legacyAgentsOperationsToDetach: [],
      legacyAgentsOperationsToRemove: [],
    };
  }

  const previousState = fs.existsSync(plan.installStatePath)
    ? readInstallState(plan.installStatePath)
    : null;
  const legacyOperations = ((previousState && previousState.operations) || [])
    .filter(operation => isLegacyAgentsOperation(plan, operation));
  if (legacyOperations.length === 0) {
    return {
      ...migration,
      legacyAgentsOperationsToDetach: [],
      legacyAgentsOperationsToRemove: [],
    };
  }

  const inspections = legacyOperations.map(operation => ({
    operation,
    ...inspectLegacyAgentsOperation(plan, operation),
  }));
  const legacyDestinations = new Set(
    legacyOperations.map(operation => comparablePath(operation.destinationPath))
  );
  const withoutLegacyAgents = state => ({
    ...state,
    operations: (state.operations || []).filter(operation => (
      !legacyDestinations.has(comparablePath(operation.destinationPath))
    )),
  });

  return {
    ...migration,
    finalState: withoutLegacyAgents(migration.finalState),
    legacyAgentsOperationsToDetach: legacyOperations,
    legacyAgentsOperationsToRemove: inspections
      .filter(inspection => inspection.removable)
      .map(inspection => inspection.operation),
    requiresBridgeState: true,
    warnings: [
      ...(migration.warnings || []),
      ...inspections.map(inspection => inspection.warning).filter(Boolean),
    ],
  };
}

function cleanupEmptyAgentsParents(filePath, targetRoot) {
  const agentsRoot = path.join(targetRoot, '.agents');
  let currentPath = path.dirname(filePath);

  while (comparablePath(currentPath) !== comparablePath(targetRoot)) {
    assertWithinTrustedRoot(currentPath, targetRoot, 'clean legacy managed .agents directory');
    if (!fs.existsSync(currentPath) || fs.readdirSync(currentPath).length > 0) {
      return;
    }
    fs.rmdirSync(currentPath);
    if (comparablePath(currentPath) === comparablePath(agentsRoot)) {
      return;
    }
    currentPath = path.dirname(currentPath);
  }
}

function removeLegacyAgentsFiles(migration, targetRoot) {
  for (const operation of migration.legacyAgentsOperationsToRemove || []) {
    const latestInspection = inspectLegacyAgentsOperation(
      { targetRoot },
      operation
    );
    if (!latestInspection.removable) {
      continue;
    }
    fs.rmSync(operation.destinationPath, { force: true });
    cleanupEmptyAgentsParents(operation.destinationPath, targetRoot);
  }
}

module.exports = {
  prepareLegacyAgentsMigration,
  removeLegacyAgentsFiles,
};
