# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Start with `README.md` for the architecture, threat model, case format, stable CLI, and evidence contract.
- Before committing, run `npm run check`, `npm test`, and `npm run build`. Run `npm run test:real` when changing the `sbx` backend or seal policy; it uses the installed standalone `sbx` 0.37.1 and makes no model call. `tsconfig.build.json` is the publish build; `tsconfig.json` also checks tests.
- Security transitions must fail closed with `SecurityCapabilityError`. Execute egress is locked case data: exact hostnames and ports only, with default deny plus private/metadata/loopback denies. Never weaken or simulate the policy/TLS canaries to make the real smoke pass, and do not substitute or upgrade the sandbox runtime without an explicit project decision.
- Preserve the `AgentAdapter` boundary: agents receive only a `SealedWorkspace` and sandbox-backed capabilities. Host filesystem and shell access, source clones, verification oracles, and credentials must stay outside the sandbox. API-key providers use Docker Sandbox's `proxy-managed` marker. Subscription providers use the locked epochbox host proxy and placeholder-only sandbox configuration. Never add a raw-key fallback.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
