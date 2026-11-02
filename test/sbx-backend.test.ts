import { promises as fs } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { SandboxBackend } from "../src/services/backend.js"
import { SbxBackendLive } from "../src/services/sbx-backend.js"
import { baseRecipe, compileFixture, makeRepository, tempDirectory } from "./helpers.js"

describe("sbx execute egress", () => {
  it("replaces provisioning egress with an exact host and port and checks denied canaries", async () => {
    const root = await tempDirectory("sbx-policy")
    const repository = await makeRepository(root, "source", { "file.txt": "fixture\n" })
    const base = baseRecipe([{ ...repository, name: "repo" }])
    const lock = await compileFixture({
      ...base,
      executeEgress: [{ host: "api.anthropic.com", port: 443 }],
      agent: {
        adapter: "cli",
        repository: "repo",
        selection: { kind: "explicit", id: "claude" },
        prompt: "diagnose",
        provider: "anthropic"
      }
    }, path.join(root, "artifacts"))
    const bin = path.join(root, "bin")
    const log = path.join(root, "sbx.log")
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, "sbx"), `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.SBX_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'policy' && args[1] === 'check') {
  const target = args[args.length - 1]
  process.stdout.write(JSON.stringify({ decision: target === 'api.anthropic.com:443' ? 'allow' : 'deny' }))
}
`)
    await fs.chmod(path.join(bin, "sbx"), 0o755)
    const previousPath = process.env.PATH
    const previousLog = process.env.SBX_LOG
    const previousAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.PATH = `${bin}:${previousPath ?? ""}`
    process.env.SBX_LOG = log
    process.env.ANTHROPIC_API_KEY = "host-secret-must-not-enter"
    try {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const backend = yield* SandboxBackend
        const handle = yield* backend.create(path.join(root, "workspace"), lock)
        const sealed = yield* backend.seal(handle, lock)
        yield* backend.execAgent(sealed.workspace, {
          argv: ["claude", "--version"],
          cwd: "repos/repo",
          env: { NO_COLOR: "1" }
        }, "anthropic")
        yield* backend.destroy(handle)
        return sealed
      }).pipe(Effect.provide(SbxBackendLive)))
      expect(result.attestation).toMatchObject({
        executeEgress: [{ host: "api.anthropic.com", port: 443 }],
        allowedEgressPolicyChecksPassed: true,
        defaultDenyCanaryTargets: expect.arrayContaining(["registry.npmjs.org:443", "github.com:443"]),
        unlistedHostnameCanaryTarget: "example.com:443",
        outboundCanaryTarget: "1.1.1.1:443",
        outboundCanaryDenied: true,
        unlistedHostnameCanaryDenied: true
      })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousLog === undefined) delete process.env.SBX_LOG
      else process.env.SBX_LOG = previousLog
      if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousAnthropic
    }

    const calls = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as ReadonlyArray<string>)
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "rm", "network", "--resource", "**"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "rm", "network", "--resource", "api.anthropic.com"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "allow", "network", "api.anthropic.com:443"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "check", "network", "example.com:443"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "check", "network", "example.net:443"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "check", "network", "www.cloudflare.com:443"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "check", "network", "api.anthropic.com:443"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "check", "network", "1.1.1.1:443"]))
    expect(calls).toContainEqual(expect.arrayContaining(["--env", "ANTHROPIC_API_KEY=proxy-managed", "claude", "--version"]))
    expect(JSON.stringify(calls)).not.toContain("host-secret-must-not-enter")
    expect(calls.some((args) => args[0] === "policy" && args[1] === "deny" && args.some((value) => value.includes("0.0.0.0/0")))).toBe(false)
  })

  it("allows only the locked host proxy port and records subscription injection evidence", async () => {
    const root = await tempDirectory("sbx-subscription-policy")
    const repository = await makeRepository(root, "source", { "file.txt": "fixture\n" })
    const base = baseRecipe([{ ...repository, name: "repo" }])
    const lock = await compileFixture({
      ...base,
      executeEgress: [{
        kind: "credential-proxy",
        host: "host.docker.internal",
        port: 43_117,
        provider: "openai-codex"
      }],
      agent: {
        adapter: "cli",
        repository: "repo",
        selection: { kind: "explicit", id: "pi" },
        prompt: "diagnose",
        provider: "openai-codex"
      }
    }, path.join(root, "artifacts"))
    const bin = path.join(root, "bin")
    const log = path.join(root, "sbx.log")
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, "sbx"), `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.SBX_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'policy' && args[1] === 'check') {
  const target = args[args.length - 1]
  process.stdout.write(JSON.stringify({ decision: target === 'localhost:43117' ? 'allow' : 'deny' }))
}
`)
    await fs.chmod(path.join(bin, "sbx"), 0o755)
    const previousPath = process.env.PATH
    const previousLog = process.env.SBX_LOG
    process.env.PATH = `${bin}:${previousPath ?? ""}`
    process.env.SBX_LOG = log
    try {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const backend = yield* SandboxBackend
        const handle = yield* backend.create(path.join(root, "workspace"), lock)
        const sealed = yield* backend.seal(handle, lock)
        yield* backend.execAgent(sealed.workspace, {
          argv: ["pi", "--version"],
          cwd: "repos/repo",
          env: { NO_COLOR: "1" }
        }, "openai-codex")
        yield* backend.destroy(handle)
        return sealed
      }).pipe(Effect.provide(SbxBackendLive)))
      expect(result.attestation.credentialProxy).toEqual({
        provider: "openai-codex",
        endpoint: "host.docker.internal:43117",
        policyEndpoint: "localhost:43117",
        upstreamHosts: ["chatgpt.com"],
        credentialSource: "host-pi-auth",
        headerNames: ["Authorization", "chatgpt-account-id"],
        refresh: "per-request-host-refresh",
        sandboxCredentialMaterial: "placeholder-only",
        adjacentHostPortsDenied: true
      })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousLog === undefined) delete process.env.SBX_LOG
      else process.env.SBX_LOG = previousLog
    }

    const calls = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as ReadonlyArray<string>)
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "rm", "network", "--resource", "localhost"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "allow", "network", "localhost:43117"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "check", "network", "localhost:443"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "check", "network", "localhost:43118"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "check", "network", "host.docker.internal:443"]))
    expect(calls).toContainEqual(expect.arrayContaining(["policy", "check", "network", "host.docker.internal:43118"]))
    expect(calls).toContainEqual(expect.arrayContaining(["--env", expect.stringMatching(/^PI_CODING_AGENT_DIR=.*\.epochbox-agent\/pi$/u), "pi", "--version"]))
    expect(JSON.stringify(calls)).not.toMatch(/Bearer |chatgpt-account-id.*epochbox-proxy-account/u)
  })
})
