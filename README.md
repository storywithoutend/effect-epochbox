# effect-epochbox

`effect-epochbox` builds replayable historical workspaces for agent evaluation. It snapshots exact Git commits on the trusted host, provisions dependencies in Docker Sandbox, seals the workspace with a locked execute-time network policy, runs an agent inside that sandbox, and emits evidence that can be verified offline.

V1 supports local Git sources, multiple repositories, npm dependency repair, deterministic host-process actions, and Claude, Codex, Pi, Gemini, and Grok invocation plans through `effect-agent-bind`. Cursor remains catalog-only because unattended writes require its blanket `--force` mode.

## Install

```sh
npm install effect-epochbox
```

Node.js 22 or later and Docker Sandbox `sbx` are required.

## Trust boundary

The host controller resolves commits and invokes `git archive`. Only archive contents enter the workspace. Source `.git` directories, objects, reflogs, remotes, later commits, source checkout paths, verification commands, and provider credentials stay outside the sandbox.

Epochbox creates synthetic Git baselines only after provisioning and sealing. The agent can inspect the archived files and the synthetic baseline, but it cannot recover the source repository's history or remotes.

Agents receive only a branded `SealedWorkspace` and `SandboxCapabilities`. A CLI agent is probed and invoked through those capabilities. Its file and process tools run inside Docker Sandbox, not on the host.

## Lifecycle

```text
compile -> materialize -> provision -> seal -> execute -> collect -> verify -> evidence
```

### Provision

Provisioning temporarily allows public package traffic while retaining denies for loopback, private, shared, link-local, metadata, `.local`, Docker host aliases, and known model-provider APIs. No agent runs during this phase. Case environment fields with credential-like names are rejected.

Epochbox removes SSH-agent, Docker-socket, package-manager credential, persistent shell, and secret-mount surfaces before execution.

### Seal and execute egress

`executeEgress` defaults to an empty list. A direct-provider entry contains one lowercase DNS hostname and one port. Wildcards, IP literals, loopback, `.local`, `.internal`, metadata, and Docker host names are invalid direct-provider case data.

Subscription providers use one narrow exception. An `openai-codex` or `xai` case can lock `host.docker.internal:43117` with `kind: "credential-proxy"` and the matching provider. Docker Sandbox rewrites that alias to `localhost`, so epochbox installs one `localhost:43117` policy allow. No other Docker host or loopback entry is valid.

The host must have a compatible default-deny Docker Sandbox policy. On a fresh policy store, initialize it intentionally with `sbx policy init deny-all`. Epochbox does not reset or rewrite global policy. Before provisioning, it checks several unrelated public hosts and fails closed if the effective sandbox policy is not default-deny.

Sealing stops the sandbox, removes the provisioning wildcard allow, removes only the provider deny needed by the locked case, and adds the exact `host:port` allow entries. The verified default deny remains in force. Epochbox then proves:

- every locked target is allowed by policy;
- unlisted public host and port checks are denied;
- direct DNS and public-IP canaries are denied;
- loopback, private, metadata, and Docker host targets remain denied, except for a locked subscription proxy port;
- other ports on the Docker host remain denied;
- live TLS attempts to an unlisted hostname and IP fail.

Any missing capability or failed check is a `SecurityCapabilityError`. No `SealedWorkspace` is returned.

The exact allowlist and every canary result are recorded in `network-seal-attestation.json`.

### Provider credentials

Configure provider credentials in Docker Sandbox, for example:

```sh
sbx secret set -g anthropic
sbx secret set -g openai
sbx secret set -g openrouter
```

Epochbox never copies a provider key into the sandbox. For an agent invocation, it supplies only the literal marker expected by the Docker Sandbox credential proxy:

```text
ANTHROPIC_API_KEY=proxy-managed
OPENAI_API_KEY=proxy-managed
OPENROUTER_API_KEY=proxy-managed
```

All other provider, cloud, registry, GitHub, and SSH credential variables are scrubbed. There is no fallback to a host key or credential file.

For `openai-codex` and `xai`, epochbox starts a host-side reverse proxy on the locked Docker host port. The proxy reads a fresh bearer token from host Pi for each request. It forwards only to `chatgpt.com` for `openai-codex` or `api.x.ai` for `xai`. The proxy replaces `Authorization` and, for Codex, `chatgpt-account-id`. The sandbox contains only a dummy OAuth record or a generated placeholder. The proxy never logs the credential.

Pi receives a temporary `models.json` that points the selected provider to the proxy and a `settings.json` that selects SSE. xAI cases also set `XAI_API_BASE_URL` and `GROK_XAI_API_BASE_URL`. Pi supports the host subscription token through this route. The official Grok CLI can require its own login or an xAI API key, depending on the installed version.

