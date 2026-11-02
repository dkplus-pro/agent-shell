import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { ToolError } from '../../../packages/core/src/errors/index.js';
import { defineTool } from '../../../packages/core/src/tools/types.js';

/**
 * A `read_file` on a 200 MB log would blow up both the model context and the
 * trace preview, so the example refuses instead of silently truncating.
 */
const MAX_READ_BYTES = 512 * 1024;

export const readFileArgsSchema = z.object({
  path: z.string().min(1).describe('File to read, relative to the workspace root.'),
});

export type ReadFileArgs = z.infer<typeof readFileArgsSchema>;

/**
 * Code tool, risk `read`: auto-approved, but still path-guarded. The boundary is
 * `ctx.resolveWorkspacePath`, which is the only sanctioned way to turn a model
 * supplied path into an absolute one (AGENT.md §5); `..`, out-of-tree absolute
 * paths and symlink escapes all throw before a single byte is opened.
 */
export const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace and return its contents.',
  schema: readFileArgsSchema,
  risk: 'read',
  timeoutMs: 10_000,
  idempotent: true,
  async execute(args, ctx) {
    // The executor validates too; a tool never trusts its caller (defence in depth).
    const input = readFileArgsSchema.parse(args);
    const target = ctx.resolveWorkspacePath(input.path);
    ctx.log('debug', 'read_file: reading workspace file', { target });

    // `stat`/`mkdir` take no AbortSignal in this Node typing; the executor's
    // timeout and the readFile signal cover cancellation.
    const info = await stat(target);
    if (!info.isFile()) {
      throw new ToolError(`read_file: "${input.path}" is not a regular file`);
    }
    if (info.size > MAX_READ_BYTES) {
      throw new ToolError(
        `read_file: "${input.path}" is ${String(info.size)} bytes; limit is ${String(MAX_READ_BYTES)}`,
      );
    }

    const content = await readFile(target, { encoding: 'utf8', signal: ctx.signal });
    ctx.log('info', 'read_file: read complete', { target, bytes: content.length });
    return content;
  },
});
