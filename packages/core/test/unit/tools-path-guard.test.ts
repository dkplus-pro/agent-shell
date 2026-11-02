import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceBoundaryError } from '../../src/errors/index.js';
import {
  guardToolPath,
  isInsideRoot,
  resolveWorkspacePath,
  type GuardOptions,
} from '../../src/tools/path-guard.js';

let workspace = '';
let outside = '';

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'agent-shell-guard-'));
  workspace = path.join(base, 'workspace');
  outside = path.join(base, 'outside');
  mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  writeFileSync(path.join(workspace, 'docs', 'note.md'), 'note');
});

afterEach(() => {
  rmSync(path.dirname(workspace), { recursive: true, force: true });
});

function opts(overrides: Partial<GuardOptions> = {}): GuardOptions {
  return { workspaceRoot: workspace, ...overrides };
}

describe('resolveWorkspacePath', () => {
  it('resolves relative paths inside the workspace to absolute paths', () => {
    const resolved = resolveWorkspacePath('docs/note.md', opts());
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(path.join(workspace, 'docs', 'note.md'));
  });

  it('accepts an absolute path that stays inside the workspace', () => {
    expect(resolveWorkspacePath(path.join(workspace, 'docs', 'note.md'), opts())).toBe(
      path.join(workspace, 'docs', 'note.md'),
    );
  });

  it('allows `..` segments that stay inside the workspace', () => {
    expect(resolveWorkspacePath('docs/../docs/note.md', opts())).toBe(
      path.join(workspace, 'docs', 'note.md'),
    );
    expect(resolveWorkspacePath(path.join(workspace, 'docs', '..', 'note.md'), opts())).toBe(
      path.join(workspace, 'note.md'),
    );
  });

  it('rejects a relative `..` escape', () => {
    expect(() => resolveWorkspacePath('../x', opts())).toThrow(WorkspaceBoundaryError);
    expect(() => resolveWorkspacePath('../x', opts())).toThrow(/escapes the workspace root/);
    expect(() => resolveWorkspacePath('docs/../../x', opts())).toThrow(WorkspaceBoundaryError);
    try {
      resolveWorkspacePath('../x', opts());
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceBoundaryError);
      const boundary = error as WorkspaceBoundaryError;
      expect(boundary.code).toBe('PATH_OUTSIDE_WORKSPACE');
      expect(boundary.exitCode).toBe(4);
      expect(boundary.fields['path']).toBe('../x');
    }
  });

  it('rejects an absolute path outside the workspace such as /etc/passwd', () => {
    expect(() => resolveWorkspacePath('/etc/passwd', opts())).toThrow(WorkspaceBoundaryError);
    expect(() => resolveWorkspacePath('/etc/passwd', opts())).toThrow(
      /absolute path outside the workspace root/,
    );
    expect(() => resolveWorkspacePath(path.join(outside, 'secret.txt'), opts())).toThrow(
      WorkspaceBoundaryError,
    );
  });

  it("rejects a sibling directory that shares the root's name prefix", () => {
    const sibling = `${workspace}-evil`;
    mkdirSync(sibling, { recursive: true });
    expect(() => resolveWorkspacePath(sibling, opts())).toThrow(WorkspaceBoundaryError);
    expect(isInsideRoot(sibling, workspace)).toBe(false);
  });

  it('rejects empty and non-string input', () => {
    expect(() => resolveWorkspacePath('', opts())).toThrow(/non-empty string/);
    expect(() => resolveWorkspacePath('   ', opts())).toThrow(WorkspaceBoundaryError);
    expect(() => resolveWorkspacePath('a\0b', opts())).toThrow(/NUL/);
    expect(() => resolveWorkspacePath(undefined as unknown as string, opts())).toThrow(
      WorkspaceBoundaryError,
    );
  });

  it('rejects a symlink that points outside the workspace', () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'escape.txt'));
    expect(() => resolveWorkspacePath('escape.txt', opts())).toThrow(WorkspaceBoundaryError);
    expect(() => resolveWorkspacePath('escape.txt', opts())).toThrow(/symlink escape/);
  });

  it('rejects a directory symlink that points outside the workspace', () => {
    symlinkSync(outside, path.join(workspace, 'out'));
    expect(() => resolveWorkspacePath(path.join(workspace, 'out', 'secret.txt'), opts())).toThrow(
      /symlink escape/,
    );
  });

  it('validates the realpath of the containing directory for a new file', () => {
    symlinkSync(outside, path.join(workspace, 'out'));
    expect(() => resolveWorkspacePath('out/new.txt', opts())).toThrow(WorkspaceBoundaryError);
    expect(() => resolveWorkspacePath('out/new.txt', opts())).toThrow(/symlink escape/);
    // A new file in a real directory inside the workspace is fine.
    expect(resolveWorkspacePath('docs/draft.md', opts())).toBe(
      path.join(workspace, 'docs', 'draft.md'),
    );
    // Deeply missing parents are validated against the deepest existing ancestor.
    expect(resolveWorkspacePath('docs/a/b/c.md', opts())).toBe(
      path.join(workspace, 'docs', 'a', 'b', 'c.md'),
    );
  });

  it('rejects a new file whose parent directory is outside the root', () => {
    expect(() => resolveWorkspacePath(path.join(outside, 'sub', 'new.txt'), opts())).toThrow(
      WorkspaceBoundaryError,
    );
    expect(() => resolveWorkspacePath('../outside/sub/new.txt', opts())).toThrow(
      WorkspaceBoundaryError,
    );
  });

  it('keeps unicode and case-distinct names inside the workspace', () => {
    mkdirSync(path.join(workspace, 'ünïcode', 'Docs'), { recursive: true });
    expect(resolveWorkspacePath('ünïcode/Docs/a.txt', opts())).toBe(
      path.join(workspace, 'ünïcode', 'Docs', 'a.txt'),
    );
    // "DOCS" is a different directory on a case-sensitive filesystem.
    expect(() =>
      resolveWorkspacePath(path.join(workspace, 'DOCS', '..', '..', 'x'), opts()),
    ).toThrow(WorkspaceBoundaryError);
  });

  it('resolves the workspace root itself, even when declared with a `..`', () => {
    expect(resolveWorkspacePath('.', opts())).toBe(workspace);
    expect(
      resolveWorkspacePath('.', { ...opts(), workspaceRoot: path.join(workspace, 'docs', '..') }),
    ).toBe(workspace);
    expect(
      resolveWorkspacePath('note.md', {
        ...opts(),
        workspaceRoot: path.join(workspace, 'docs', '..'),
      }),
    ).toBe(path.join(workspace, 'note.md'));
  });

  it('follows a symlinked workspace root', () => {
    const linkRoot = path.join(outside, 'linked-ws');
    symlinkSync(workspace, linkRoot);
    expect(resolveWorkspacePath('docs/note.md', { workspaceRoot: linkRoot })).toBe(
      path.join(workspace, 'docs', 'note.md'),
    );
  });

  it('honours the allowOutsideWorkspace escape hatch', () => {
    expect(resolveWorkspacePath('/etc/passwd', opts({ allowOutsideWorkspace: true }))).toBe(
      '/etc/passwd',
    );
    expect(resolveWorkspacePath('../x', opts({ allowOutsideWorkspace: true }))).toBe(
      path.resolve(path.dirname(workspace), 'x'),
    );
    symlinkSync(outside, path.join(workspace, 'out'));
    expect(resolveWorkspacePath('out/new.txt', opts({ allowOutsideWorkspace: true }))).toBe(
      path.join(outside, 'new.txt'),
    );
  });

  it('rejects a missing workspace root', () => {
    expect(() =>
      resolveWorkspacePath('a.txt', { workspaceRoot: path.join(workspace, 'nope') }),
    ).toThrow(/workspace root does not exist/);
    expect(() => resolveWorkspacePath('a.txt', { workspaceRoot: '  ' })).toThrow(
      WorkspaceBoundaryError,
    );
  });
});

