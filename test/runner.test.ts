import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { CliAgentAdapter, HostProcessAgent } from "../src/agent.js"
import { verifyEvidence } from "../src/evidence.js"
import { PhaseMachine, type Phase } from "../src/phases.js"
import { runLockedCase } from "../src/runner.js"
import { activeFakeSandboxes } from "../src/services/fake-backend.js"
import type { CaseRecipe } from "../src/schema.js"
import { baseRecipe, command, compileFixture, fakeRunLayer, makeRepository, tempDirectory } from "./helpers.js"

const runFake = (lock: Awaited<ReturnType<typeof compileFixture>>, artifacts: string, evidence: string, options = {}) =>
  Effect.runPromise(runLockedCase(lock, artifacts, evidence, HostProcessAgent, options).pipe(Effect.provide(fakeRunLayer)))

describe("phase machine", () => {
  it("allows only the explicit lifecycle order", async () => {
    const machine = new PhaseMachine()
    await expect(Effect.runPromise(machine.transition("execute"))).rejects.toBeDefined()
    expect(machine.current).toBe("created")
    for (const phase of ["materialize", "provision", "seal", "execute", "collect", "verify", "complete"] as const) {
      await Effect.runPromise(machine.transition(phase))
    }
    expect(machine.current).toBe("complete")
  })
})

