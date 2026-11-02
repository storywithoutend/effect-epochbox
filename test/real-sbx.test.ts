import { promises as fs } from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { HostProcessAgent } from "../src/agent.js"
import { compileCase } from "../src/compiler.js"
import { runLockedCase } from "../src/runner.js"
import type { CaseRecipe } from "../src/schema.js"
import { NpmDependencyAdapterLive } from "../src/services/dependency-adapter.js"
import { GitSourceLive } from "../src/services/git-source.js"
import { ImageResolverSbx } from "../src/services/image-resolver.js"
import { SbxBackendLive } from "../src/services/sbx-backend.js"
import { command, makeRepository, tempDirectory } from "./helpers.js"

const enabled = process.env.EPOCHBOX_REAL_SBX === "1"

describe.skipIf(!enabled)("real sbx provisioning and sealing", () => {
  it("allows public dependency egress before seal and proves host-enforced denial after restart", async () => {
    const root = await tempDirectory("real-sbx")
    const repository = await makeRepository(root, "source", { "README.md": "real sbx fixture\n" })
    const futureNonce = `FUTURE_${crypto.randomUUID()}`
    await fs.writeFile(path.join(repository.path, "future-only.txt"), `${futureNonce}\n`)
    command(repository.path, "git", ["add", "-A"])
    command(repository.path, "git", ["commit", "-q", "-m", futureNonce])
    const recipe: CaseRecipe = {
      version: 1,
      name: "real-sbx-smoke",
      image: "docker.io/docker/sandbox-templates:shell",
      repositories: [{
        name: "repo",
        source: repository.path,
        commit: repository.commit,
        destination: "repo",
        provision: [
          { argv: ["npm", "view", "effect", "version"] },
          { argv: ["sh", "-c", "printf canary > \"$HOME/.npmrc\"; sleep 300 >/dev/null 2>&1 & echo $! > provision.pid"] }
        ]
      }],
      replacements: [],
      allowChanges: [],
      agent: {
        adapter: "host-process",
        actions: [
          { kind: "command", repository: "repo", argv: ["node", "-e", "process.exit(require('fs').existsSync(process.argv[1])?1:0)", repository.path] },
          { kind: "command", repository: "repo", argv: ["git", "log", "--all", "--format=%H %s"] },
          { kind: "command", repository: "repo", argv: ["git", "fsck", "--full", "--no-reflogs", "--unreachable"] },
          { kind: "command", repository: "repo", argv: ["git", "remote", "-v"] },
          { kind: "command", repository: "repo", argv: ["sh", "-c", "env; mount; find .. -maxdepth 3 -type f -print"] }
        ]
      },
      verify: [{ argv: ["sh", "-c", "! kill -0 \"$(cat provision.pid)\" 2>/dev/null && test ! -e \"$HOME/.npmrc\""], cwd: "repos/repo" }]
    }
    const artifacts = path.join(root, "case.lock.json.artifacts")
    const lock = await Effect.runPromise(compileCase(recipe, artifacts).pipe(Effect.provide(Layer.merge(GitSourceLive, ImageResolverSbx))))
    const evidence = path.join(root, "evidence")
    const result = await Effect.runPromise(runLockedCase(lock, artifacts, evidence, HostProcessAgent).pipe(
      Effect.provide(Layer.mergeAll(SbxBackendLive, NpmDependencyAdapterLive, ImageResolverSbx))
    ))
    expect(result.testsPassed).toBe(true)
    const provisioning = await fs.readFile(path.join(evidence, "provisioning-record.json"), "utf8")
    const attestation = JSON.parse(await fs.readFile(path.join(evidence, "network-seal-attestation.json"), "utf8")) as Record<string, unknown>
    expect(provisioning).toMatch(/\d+\.\d+\.\d+/)
    expect(attestation).toMatchObject({ backend: "sbx", provisionPublicEgressAllowed: true, executeEgress: [], allowedEgressPolicyChecksPassed: true, dnsCanaryDenied: true, outboundCanaryDenied: true, unlistedHostnameCanaryDenied: true, provisionProcessesTerminated: true, temporaryCredentialsRemoved: true, providerEnvironmentScrubbed: true, providerCredentialsBrokered: true, sshAgentAbsent: true, secretMountEmpty: true })
    const transcript = JSON.parse(await fs.readFile(path.join(evidence, "agent-transcript.json"), "utf8")) as ReadonlyArray<{ exitCode: number; stdout: string; stderr: string }>
    expect(transcript.every((entry) => entry.exitCode === 0)).toBe(true)
    const observed = transcript.map((entry) => `${entry.stdout}\n${entry.stderr}`).join("\n")
    expect(observed).not.toContain(futureNonce)
    expect(observed).not.toContain(repository.path)
    expect(observed).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY/)
    const sandboxes = JSON.parse(command(root, "sbx", ["ls", "--json"])) as { sandboxes?: ReadonlyArray<{ name?: string }> }
    expect(sandboxes.sandboxes?.some((sandbox) => sandbox.name?.includes(lock.lockId.slice(0, 10)))).toBe(false)
  }, 180_000)
})
