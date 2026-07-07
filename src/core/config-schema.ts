/**
 * Config validation.
 *
 * TypeBox schema for the framework-owned parts of SymbientConfig — the
 * same schema language the tool definitions already use. Deployment
 * extensions read arbitrary extra keys, so every object stays open
 * (additionalProperties defaults to permissive under Value.Check with
 * unknown keys simply ignored); validation catches structural mistakes
 * (wrong types, misshaped blocks), not unknown extensions.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const LlmEndpoint = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  apiKey: Type.Optional(Type.String()),
  apiKeyEnv: Type.Optional(Type.String()),
  baseUrl: Type.Optional(Type.String()),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  tinyModel: Type.Optional(Type.String()),
  tinyBaseUrl: Type.Optional(Type.String()),
});

const ModuleOverride = Type.Object({
  intervalMs: Type.Optional(Type.Number()),
  cron: Type.Optional(Type.String()),
  startActive: Type.Optional(Type.Boolean()),
  runImmediately: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String()),
  llm: Type.Optional(Type.Partial(LlmEndpoint)),
});

export const SymbientConfigSchema = Type.Object({
  name: Type.String(),
  workspacePath: Type.String(),
  workspace: Type.Optional(Type.Object({
    writablePaths: Type.Optional(Type.Array(Type.String())),
  })),
  scheduling: Type.Optional(Type.Object({
    defaultTarget: Type.Optional(Type.String()),
  })),
  mqtt: Type.Object({
    brokerUrl: Type.String(),
    port: Type.Number(),
  }),
  llm: LlmEndpoint,
  services: Type.Optional(Type.Record(Type.String(), Type.Object({
    url: Type.Optional(Type.String()),
    backend: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    apiKeyEnv: Type.Optional(Type.String()),
  }, { additionalProperties: true }))),
  mcp_servers: Type.Optional(Type.Array(Type.Object({
    name: Type.String(),
    url: Type.String(),
  }, { additionalProperties: true }))),
  modules: Type.Optional(Type.Record(Type.String(), ModuleOverride)),
}, { additionalProperties: true });

export type ValidatedSymbientConfig = Static<typeof SymbientConfigSchema>;

/** Returns human-readable problems; empty array = valid. */
export function validateConfig(config: unknown): string[] {
  if (Value.Check(SymbientConfigSchema, config)) return [];
  return [...Value.Errors(SymbientConfigSchema, config)].map(
    (e) => `config${e.path}: ${e.message} (got ${JSON.stringify(e.value)?.slice(0, 60)})`,
  );
}
