import { isIP } from "node:net"
import { Effect, Schema } from "effect"
import { ConfigurationError } from "./errors.js"
import { isSafeDestination } from "./util/path.js"
import { isSensitiveEnvironmentName } from "./security.js"

const StringMap = Schema.Record({ key: Schema.String, value: Schema.String })
const Command = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(StringMap)
})

const Match = Schema.Struct({
  package: Schema.String,
  requested: Schema.optional(Schema.String)
})

const ReplacementTarget = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("version"), version: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("alias"), package: Schema.String, version: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("artifact"), path: Schema.String, sha256: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("workspace"), repository: Schema.String })
)

export const DependencyReplacementSchema = Schema.Struct({
  ecosystem: Schema.Literal("npm"),
  repository: Schema.String,
  match: Match,
  replacement: ReplacementTarget,
  reason: Schema.String
})

export const RepositoryRecipeSchema = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
  commit: Schema.String,
  destination: Schema.String,
  provision: Schema.optional(Schema.Array(Command))
})

const AgentActionSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("command"), repository: Schema.String, argv: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("write"), repository: Schema.String, path: Schema.String, content: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("append"), repository: Schema.String, path: Schema.String, content: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("read"), repository: Schema.String, path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("search"), repository: Schema.String, query: Schema.String })
)

const AgentIdSchema = Schema.Literal("claude", "codex", "pi", "gemini", "cursor", "grok")
const AgentSelectionSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("explicit"), id: AgentIdSchema }),
  Schema.Struct({ kind: Schema.Literal("auto"), preference: Schema.optional(Schema.Array(AgentIdSchema)) })
)

const ProviderServiceSchema = Schema.Literal("anthropic", "openai", "openrouter", "openai-codex", "xai")

const HostProcessAgentSchema = Schema.Struct({
  adapter: Schema.Literal("host-process"),
  actions: Schema.Array(AgentActionSchema)
})

const CliAgentSchema = Schema.Struct({
  adapter: Schema.Literal("cli"),
  repository: Schema.String,
  selection: AgentSelectionSchema,
  prompt: Schema.String,
  model: Schema.optional(Schema.String),
  provider: ProviderServiceSchema,
  path: Schema.optional(Schema.Array(Schema.String)),
  tools: Schema.optional(Schema.Literal("files", "full"))
})

const DirectExecuteEgressSchema = Schema.Struct({
  host: Schema.String,
  port: Schema.Number
})

const CredentialProxyEgressSchema = Schema.Struct({
  kind: Schema.Literal("credential-proxy"),
  host: Schema.Literal("host.docker.internal"),
  port: Schema.Literal(43_117),
  provider: Schema.Literal("openai-codex", "xai")
})

const ExecuteEgressSchema = Schema.Union(DirectExecuteEgressSchema, CredentialProxyEgressSchema)

const CollectedOutputSchema = Schema.Struct({
  repository: Schema.String,
  path: Schema.String
})

export const CaseRecipeSchema = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String,
  image: Schema.String,
  repositories: Schema.Array(RepositoryRecipeSchema),
  replacements: Schema.optional(Schema.Array(DependencyReplacementSchema)),
  allowChanges: Schema.Array(Schema.String),
  executeEgress: Schema.optional(Schema.Array(ExecuteEgressSchema)),
  collect: Schema.optional(Schema.Array(CollectedOutputSchema)),
  agent: Schema.Union(HostProcessAgentSchema, CliAgentSchema),
  verify: Schema.optional(Schema.Array(Command))
})

export type CommandSpec = typeof Command.Type
export type DependencyReplacement = typeof DependencyReplacementSchema.Type
export type RepositoryRecipe = typeof RepositoryRecipeSchema.Type
export type AgentAction = typeof AgentActionSchema.Type
export type AgentRecipe = typeof CaseRecipeSchema.Type["agent"]
export type ProviderService = typeof ProviderServiceSchema.Type
export type ExecuteEgress = typeof ExecuteEgressSchema.Type
export type CollectedOutput = typeof CollectedOutputSchema.Type
export type CaseRecipe = typeof CaseRecipeSchema.Type