describe('isInsideRoot', () => {
  it('treats the root as inside itself and rejects escapes', () => {
    expect(isInsideRoot(workspace, workspace)).toBe(true);
    expect(isInsideRoot(path.join(workspace, 'a', 'b'), workspace)).toBe(true);
    expect(isInsideRoot(path.dirname(workspace), workspace)).toBe(false);
    expect(isInsideRoot(`${workspace}x`, workspace)).toBe(false);
    expect(isInsideRoot('/etc/passwd', workspace)).toBe(false);
  });

  it('normalises before comparing', () => {
    expect(isInsideRoot(path.join(workspace, 'a', '..', 'b'), workspace)).toBe(true);
  });
});

describe('guardToolPath', () => {
  it('returns the guarded path for a tool author', () => {
    expect(guardToolPath('read_file', 'docs/note.md', opts())).toBe(
      path.join(workspace, 'docs', 'note.md'),
    );
  });

  it('names the tool in the rejection', () => {
    expect(() => guardToolPath('write_file', '/etc/passwd', opts())).toThrow(
      WorkspaceBoundaryError,
    );
    expect(() => guardToolPath('write_file', '/etc/passwd', opts())).toThrow(
      /required by tool "write_file"/,
    );
  });

  it('still guards a non-string workspace root', () => {
    expect(() =>
      guardToolPath('write_file', '', { workspaceRoot: 123 as unknown as string }),
    ).toThrow(WorkspaceBoundaryError);
  });
});
