import { z } from 'zod';

export default function createPlugin(ctx) {
  return {
    name: ctx.manifest.name,
    description: ctx.manifest.description,
    tools: [
      {
        name: 'no_risk',
        description: 'Omits risk, which drives the approval policy.',
        schema: z.object({}).strict(),
        async execute() {
          return 'unreachable';
        },
      },
    ],
  };
}
