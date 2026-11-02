import { z } from 'zod';

export default function createPlugin(ctx) {
  return {
    name: ctx.manifest.name,
    description: ctx.manifest.description,
    tools: [
      {
        name: 'never_runs',
        description: 'Would be registered if the apiVersion gate let it through.',
        schema: z.object({}).strict(),
        risk: 'read',
        async execute() {
          return 'unreachable';
        },
      },
    ],
  };
}
