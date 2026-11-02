import { z } from 'zod';

/**
 * Secrets are never plain strings in config: `env()` returns a lazy reference so
 * a accidental serialization (config export, trace, error) cannot leak a value.
 */
export const SECRET_TAG = '$secret:env' as const;

export interface EnvSecretRef {
  readonly [SECRET_TAG]: 'env';
  readonly variable: string;
}

export type SecretInput = EnvSecretRef;

export function env(variable: string): EnvSecretRef {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
    throw new Error(`env() expects an environment variable name, received "${variable}"`);
  }
  return { [SECRET_TAG]: 'env', variable } as const satisfies EnvSecretRef;
}

export const secretRefSchema = z
  .object({
    [SECRET_TAG]: z.literal('env'),
    variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  })
  .strict();

export type SecretValue = z.infer<typeof secretRefSchema>;

export function revealSecret(secret: SecretValue | undefined): string | undefined {
  if (secret === undefined) return undefined;
  const value = process.env[secret.variable];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function requireSecret(secret: SecretValue | undefined, context: string): string {
  const value = revealSecret(secret);
  if (value === undefined) {
    const variable = secret?.variable ?? context;
    throw new Error(`Missing required environment variable ${variable} for ${context}.`);
  }
  return value;
}

export function isSecretLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    SECRET_TAG in value &&
    (value as Record<string, unknown>)[SECRET_TAG] === 'env'
  );
}
