import path from 'node:path';
import fs from 'node:fs';

/** Resolve a user-provided relative path and enforce a separator-aware boundary. */
export function resolveContainedPath(rootDirectory, requestedPath = '') {
  if (typeof requestedPath !== 'string' || requestedPath.includes('\0')) {
    throw new TypeError('Invalid path');
  }
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error('Access denied');
    error.code = 'PATH_OUTSIDE_ROOT';
    throw error;
  }

  // Existing symlinks must not turn an apparently-contained path into an
  // escape. For a new path, validate its nearest existing parent as well.
  let existing = resolved;
  while (!fs.existsSync(existing) && existing !== root && path.dirname(existing) !== existing) {
    existing = path.dirname(existing);
  }
  const realRoot = fs.realpathSync(root);
  const realExisting = fs.realpathSync(existing);
  const realRelative = path.relative(realRoot, realExisting);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    const error = new Error('Access denied');
    error.code = 'PATH_OUTSIDE_ROOT';
    throw error;
  }
  return resolved;
}