describe("historical execution", () => {
  it("keeps future Git history, remotes, source paths, and future nonces outside the agent view", async () => {
    const root = await tempDirectory("temporal")
    const repository = await makeRepository(root, "trusted-source", { "known.txt": "historical\n" })
    const nonce = `FUTURE_${crypto.randomUUID()}`
    await fs.writeFile(path.join(repository.path, "future-only.txt"), `${nonce}\n`)
    command(repository.path, "git", ["add", "-A"])
    command(repository.path, "git", ["commit", "-q", "-m", nonce])
    const base = baseRecipe([{ ...repository, name: "repo" }])
    const recipe: CaseRecipe = {
      ...base,
      agent: {
        adapter: "host-process",
        actions: [
          { kind: "command", repository: "repo", argv: ["git", "log", "--all", "--format=%H %s"] },
          { kind: "command", repository: "repo", argv: ["git", "fsck", "--full", "--no-reflogs", "--unreachable"] },
          { kind: "command", repository: "repo", argv: ["git", "remote", "-v"] },
          { kind: "command", repository: "repo", argv: ["sh", "-c", "env; find .. -maxdepth 3 -type f -print"] },
          { kind: "read", repository: "repo", path: "known.txt" }
        ]
      }
    }
    const artifacts = path.join(root, "artifacts")
    const evidence = path.join(root, "evidence")
    const lock = await compileFixture(recipe, artifacts)
    await runFake(lock, artifacts, evidence)
    const transcript = await fs.readFile(path.join(evidence, "agent-transcript.json"), "utf8")
    expect(transcript).not.toContain(nonce)
    expect(transcript).not.toContain(repository.path)
    expect(transcript).not.toContain("future-only.txt")
    expect(transcript).not.toContain("origin")
    expect(transcript).toContain("effect-epochbox synthetic baseline")
    expect((await verifyEvidence(evidence).pipe(Effect.runPromise)).valid).toBe(true)
    await fs.appendFile(path.join(evidence, "agent-transcript.json"), "tampered")
    const tampered = await Effect.runPromise(verifyEvidence(evidence))
    expect(tampered.valid).toBe(false)
    expect(tampered.errors).toContain("hash mismatch: agent-transcript.json")
    await fs.rm(path.join(evidence, "agent-transcript.json"))
    await fs.symlink("/etc/passwd", path.join(evidence, "agent-transcript.json"))
    const symlinked = await Effect.runPromise(verifyEvidence(evidence))
    expect(symlinked.errors).toContain("symbolic link is not allowed in evidence: agent-transcript.json")
  })

  it("collects binary-safe independent patches and reports unauthorized repository changes", async () => {
    const root = await tempDirectory("three")
    const sources = await Promise.all(["alpha", "beta", "gamma"].map((name) => makeRepository(root, `${name}-source`, { "value.txt": `${name}\n`, "image.bin": "\0before\0" }).then((repo) => ({ ...repo, name }))))
    const base = baseRecipe(sources)
    const recipe: CaseRecipe = {
      ...base,
      allowChanges: ["alpha", "gamma"],
      agent: {
        adapter: "host-process",
        actions: sources.flatMap(({ name }) => [
          { kind: "write" as const, repository: name, path: "value.txt", content: `${name}-changed\n` },
          { kind: "write" as const, repository: name, path: "image.bin", content: `\0${name}-binary\0` }
        ])
      },
      verify: [{ argv: ["sh", "-c", "test \"$(cat value.txt)\" = alpha-changed"], cwd: "repos/alpha" }]
    }
    const artifacts = path.join(root, "artifacts")
    const evidence = path.join(root, "evidence")
    const lock = await compileFixture(recipe, artifacts)
    const result = await runFake(lock, artifacts, evidence)
    expect(result.unauthorizedRepositories).toEqual(["beta"])
    for (const name of ["alpha", "beta", "gamma"]) {
      const patch = await fs.readFile(path.join(evidence, "repositories", `${name}.patch`), "utf8")
      expect(patch).toContain(`${name}-changed`)
      expect(patch).toContain("GIT binary patch")
    }
    const report = await Effect.runPromise(verifyEvidence(evidence))
    expect(report.valid).toBe(true)
  })

  it("reports a failed agent command as a failed run", async () => {
    const root = await tempDirectory("agent-failure")
    const repository = await makeRepository(root, "source", { "value.txt": "baseline\n" })
    const recipe: CaseRecipe = {
      ...baseRecipe([{ ...repository, name: "repo" }]),
      agent: {
        adapter: "host-process",
        actions: [{ kind: "command", repository: "repo", argv: ["sh", "-c", "exit 7"] }]
      }
    }
    const artifacts = path.join(root, "artifacts")
    const evidence = path.join(root, "evidence")
    const lock = await compileFixture(recipe, artifacts)
    const result = await runFake(lock, artifacts, evidence)

    expect(result.agentPassed).toBe(false)
    expect(JSON.parse(await fs.readFile(path.join(evidence, "test-results.json"), "utf8"))).toMatchObject({
      agentPassed: false,
      passed: false
    })
  })

  it("runs a selected CLI inside capabilities, brokers only a marker, and collects its answer", async () => {
    const root = await tempDirectory("cli-agent")
    const repository = await makeRepository(root, "source", {
      "bin/claude": `#!/bin/sh
case "$1" in
  --version|-V|version) echo "fake claude 1.0"; exit 0 ;;
esac
printf '%s' "$ANTHROPIC_API_KEY" > credential-marker.txt
printf '{"cause":"fixture"}\n' > answer.json
printf '{"type":"result","usage":{"input_tokens":4,"output_tokens":2},"num_turns":1}\n'
`
    })
    await fs.chmod(path.join(repository.path, "bin/claude"), 0o755)
    command(repository.path, "git", ["add", "bin/claude"])
    command(repository.path, "git", ["commit", "-q", "-m", "executable harness"])
    const commit = command(repository.path, "git", ["rev-parse", "HEAD"]).trim()
    const base = baseRecipe([{ path: repository.path, commit, name: "repo" }])
    const recipe: CaseRecipe = {
      ...base,
      executeEgress: [{ host: "api.anthropic.com", port: 443 }],
      collect: [
        { repository: "repo", path: "answer.json" },
        { repository: "repo", path: "credential-marker.txt" }
      ],
      agent: {
        adapter: "cli",
        repository: "repo",
        selection: { kind: "explicit", id: "claude" },
        prompt: "write answer.json",
        model: "fixture",
        provider: "anthropic",
        path: ["bin"]
      }
    }
    const artifacts = path.join(root, "artifacts")
    const evidence = path.join(root, "evidence")
    const previous = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "host-secret-must-not-enter"
    try {
      const lock = await compileFixture(recipe, artifacts)
      await Effect.runPromise(runLockedCase(lock, artifacts, evidence, CliAgentAdapter).pipe(Effect.provide(fakeRunLayer)))
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previous
    }

    expect(await fs.readFile(path.join(evidence, "outputs", "repo", "answer.json"), "utf8")).toBe('{"cause":"fixture"}\n')
    expect(await fs.readFile(path.join(evidence, "outputs", "repo", "credential-marker.txt"), "utf8")).toBe("proxy-managed")
    const transcript = JSON.parse(await fs.readFile(path.join(evidence, "agent-transcript.json"), "utf8"))
    expect(transcript[0]).toMatchObject({
      kind: "cli",
      agentId: "claude",
      provider: "anthropic",
      exitCode: 0,
      permissionMode: "dontAsk-allowedTools",
      usage: { inputTokens: 4, outputTokens: 2, turnCount: 1 }
    })
    const attestation = JSON.parse(await fs.readFile(path.join(evidence, "network-seal-attestation.json"), "utf8"))
    expect(attestation.executeEgress).toEqual([{ host: "api.anthropic.com", port: 443 }])
  })

  it("keeps hidden verification commands out of the agent transcript", async () => {
    const root = await tempDirectory("oracle")
    const repository = await makeRepository(root, "source", { "answer.txt": "ok\n" })
    const base = baseRecipe([{ ...repository, name: "repo" }])
    const recipe: CaseRecipe = {
      ...base,
      agent: { adapter: "host-process", actions: [{ kind: "command", repository: "repo", argv: ["find", ".", "-maxdepth", "2", "-type", "f"] }] },
      verify: [{ argv: ["sh", "-c", "test -f answer.txt # HIDDEN_ORACLE_NONCE"], cwd: "repos/repo" }]
    }
    const artifacts = path.join(root, "artifacts")
    const evidence = path.join(root, "evidence")
    await runFake(await compileFixture(recipe, artifacts), artifacts, evidence)
    expect(await fs.readFile(path.join(evidence, "agent-transcript.json"), "utf8")).not.toContain("HIDDEN_ORACLE_NONCE")
    expect(await fs.readFile(path.join(evidence, "test-results.json"), "utf8")).toContain("HIDDEN_ORACLE_NONCE")
  })

  it.each(["materialize", "provision", "seal", "execute", "collect", "verify"] as const)("cleans the workspace after failure in %s", async (phase) => {
    const root = await tempDirectory(`failure-${phase}`)
    const repository = await makeRepository(root, "source", { "file.txt": "content\n" })
    const artifacts = path.join(root, "artifacts")
    const lock = await compileFixture(baseRecipe([{ ...repository, name: "repo" }]), artifacts)
    const workspacePrefix = `effect-epochbox-${lock.lockId.slice(0, 8)}-`
    await expect(runFake(lock, artifacts, path.join(root, "evidence"), { failureInjectionPhase: phase as Exclude<Phase, "created" | "complete"> })).rejects.toBeDefined()
    const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(workspacePrefix))
    expect(after).toEqual([])
    expect([...activeFakeSandboxes.values()].some((root) => path.basename(root).startsWith(workspacePrefix))).toBe(false)
  })

  it("kills an interrupted worker and runs scoped cleanup", async () => {
    const root = await tempDirectory("interrupt")
    const repository = await makeRepository(root, "source", { "file.txt": "content\n" })
    const base = baseRecipe([{ ...repository, name: "repo" }])
    const recipe: CaseRecipe = { ...base, agent: { adapter: "host-process", actions: [{ kind: "command", repository: "repo", argv: ["sh", "-c", "sleep 30"] }] } }
    const artifacts = path.join(root, "artifacts")
    const lock = await compileFixture(recipe, artifacts)
    const workspacePrefix = `effect-epochbox-${lock.lockId.slice(0, 8)}-`
    const controller = new AbortController()
    const running = Effect.runPromise(runLockedCase(lock, artifacts, path.join(root, "evidence"), HostProcessAgent).pipe(Effect.provide(fakeRunLayer)), { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(running).rejects.toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(workspacePrefix))
    expect(after).toEqual([])
    expect([...activeFakeSandboxes.values()].some((root) => path.basename(root).startsWith(workspacePrefix))).toBe(false)
  })

  it("rejects archive symlinks that escape the materialized workspace", async () => {
    const root = await tempDirectory("symlink")
    const repository = await makeRepository(root, "source", { "file.txt": "content\n" })
    await fs.symlink("../../../outside-secret", path.join(repository.path, "escape"))
    command(repository.path, "git", ["add", "escape"])
    command(repository.path, "git", ["commit", "-q", "-m", "escaping symlink"])
    const commit = command(repository.path, "git", ["rev-parse", "HEAD"]).trim()
    const artifacts = path.join(root, "artifacts")
    const lock = await compileFixture(baseRecipe([{ path: repository.path, commit, name: "repo" }]), artifacts)
    const workspacePrefix = `effect-epochbox-${lock.lockId.slice(0, 8)}-`
    await expect(runFake(lock, artifacts, path.join(root, "evidence"))).rejects.toThrow(/symlink escapes workspace/)
    expect((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(workspacePrefix))).toEqual([])
    expect([...activeFakeSandboxes.values()].some((root) => path.basename(root).startsWith(workspacePrefix))).toBe(false)
  })

  it("rejects escaping symlinks created during provisioning before host-side collection", async () => {
    const root = await tempDirectory("provision-symlink")
    const repository = await makeRepository(root, "source", { "package.json": "{\"name\":\"fixture\",\"version\":\"1.0.0\"}\n" })
    const base = baseRecipe([{ ...repository, name: "repo" }])
    const recipe: CaseRecipe = {
      ...base,
      repositories: [{ ...base.repositories[0]!, provision: [{ argv: ["ln", "-s", "/etc/passwd", "package-lock.json"] }] }]
    }
    const artifacts = path.join(root, "artifacts")
    const lock = await compileFixture(recipe, artifacts)
    const workspacePrefix = `effect-epochbox-${lock.lockId.slice(0, 8)}-`
    await expect(runFake(lock, artifacts, path.join(root, "evidence"))).rejects.toThrow(/symlink escapes workspace/)
    expect((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(workspacePrefix))).toEqual([])
  })
})
