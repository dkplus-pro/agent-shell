/**
 * `word-count` plugin entry (docs/04-testing-and-acceptance.md §2.4, Act 2).
 *
 * A plugin is loaded in-process and runs with the shell's full Node privileges:
 * this file is trusted local code, not a sandbox (ADR-0007). Registration
 * namespaces the tool as `plugin__word_count__word_count` (docs/01 §5.4).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { definePlugin, definePluginTool } from '@agent-shell/core/plugin';
import { measure } from './count-words.mjs';

const argsSchema = z.object({
  path: z.string().min(1).describe('Workspace-relative file to count.'),
});

/**
 * Risk is declared explicitly: a plugin tool without a risk level is a
 * registration error, never a default (AGENT.md §2).
 */
const wordCountTool = definePluginTool({
  name: 'word_count',
  description: 'Count words, lines and characters in a workspace file.',
  schema: argsSchema,
  risk: 'read',
  timeoutMs: 10_000,
  idempotent: true,
  async execute(args, ctx) {
    const input = argsSchema.parse(args);
    // Same workspace guard the code tools use: a plugin is trusted, but a model
    // supplied path still is not.
    const target = ctx.resolveWorkspacePath(input.path);
    ctx.log('info', 'word_count: reading file', { target });
    const text = await readFile(target, { encoding: 'utf8', signal: ctx.signal });
    return { path: path.relative(ctx.workspaceRoot, target), ...measure(text) };
  },
});

export default definePlugin((ctx) => ({
  name: ctx.manifest.name,
  description: ctx.manifest.description,
  tools: [wordCountTool],
}));
