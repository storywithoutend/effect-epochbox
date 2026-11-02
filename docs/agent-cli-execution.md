# Agent CLI execution inside epochbox

## Goal

Epochbox owns process, workspace, Git, and network isolation for agent evals. A coding-agent CLI runs inside the sealed sandbox. The CLI can reach only the endpoint named by the case. API keys stay in Docker Sandbox. Subscription credentials stay in host Pi and enter requests only at the epochbox proxy.

## Designs considered

### Host CLI with sandbox tool proxies

The CLI runs on the host and reaches its model provider with host credentials. Each harness receives custom tools that forward command and file operations to `SandboxCapabilities`.

This keeps the sandbox fully offline. It also makes Claude, Codex, and Pi tool configuration part of the security boundary. A missed built-in tool, plugin, hook, or project setting can expose the host. The adapter must maintain a separate proxy integration for each harness.

### CLI inside the sandbox with exact provider egress

The CLI and all of its tools run inside the sealed sandbox. The case locks one exact provider endpoint. Docker Sandbox denies every other destination.

API-key providers use Docker Sandbox credential injection. Subscription providers use an epochbox reverse proxy on `host.docker.internal:43117`. The sandbox can reach only that port. The reverse proxy injects the host credential and forwards to a fixed upstream host.

This is the chosen design. Explicit execute-time egress keeps one filesystem and process boundary. It also lets `effect-agent-bind` remain a catalog, probe, invocation, and usage adapter.

## Security contract

The execute egress list defaults to empty. A direct-provider entry has one DNS hostname and one port. Wildcards, IP literals, loopback names, `.local`, Docker host aliases, metadata names, and private network targets are invalid direct-provider case data.

There is one typed exception. `openai-codex` and `xai` can use a `credential-proxy` entry for `host.docker.internal:43117`. The entry must name the selected provider. Docker Sandbox rewrites that alias to `localhost`, so the seal installs one `localhost:43117` policy allow. The schema rejects every other Docker host or loopback combination.

The effective Docker Sandbox policy must start from default deny; epochbox checks unrelated public canaries before provisioning and does not mutate global policy. Provisioning then adds its temporary public allow and private deny rules. Sealing removes the public allow. Epochbox installs only the locked execute egress entries. The existing private and metadata denies remain active.

The seal must prove these facts before it returns `SealedWorkspace`:

- Every locked execute target is allowed by policy.
- A public hostname that is not in the list is denied.
- IPv4 and IPv6 outbound canaries to unlisted targets fail.
- Loopback, private, metadata, and Docker host targets remain denied, except for the locked proxy port.
- Adjacent Docker host ports remain denied.

The evidence records the exact allowlist and every policy or connection check.

API-key provider secrets remain in `sbx secret`. Epochbox maps a locked provider service to one non-secret marker environment variable, such as `ANTHROPIC_API_KEY=proxy-managed`. The case format rejects raw credential environment fields. Epochbox has no fallback that copies a host key into the sandbox.

For `openai-codex` and `xai`, the host proxy runs a fixed credential source command for each request. The command is `pi auth print-bearer-token` with a ten-minute minimum expiry. The proxy captures the token in memory, never puts it in process arguments, and never logs stdout or stderr. The proxy forwards only to the provider profile's fixed upstream host:

- `openai-codex` forwards to `chatgpt.com/backend-api`. It replaces `Authorization` and `chatgpt-account-id`.
- `xai` forwards to `api.x.ai/v1`. It replaces `Authorization` and removes an inbound `x-api-key`.

The sandbox receives a dummy Codex JWT or a generated xAI placeholder. Pi reads temporary auth and model files under the epochbox workspace. xAI also receives alternate base URL variables for compatible clients. Epochbox removes the temporary directory after the agent exits.

The model provider can receive prompts, tool results, and any workspace data that the agent chooses to send to its own API. The egress policy does not stop exfiltration to the selected provider. It stops access to other hosts and to the host network. Docker Sandbox and its credential proxy remain trusted parts of the boundary.

## Data model

```ts
type ExecuteEgress =
  | {
      readonly host: string
      readonly port: number
    }
  | {
      readonly kind: "credential-proxy"
      readonly host: "host.docker.internal"
      readonly port: 43117
      readonly provider: "openai-codex" | "xai"
    }

type AgentRecipe =
  | {
      readonly adapter: "host-process"
      readonly actions: readonly AgentAction[]
    }
  | {
      readonly adapter: "cli"
      readonly repository: string
      readonly selection: AgentSelection
      readonly prompt: string
      readonly model?: string
      readonly provider: "anthropic" | "openai" | "openrouter" | "openai-codex" | "xai"
      readonly path?: readonly string[]
      readonly tools?: "files" | "full"
    }

interface CollectedOutput {
  readonly repository: string
  readonly path: string
}

interface CaseRecipe {
  readonly executeEgress?: readonly ExecuteEgress[]
  readonly collect?: readonly CollectedOutput[]
  readonly agent: AgentRecipe
}
```

The lock contains the normalized egress list, the selected provider service, and the collected output paths. The lock ID covers all of them.

`effect-agent-bind` owns these operations:

```ts
probeInstalledAgentsWith(executor): Promise<readonly ProbeHit[]>
selectAgent(selection, hits): ResolvedAgent
createInvocationPlan(agent, request): InvocationPlan
normalizeUsage(agentId, stdout, wallSeconds): NormalizedUsage
```

The invocation plan contains a command, arguments, cwd, environment additions, model, output format, timeout, and the unattended permission mode. It contains no sandbox policy, isolation receipt, generated network policy, or path-confinement extension.

Epochbox owns process execution. Its CLI agent adapter probes binaries through `SandboxCapabilities`, builds the invocation plan with `effect-agent-bind`, runs the plan inside the sealed repository, and records raw output plus normalized usage.

## Work sequence

1. Simplify `effect-agent-bind` and prove that invocation plans contain no isolation implementation.
2. Add failing schema, lock, policy, evidence, and CLI-agent tests in epochbox.
3. Add the exact egress transition and the CLI agent adapter.
4. Integrate a consumer through generated epochbox cases while retaining its grading and summary format.
5. Run the fake backend, all repository gates, and one real case if Docker Sandbox authentication is available.

## Rejected scope

This change does not add a general HTTP proxy. The subscription proxy has a fixed provider table, a fixed path prefix, and a fixed upstream host. It does not accept a client-selected destination. The change does not copy provider credentials into a workspace, infer historical commits from pull requests, or make the fake backend a security boundary.
