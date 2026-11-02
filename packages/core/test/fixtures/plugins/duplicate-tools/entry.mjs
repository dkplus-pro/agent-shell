import { z } from 'zod';

const schema = z.object({}).strict();

function tool(name) {
  return {
    name,
    description: `Tool ${name}`,
    schema,
    risk: 'read',
    async execute() {
      return name;
    },
  };
}

export default function createPlugin(ctx) {
  return {
    name: ctx.manifest.name,
    description: ctx.manifest.description,
    tools: [tool('dupe'), tool('dupe')],
  };
}