The selected model provider can receive prompts, tool results, and workspace data the agent sends to its own API. Exact egress prevents access to other hosts; it does not prevent exfiltration to the selected provider. Docker Sandbox, its policy engine, DNS behavior, and credential proxy remain trusted components.

## Agent adapters

### CLI adapter

A CLI recipe names one repository, selection rule, prompt, provider, optional model, optional binary search path, and tool profile. For CLI cases, the execute allowlist must contain exactly the selected provider endpoint:

| Provider | Locked endpoint |
| --- | --- |
| `anthropic` | `api.anthropic.com:443` |
| `openai` | `api.openai.com:443` |
| `openrouter` | `openrouter.ai:443` |
| `openai-codex` | `host.docker.internal:43117`, credential proxy to `chatgpt.com` |
| `xai` | `host.docker.internal:43117`, credential proxy to `api.x.ai` |

`effect-agent-bind` supplies catalog, probe, selection, invocation, and usage normalization. Epochbox owns execution and evidence.

The `full` tool profile enables normal file and process tools. The `files` profile removes process tools for Claude and Pi. Other harnesses fail closed for `files`.

### Host-process adapter

The deterministic adapter runs locked `command`, `write`, `append`, `read`, and `search` actions through the same sandbox capabilities. It is useful for tests and deterministic setup, not model calls.

## Case format

```json
{
  "version": 1,
  "name": "historical-agent-case",
  "image": "docker.io/docker/sandbox-templates:shell",
  "repositories": [
    {
      "name": "app",
      "source": "/trusted/local/clone",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "destination": "app",
      "provision": []
    }
  ],
  "replacements": [],
  "allowChanges": ["app"],
  "executeEgress": [{ "host": "api.anthropic.com", "port": 443 }],
  "collect": [{ "repository": "app", "path": "answer.json" }],
  "agent": {
    "adapter": "cli",
    "repository": "app",
    "selection": { "kind": "explicit", "id": "claude" },
    "prompt": "Inspect the captures and write answer.json.",
    "model": "claude-haiku-4-5",
    "provider": "anthropic",
    "path": [".agent/node_modules/.bin"],
    "tools": "full"
  },
  "verify": []
}
```

Repository destinations and collected output paths are relative and traversal-safe. Lock format 2 records full commit and tree IDs, archive hashes and sizes, image identity, provisioning commands, replacement policy, allowed changes, execute egress, collected outputs, agent recipe, and verification commands. Its `lockId` covers the complete body.

## CLI

```sh
npm run build
node dist/cli.js lock case.json --out case.lock.json --backend sbx
node dist/cli.js run case.lock.json --evidence evidence --backend sbx
node dist/cli.js verify evidence
```

`lock` creates `case.lock.json` and `case.lock.json.artifacts/`. Keep them together.

The fake backend is deterministic test infrastructure. It executes in a temporary host directory and is not an isolation boundary:

```sh
node dist/cli.js lock case.json --out case.lock.json --backend fake
node dist/cli.js run case.lock.json --evidence evidence --backend fake
```

## Dependency repair

Npm replacements can select an exact version, npm alias, retained content-addressed artifact, or another locked workspace repository. The evidence records requested and final package identities, the applied mechanism, reason, artifact hash, and fidelity classification. Artifact or final-resolution mismatches fail before agent execution.

## Evidence

A successful run emits:

- `case-lock.json`;
- exact source archives and snapshot manifest;
- replacement and resolved-dependency manifests;
- provisioning record;
- network seal attestation with exact execute egress;
- agent transcript with raw output and normalized usage;
- repository status and binary-safe patches;
- declared collected outputs plus `output-manifest.json`;
- verification results;
- a SHA-256 hash manifest over the evidence directory.

`effect-epochbox verify` performs offline integrity checks. Evidence symlinks, changed files, archive mismatches, lock identity changes, and unmanifested files fail verification.

## Library API

The package exports schemas, compiler, runner, adapters, backends, evidence verification, and Effect service tags from `effect-epochbox`.

`runLockedCase` keeps the `AgentAdapter` injectable for tests. `runLockFile` chooses `CliAgentAdapter` or `HostProcessAgent` from the locked recipe unless the caller supplies an adapter.

## Verification

```sh
npm run check
npm test
npm run build
```

The mocked `sbx` test asserts that provisioning egress is replaced with an exact provider host and port and that denied policy canaries remain present.

The real smoke is opt-in and makes no model call:

```sh
npm run test:real
```

It requires an authenticated, installed `sbx`. It proves public provisioning access, process termination, credential cleanup, exact/default-deny network handoff, agent execution, evidence generation, and sandbox removal.

This implementation was developed against standalone `sbx` 0.37.1. A newer runtime must pass the real smoke before it replaces that boundary.