const PROVIDER_ENDPOINTS = {
  anthropic: { host: "api.anthropic.com", port: 443 },
  openai: { host: "api.openai.com", port: 443 },
  openrouter: { host: "openrouter.ai", port: 443 },
  "openai-codex": {
    kind: "credential-proxy",
    host: "host.docker.internal",
    port: 43_117,
    provider: "openai-codex"
  },
  xai: {
    kind: "credential-proxy",
    host: "host.docker.internal",
    port: 43_117,
    provider: "xai"
  }
} as const satisfies Record<ProviderService, ExecuteEgress>

export const providerEndpoint = (provider: ProviderService): ExecuteEgress => PROVIDER_ENDPOINTS[provider]

export const isCredentialProxyEgress = (
  egress: ExecuteEgress
): egress is Extract<ExecuteEgress, { readonly kind: "credential-proxy" }> => "kind" in egress

export const isProviderEgress = (egress: ExecuteEgress, provider: ProviderService): boolean => {
  const expected = providerEndpoint(provider)
  if (isCredentialProxyEgress(expected)) {
    return isCredentialProxyEgress(egress) &&
      egress.provider === expected.provider &&
      egress.host === expected.host &&
      egress.port === expected.port
  }
  return !isCredentialProxyEgress(egress) && egress.host === expected.host && egress.port === expected.port
}

const decodeRecipe = Schema.decodeUnknown(CaseRecipeSchema)

const BLOCKED_EGRESS_HOSTS = new Set([
  "localhost",
  "host.docker.internal",
  "gateway.docker.internal",
  "metadata.google.internal"
])

