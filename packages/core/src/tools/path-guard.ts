import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceBoundaryError } from '../errors/index.js';

export interface GuardOptions {
  workspaceRoot: string;
  allowOutsideWorkspace?: boolean;
}

/**
 * Workspace boundary (docs/01-architecture.md §7): normalize -> reject `..`
 * escapes -> resolve realpath of the deepest existing ancestor -> re-check
 * containment. Every rejection is a WorkspaceBoundaryError, and paths are only
 * ever combined with `path.resolve`, never string concatenation.
 */
export function resolveWorkspacePath(input: string, opts: GuardOptions): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new WorkspaceBoundaryError(String(input), 'path must be a non-empty string');
  }
  if (input.includes('\0')) {
    throw new WorkspaceBoundaryError(input, 'path must not contain NUL bytes');
  }
  const root = resolveRoot(opts.workspaceRoot);
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);

  if (!isInsideRoot(candidate, root)) {
    if (opts.allowOutsideWorkspace === true) return candidate;
    const reason = path.isAbsolute(input)
      ? 'absolute path outside the workspace root'
      : '`..` segment escapes the workspace root';
    throw new WorkspaceBoundaryError(input, reason);
  }

  const realCandidate = resolveRealpath(candidate);
  if (!isInsideRoot(realCandidate, root)) {
    if (opts.allowOutsideWorkspace === true) return realCandidate;
    const escapee = realCandidate === candidate ? candidate : path.dirname(realCandidate);
    throw new WorkspaceBoundaryError(input, `symlink escape via ${escapee}`);
  }
  return realCandidate;
}

export function isInsideRoot(absolutePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(absolutePath));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0] !== '..';
}

/** Convenience wrapper for tool authors: keeps the tool name in the error. */
export function guardToolPath(name: string, input: string, opts: GuardOptions): string {
  try {
    return resolveWorkspacePath(input, opts);
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) {
      const reason = String(error.fields['reason'] ?? 'outside workspace');
      throw new WorkspaceBoundaryError(input, `${reason}; required by tool "${name}"`);
    }
    throw error;
  }
}

function resolveRoot(workspaceRoot: string): string {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw new WorkspaceBoundaryError(
      String(workspaceRoot),
      'workspaceRoot must be a non-empty path',
    );
  }
  const absolute = path.resolve(workspaceRoot);
  if (!existsSync(absolute)) {
    throw new WorkspaceBoundaryError(workspaceRoot, 'workspace root does not exist');
  }
  return realpathSync(absolute);
}

/**
 * A not-yet-existing target is validated through its deepest existing ancestor,
 * so `docs/../../etc/passwd` and `link/outside` are judged on real paths.
 */
function resolveRealpath(candidate: string): string {
  let cursor = candidate;
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return candidate;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realAncestor = realpathSync(cursor);
  return missing.length === 0 ? realAncestor : path.resolve(realAncestor, ...missing);
}
