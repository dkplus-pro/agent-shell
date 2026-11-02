import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ToolError } from '../../../packages/core/src/errors/index.js';
import { defineTool } from '../../../packages/core/src/tools/types.js';

export const writeFileArgsSchema = z.object({
  path: z.string().min(1).describe('File to write, relative to the workspace root.'),
  content: z.string().describe('Full file contents; the file is replaced, not appended.'),
});

export type WriteFileArgs = z.infer<typeof writeFileArgsSchema>;

const MAX_WRITE_BYTES = 1024 * 1024;

/**
 * Code tool, risk `write`: one approval (docs/01 §5.5). The approval shows the
 * verbatim `path`, so the argument name is part of the contract, and the write
 * itself goes through the workspace path guard before touching the disk.
 */
export const writeFileTool = defineTool({
  name: 'write_file',
  description: 'Create or replace a UTF-8 text file inside the workspace.',
  schema: writeFileArgsSchema,
  risk: 'write',
  timeoutMs: 10_000,
  idempotent: true,
  async execute(args, ctx) {
    const input = writeFileArgsSchema.parse(args);
    const target = ctx.resolveWorkspacePath(input.path);
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      // A refused write is a tool error the model can correct, not a crash.
      throw new ToolError(
        `write_file: content is ${String(bytes)} bytes; limit is ${String(MAX_WRITE_BYTES)}`,
      );
    }

    ctx.log('info', 'write_file: writing workspace file', { target, bytes });
    // Only directories inside the (already guarded) target are created; `mkdir`
    // takes no AbortSignal in this Node typing, the writeFile call below does.
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.content, { encoding: 'utf8', signal: ctx.signal });

    return { path: path.relative(ctx.workspaceRoot, target), bytesWritten: bytes };
  },
});