const isValidHostname = (host: string): boolean => {
  if (host !== host.toLowerCase() || host.length === 0 || host.length > 253 || host.endsWith(".")) return false
  if (host.includes("*") || isIP(host) !== 0 || BLOCKED_EGRESS_HOSTS.has(host)) return false
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false
  return host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

const validateCommand = (
  command: CommandSpec,
  path: string
): Effect.Effect<void, ConfigurationError> => {
  if (command.argv.length === 0) return Effect.fail(new ConfigurationError({ message: "command argv must be non-empty", path }))
  if (command.cwd !== undefined && !isSafeRelativePath(command.cwd)) {
    return Effect.fail(new ConfigurationError({ message: `unsafe command cwd ${command.cwd}`, path }))
  }
  const sensitive = Object.keys(command.env ?? {}).find(isSensitiveEnvironmentName)
  if (sensitive !== undefined) {
    return Effect.fail(new ConfigurationError({ message: `credentials may not be embedded in a case: ${sensitive}`, path: `${path}.env` }))
  }
  return Effect.void
}

const validateRecipe = (recipe: CaseRecipe): Effect.Effect<CaseRecipe, ConfigurationError> => Effect.gen(function* () {
  if (recipe.repositories.length === 0) {
    return yield* new ConfigurationError({ message: "repositories must be non-empty", path: "repositories" })
  }
  const destinations = new Set<string>()
  const names = new Set<string>()
  for (const [index, repository] of recipe.repositories.entries()) {
    if (!isSafeDestination(repository.destination)) {
      return yield* new ConfigurationError({
        message: `unsafe repository destination: ${repository.destination}`,
        path: `repositories[${index}].destination`
      })
    }
    if (destinations.has(repository.destination) || names.has(repository.name)) {
      return yield* new ConfigurationError({
        message: "repository names and destinations must be unique",
        path: `repositories[${index}]`
      })
    }
    if (!/^[0-9a-f]{7,64}$/i.test(repository.commit)) {
      return yield* new ConfigurationError({ message: "commit must be a hexadecimal Git object id", path: `repositories[${index}].commit` })
    }
    destinations.add(repository.destination)
    names.add(repository.name)
    for (const command of repository.provision ?? []) {
      yield* validateCommand(command, `repositories[${index}].provision`)
    }
  }
  for (const name of recipe.allowChanges) {
    if (!names.has(name)) {
      return yield* new ConfigurationError({ message: `allowChanges names unknown repository ${name}`, path: "allowChanges" })
    }
  }
  const egressKeys = new Set<string>()
  for (const [index, entry] of (recipe.executeEgress ?? []).entries()) {
    if (isCredentialProxyEgress(entry)) {
      if (!isProviderEgress(entry, entry.provider)) {
        return yield* new ConfigurationError({ message: `invalid credential proxy endpoint for ${entry.provider}`, path: `executeEgress[${index}]` })
      }
    } else if (!isValidHostname(entry.host)) {
      const reason = entry.host.includes("*") ? "wildcard host" : isIP(entry.host) !== 0 ? "IP literals are not allowed" : "internal or invalid host"
      return yield* new ConfigurationError({ message: `${reason}: ${entry.host}`, path: `executeEgress[${index}].host` })
    }
    if (!Number.isSafeInteger(entry.port) || entry.port < 1 || entry.port > 65_535) {
      return yield* new ConfigurationError({ message: `invalid port ${entry.port}`, path: `executeEgress[${index}].port` })
    }
    const key = `${entry.host}:${entry.port}`
    if (egressKeys.has(key)) {
      return yield* new ConfigurationError({ message: `duplicate execute egress ${key}`, path: `executeEgress[${index}]` })
    }
    egressKeys.add(key)
  }
  if (recipe.agent.adapter === "host-process") {
    for (const [index, action] of recipe.agent.actions.entries()) {
      if (!names.has(action.repository)) {
        return yield* new ConfigurationError({ message: `agent action names unknown repository ${action.repository}`, path: `agent.actions[${index}]` })
      }
      if (action.kind === "command" && action.argv.length === 0) {
        return yield* new ConfigurationError({ message: "command argv must be non-empty", path: `agent.actions[${index}].argv` })
      }
      if ((action.kind === "write" || action.kind === "append" || action.kind === "read") && !isSafeRelativePath(action.path)) {
        return yield* new ConfigurationError({ message: `unsafe agent path ${action.path}`, path: `agent.actions[${index}].path` })
      }
    }
  } else {
    if (!names.has(recipe.agent.repository)) {
      return yield* new ConfigurationError({ message: `CLI agent names unknown repository ${recipe.agent.repository}`, path: "agent.repository" })
    }
    if (!recipe.agent.prompt.trim()) {
      return yield* new ConfigurationError({ message: "CLI agent prompt must be non-empty", path: "agent.prompt" })
    }
    for (const [index, entry] of (recipe.agent.path ?? []).entries()) {
      if (!isSafeRelativePath(entry)) {
        return yield* new ConfigurationError({ message: `unsafe CLI agent path ${entry}`, path: `agent.path[${index}]` })
      }
    }
    const endpoint = providerEndpoint(recipe.agent.provider)
    const expected = `${endpoint.host}:${endpoint.port}`
    const selectedEgress = recipe.executeEgress ?? []
    const onlyEgress = selectedEgress[0]
    if (selectedEgress.length !== 1 || onlyEgress === undefined || !isProviderEgress(onlyEgress, recipe.agent.provider)) {
      return yield* new ConfigurationError({ message: `CLI provider ${recipe.agent.provider} requires execute egress ${expected} and no other target`, path: "executeEgress" })
    }
  }
  for (const [index, output] of (recipe.collect ?? []).entries()) {
    if (!names.has(output.repository)) {
      return yield* new ConfigurationError({ message: `collected output names unknown repository ${output.repository}`, path: `collect[${index}].repository` })
    }
    if (!isSafeRelativePath(output.path)) {
      return yield* new ConfigurationError({ message: `unsafe collected output path ${output.path}`, path: `collect[${index}].path` })
    }
  }
  for (const [index, replacement] of (recipe.replacements ?? []).entries()) {
    if (!names.has(replacement.repository)) {
      return yield* new ConfigurationError({ message: `replacement names unknown repository ${replacement.repository}`, path: `replacements[${index}]` })
    }
    if (replacement.replacement.kind === "workspace" && !names.has(replacement.replacement.repository)) {
      return yield* new ConfigurationError({ message: `workspace replacement names unknown repository ${replacement.replacement.repository}`, path: `replacements[${index}]` })
    }
  }
  for (const [index, command] of (recipe.verify ?? []).entries()) {
    yield* validateCommand(command, `verify[${index}]`)
  }
  return recipe
})

export const decodeCaseRecipe = (input: unknown): Effect.Effect<CaseRecipe, ConfigurationError> =>
  decodeRecipe(input).pipe(
    Effect.mapError((cause) => new ConfigurationError({ message: String(cause) })),
    Effect.flatMap(validateRecipe)
  )

export const isSafeRelativePath = (value: string): boolean => {
  if (value.length === 0 || value.includes("\0") || value.includes("\\")) return false
  if (value.startsWith("/") || value.split("/").some((part) => part === "" || part === "." || part === "..")) return false
  return true
}
