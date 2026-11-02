import { z } from 'zod';

/**
 * Test fixtures never import `@agent-shell/core`, so they need no build step and
 * exercise the loader exactly like a real third-party plugin would. `definePlugin`
 * is an identity helper, so it is mirrored here.
 */
function definePlugin(factory) {
  return factory;
}

const countWordsTool = {
  name: 'count_words',
  description: 'Count the words in a block of text.',
  schema: z.object({ text: z.string() }).strict(),
  risk: 'read',
  idempotent: true,
  async execute(args) {
    const words = args.text
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0);
    return { words: words.length, characters: args.text.length };
  },
};

export default definePlugin((ctx) => ({
  name: ctx.manifest.name,
  description: ctx.manifest.description,
  tools: [countWordsTool],
}));
