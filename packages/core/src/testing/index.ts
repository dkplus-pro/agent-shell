import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rawConfigSchema, type ModelScript, type ProviderCapabilities } from '../config/schema.js';
import type { ResolvedConfig } from '../config/schema.js';
import { createProviderRegistry } from '../providers/registry.js';
import type { ChatModelHandle, ProviderRegistry } from '../providers/types.js';
import { ScriptedChatModel } from './scripted-model.js';

export { ScriptedChatModel, scriptFromTexts } from './scripted-model.js';
export type { ScriptedChatModelFields } from './scripted-model.js';
export type {
  BaseChatModelResult,
  ChatModelHandle,
  InvokeOptions,
  ProviderRegistry,
  ResolvedProvider,
  TokenUsageSummary,
} from '../providers/types.js';
export type { ModelScript, ProviderCapabilities, ResolvedConfig } from '../config/schema.js';

export const DEFAULT_SCRIPTED_PROVIDER_ID = 'mock';
export const DEFAULT_SCRIPTED_MODEL_ID = 'script';

/** Seed files used when a test does not care about content. */
export const DEFAULT_WORKSPACE_SEED: Readonly<Record<string, string>> = {
  'notes/a.md': 'hello world',
  'notes/b.md': 'agent shell',
};

/**
 * Stable fake credential. It deliberately does not match the trace redaction
 * patterns, so a test that asserts its absence proves real scrubbing.
 */
export function fakeSecret(): string {
  return 'fake-secret-value-0123456789abcdef';
}

export interface ScriptedRegistryOptions {
  providerId?: string;
  modelId?: string;
  /** Override the frozen capability matrix, e.g. `toolCalling: false`. */
  capabilities?: Partial<ProviderCapabilities>;
}

/**
 * One-provider registry backed by a `ScriptedChatModel` (docs/04-testing-and-acceptance.md §2.1).
 * The handle is cached by ref, so `create()` always returns the same model
 * instance and script steps advance one per model call.
 */
export function makeScriptedRegistry(
  script: ModelScript | string,
  options: ScriptedRegistryOptions = {},
): ProviderRegistry {
  const providerId = options.providerId ?? DEFAULT_SCRIPTED_PROVIDER_ID;
  const modelId = options.modelId ?? DEFAULT_SCRIPTED_MODEL_ID;
  const config: ResolvedConfig = rawConfigSchema.parse({
    providers: {
      [providerId]: {
        kind: 'scripted',
        models: [modelId],
        script,
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      },
    },
    defaults: { provider: `${providerId}:${modelId}`, preset: 'single', agent: 'default' },
  });
  return createProviderRegistry(config);
}

export interface TempWorkspace {
  dir: string;
  cleanup: () => Promise<void>;
}

function isSafeSeedPath(target: string, root: string): boolean {
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Isolated workspace directory (docs/04-testing-and-acceptance.md §2.5). Seed
 * keys must stay inside the temp dir — a test fixture must not be able to write
 * outside the sandbox.
 */
export async function makeTempWorkspace(
  seed: Record<string, string> = DEFAULT_WORKSPACE_SEED,
): Promise<TempWorkspace> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-shell-test-'));
  for (const [relative, contents] of Object.entries(seed)) {
    if (!isSafeSeedPath(relative, dir)) {
      throw new Error(`makeTempWorkspace: refusing to write "${relative}" outside ${dir}`);
    }
    const target = path.resolve(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Narrows a handle's model for tests that assert on script consumption. */
export function scriptedModelOf(handle: ChatModelHandle): ScriptedChatModel | undefined {
  return handle.model instanceof ScriptedChatModel ? handle.model : undefined;
}
