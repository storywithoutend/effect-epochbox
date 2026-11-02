import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { command, makeRepository, tempDirectory } from "./helpers.js"

const cli = path.resolve("node_modules/.bin/tsx")
const entrypoint = path.resolve("src/cli.ts")

describe("CLI", () => {
  it("locks, runs, and verifies a retained fixture with stable JSON commands", async () => {
    const root = await tempDirectory("cli")
    const repository = await makeRepository(root, "source", { "file.txt": "historical\n" })
    const recipe = path.join(root, "case.json")
    const lock = path.join(root, "case.lock.json")
    const evidence = path.join(root, "evidence")
    await fs.writeFile(recipe, JSON.stringify({
      version: 1,
      name: "cli-fixture",
      image: "fake:shell",
      repositories: [{ name: "repo", source: repository.path, commit: repository.commit, destination: "repo", provision: [] }],
      replacements: [],
      allowChanges: [],
      agent: { adapter: "host-process", actions: [{ kind: "read", repository: "repo", path: "file.txt" }] },
      verify: [{ argv: ["sh", "-c", "test \"$(cat file.txt)\" = historical"], cwd: "repos/repo" }]
    }))
    const locked = JSON.parse(command(root, cli, [entrypoint, "lock", recipe, "--out", lock, "--backend", "fake"])) as Record<string, unknown>
    expect(locked).toMatchObject({ command: "lock", backend: "fake", output: lock })
    const ran = JSON.parse(command(root, cli, [entrypoint, "run", lock, "--evidence", evidence, "--backend", "fake"])) as Record<string, unknown>
    expect(ran).toMatchObject({ command: "run", phase: "complete", passed: true })
    expect(() => command(root, cli, [entrypoint, "run", lock, "--evidence", evidence, "--backend", "fake"])).toThrow(/evidence directory already exists/)
    const verified = JSON.parse(command(root, cli, [entrypoint, "verify", evidence])) as Record<string, unknown>
    expect(verified).toMatchObject({ command: "verify", valid: true })
  })
})
