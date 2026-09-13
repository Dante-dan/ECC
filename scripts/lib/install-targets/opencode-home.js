const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildValidationIssue,
  createInstallTargetAdapter,
  createManagedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
} = require('./helpers');
const { resolveOpencodeConfigRoot } = require('../opencode-paths');

const COMPILED_PLUGIN_DIST_DIR = path.join('.opencode', 'dist');
const REQUIRED_COMPILED_ARTEFACTS = Object.freeze([
  { relativePath: path.join(COMPILED_PLUGIN_DIST_DIR, 'index.js'), expectedType: 'file' },
  { relativePath: path.join(COMPILED_PLUGIN_DIST_DIR, 'plugins', 'index.js'), expectedType: 'file' },
  { relativePath: path.join(COMPILED_PLUGIN_DIST_DIR, 'tools', 'index.js'), expectedType: 'file' },
]);
const BUILD_COMMAND_HINT = 'node scripts/build-opencode.js (or: npm run build:opencode)';
const OPENCODE_NATIVE_ROOT = '.opencode';
const SOURCE_RUNTIME_ENTRIES = new Set(['index.ts', 'plugins', 'tools']);

// Errors that mean "this artefact does not exist at the expected path / type".
// Anything else (EACCES, EIO, ...) is a genuine system fault we surface to the
// caller rather than masking as a missing artefact.
const MISSING_ARTEFACT_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR']);

function isExpectedType(absolutePath, expectedType) {
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch (error) {
    if (error && MISSING_ARTEFACT_ERROR_CODES.has(error.code)) {
      return false;
    }
    throw error;
  }
  return expectedType === 'file' ? stat.isFile() : stat.isDirectory();
}

function defaultValidateOpencodeHome(input = {}) {
  if (!input.homeDir && !os.homedir()) {
    return [
      buildValidationIssue(
        'error',
        'missing-home-dir',
        'homeDir is required for home install targets'
      ),
    ];
  }

  if (!input.repoRoot) {
    return [];
  }

  const missingPaths = REQUIRED_COMPILED_ARTEFACTS
    .map(artefact => ({
      relativePath: artefact.relativePath,
      absolutePath: path.join(input.repoRoot, artefact.relativePath),
      expectedType: artefact.expectedType,
    }))
    .filter(entry => !isExpectedType(entry.absolutePath, entry.expectedType));

  if (missingPaths.length > 0) {
    const missingList = missingPaths.map(entry => entry.relativePath).join(', ');
    return [
      buildValidationIssue(
        'error',
        'opencode-plugin-not-built',
        'OpenCode install requires the compiled plugin payload under '
          + `${COMPILED_PLUGIN_DIST_DIR}, but the following artefact(s) were `
          + `missing or had the wrong type: ${missingList}. Run `
          + `${BUILD_COMMAND_HINT} from the repo root before re-running the `
          + 'installer.',
        {
          missingPaths: missingPaths.map(entry => entry.absolutePath),
          missingRelativePaths: missingPaths.map(entry => entry.relativePath),
          expectedTypes: missingPaths.map(entry => entry.expectedType),
        }
      ),
    ];
  }

  return [];
}

function createNativeRootOperation(moduleId, sourceRelativePath, destinationPath) {
  return createManagedOperation({
    moduleId,
    sourceRelativePath,
    destinationPath,
    strategy: 'sync-root-children',
  });
}

function listCompiledRuntimeFiles(directoryPath, prefix = '') {
  let entries;
  try {
    entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error && MISSING_ARTEFACT_ERROR_CODES.has(error.code)) {
      return [];
    }
    throw error;
  }

  return entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const relativePath = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        return listCompiledRuntimeFiles(path.join(directoryPath, entry.name), relativePath);
      }
      return entry.isFile() && path.extname(entry.name) === '.js' ? [relativePath] : [];
    });
}

function planCompiledRuntimeDirectory(moduleId, input, adapter, directoryName) {
  const sourceDirectory = path.join(input.repoRoot, COMPILED_PLUGIN_DIST_DIR, directoryName);
  const targetDirectory = path.join(adapter.resolveRoot(input), directoryName);

  return listCompiledRuntimeFiles(sourceDirectory).map(relativePath => createNativeRootOperation(
    moduleId,
    path.join(COMPILED_PLUGIN_DIST_DIR, directoryName, relativePath),
    path.join(targetDirectory, relativePath)
  ));
}

function planNativeOpencodeRoot(moduleId, input, adapter) {
  if (!input.repoRoot) {
    return [adapter.createScaffoldOperation(moduleId, OPENCODE_NATIVE_ROOT, input)];
  }

  const sourceRoot = path.join(input.repoRoot, OPENCODE_NATIVE_ROOT);
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    return [];
  }

  const targetRoot = adapter.resolveRoot(input);
  const nativeOperations = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => !SOURCE_RUNTIME_ENTRIES.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => createNativeRootOperation(
      moduleId,
      path.join(OPENCODE_NATIVE_ROOT, entry.name),
      path.join(targetRoot, entry.name)
    ));

  return [
    ...nativeOperations,
    ...planCompiledRuntimeDirectory(moduleId, input, adapter, 'plugins'),
    ...planCompiledRuntimeDirectory(moduleId, input, adapter, 'tools'),
  ];
}

function planOpencodeHomeOperations(input, adapter) {
  const modules = Array.isArray(input.modules) ? input.modules : [];

  return modules.flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(sourceRelativePath => !isForeignPlatformPath(sourceRelativePath, adapter.target))
      .flatMap(sourceRelativePath => (
        normalizeRelativePath(sourceRelativePath) === OPENCODE_NATIVE_ROOT
          ? planNativeOpencodeRoot(module.id, input, adapter)
          : [adapter.createScaffoldOperation(module.id, sourceRelativePath, input)]
      ));
  });
}

module.exports = createInstallTargetAdapter({
  id: 'opencode-home',
  target: 'opencode',
  kind: 'home',
  rootSegments: ['.config', 'opencode'],
  resolveRoot: resolveOpencodeConfigRoot,
  installStatePathSegments: ['ecc-install-state.json'],
  nativeRootRelativePath: '.opencode',
  validate: defaultValidateOpencodeHome,
  planOperations: planOpencodeHomeOperations,
});
