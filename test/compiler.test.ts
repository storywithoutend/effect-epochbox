import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { baseRecipe, command, compileFixture, makeRepository, tempDirectory } from "./helpers.js"
import { canonicalJson, sha256 } from "../src/util/canonical.js"
import { validateLock } from "../src/compiler.js"

describe("case compiler", () => {
  it("resolves exact commits and produces deterministic locks and archives", async () => {
    const root = await tempDirectory("compiler")
    const repository = await makeRepository(root, "source", { "file.txt": "historical\n" })
    const recipe = baseRecipe([{ ...repository, name: "repo" }])
    const first = await compileFixture(recipe, path.join(root, "artifacts-1"))
    const second = await compileFixture(recipe, path.join(root, "artifacts-2"))
    expect(first.lockId).toBe(second.lockId)
    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(first.repositories[0]?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(first.repositories[0]?.tree).toMatch(/^[0-9a-f]{40}$/)
    expect(await fs.readFile(path.join(root, "artifacts-1", "archives", "repo.tar"))).toEqual(await fs.readFile(path.join(root, "artifacts-2", "archives", "repo.tar")))
  })

  it("locks exact execute egress and collected outputs into the case identity", async () => {
    const root = await tempDirectory("egress-lock")
    const repository = await makeRepository(root, "source", { "file.txt": "historical\n" })
    const base = baseRecipe([{ ...repository, name: "repo" }])
    const lock = await compileFixture({
      ...base,
      executeEgress: [{ host: "api.anthropic.com", port: 443 }],
      collect: [{ repository: "repo", path: "answer.json" }],
      agent: {
        adapter: "cli",
        repository: "repo",
        selection: { kind: "explicit", id: "claude" },
        prompt: "diagnose",
        provider: "anthropic"
      }
    }, path.join(root, "artifacts"))

    expect(lock.executeEgress).toEqual([{ host: "api.anthropic.com", port: 443 }])
    expect(lock.collect).toEqual([{ repository: "repo", path: "answer.json" }])
    expect(lock.agent.adapter).toBe("cli")
  })

  it("does not include future commits in the host-built archive", async () => {
    const root = await tempDirectory("future")
    const repository = await makeRepository(root, "source", { "known.txt": "past\n" })
    await fs.writeFile(path.join(repository.path, "future.txt"), "FUTURE_NONCE\n")
    command(repository.path, "git", ["add", "-A"])
    command(repository.path, "git", ["commit", "-q", "-m", "future"])
    const lock = await compileFixture(baseRecipe([{ ...repository, name: "repo" }]), path.join(root, "artifacts"))
    const archive = await fs.readFile(path.join(root, "artifacts", lock.repositories[0]!.archivePath))
    expect(archive.includes(Buffer.from("FUTURE_NONCE"))).toBe(false)
  })

  it("rejects a self-consistent lock with unsafe artifact paths", async () => {
    const root = await tempDirectory("unsafe-lock")
    const repository = await makeRepository(root, "source", { "file.txt": "content\n" })
    const lock = await compileFixture(baseRecipe([{ ...repository, name: "repo" }]), path.join(root, "artifacts"))
    const unsafeBody = { ...lock, repositories: [{ ...lock.repositories[0]!, archivePath: "../source/.git" }] }
    const { lockId: _old, ...body } = unsafeBody
    const unsafe = { ...body, lockId: sha256(canonicalJson(body)) }
    await expect(Effect.runPromise(validateLock(unsafe))).rejects.toThrow(/invalid locked repository/)
  })
})
