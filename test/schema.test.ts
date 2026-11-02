import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { decodeCaseRecipe } from "../src/schema.js"
import { isSafeDestination, resolveInside } from "../src/util/path.js"

const recipe = {
  version: 1,
  name: "case",
  image: "fake:shell",
  repositories: [{ name: "repo", source: "/tmp/repo", commit: "abcdef1", destination: "repo" }],
  allowChanges: ["repo"],
  agent: { adapter: "host-process", actions: [] }
}

describe("configuration schemas", () => {
  it("accepts a non-empty, safe multi-repository recipe", async () => {
    const decoded = await Effect.runPromise(decodeCaseRecipe(recipe))
    expect(decoded.repositories).toHaveLength(1)
  })

  it.each(["", ".", "..", "../escape", "/absolute", "a/b", "a\\b", "x.lock"])("rejects unsafe destination %j", async (destination) => {
    expect(isSafeDestination(destination)).toBe(false)
    await expect(Effect.runPromise(decodeCaseRecipe({ ...recipe, repositories: [{ ...recipe.repositories[0], destination }] }))).rejects.toThrow(/unsafe repository destination/)
  })

  it("rejects empty repositories and collisions", async () => {
    await expect(Effect.runPromise(decodeCaseRecipe({ ...recipe, repositories: [] }))).rejects.toThrow(/non-empty/)
    await expect(Effect.runPromise(decodeCaseRecipe({ ...recipe, repositories: [recipe.repositories[0], { ...recipe.repositories[0], name: "other" }] }))).rejects.toThrow(/unique/)
  })

  it("accepts exact execute egress, a sandbox CLI agent, and collected outputs", async () => {
    const decoded = await Effect.runPromise(decodeCaseRecipe({
      ...recipe,
      executeEgress: [{ host: "api.anthropic.com", port: 443 }],
      collect: [{ repository: "repo", path: "answer.json" }],
      agent: {
        adapter: "cli",
        repository: "repo",
        selection: { kind: "explicit", id: "claude" },
        prompt: "diagnose the captures",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        path: [".agent/node_modules/.bin"]
      }
    }))

    expect(decoded.executeEgress).toEqual([{ host: "api.anthropic.com", port: 443 }])
    expect(decoded.agent.adapter).toBe("cli")
    expect(decoded.collect).toEqual([{ repository: "repo", path: "answer.json" }])
  })

  it.each([
    [{ host: "*.anthropic.com", port: 443 }, "wildcard"],
    [{ host: "127.0.0.1", port: 443 }, "IP literals"],
    [{ host: "metadata.google.internal", port: 443 }, "internal"],
    [{ host: "api.anthropic.com", port: 0 }, "port"]
  ] as const)("rejects unsafe execute egress %#", async (entry, message) => {
    await expect(Effect.runPromise(decodeCaseRecipe({
      ...recipe,
      executeEgress: [entry]
    }))).rejects.toThrow(new RegExp(message, "i"))
  })

  it("requires a CLI agent to allow only its selected provider endpoint", async () => {
    await expect(Effect.runPromise(decodeCaseRecipe({
      ...recipe,
      executeEgress: [{ host: "api.openai.com", port: 443 }],
      agent: {
        adapter: "cli",
        repository: "repo",
        selection: { kind: "explicit", id: "claude" },
        prompt: "diagnose",
        provider: "anthropic"
      }
    }))).rejects.toThrow(/api\.anthropic\.com:443/)
  })

  it.each(["openai-codex", "xai"] as const)("accepts the narrow host credential proxy exception for %s", async (provider) => {
    const decoded = await Effect.runPromise(decodeCaseRecipe({
      ...recipe,
      executeEgress: [{
        kind: "credential-proxy",
        host: "host.docker.internal",
        port: 43_117,
        provider
      }],
      agent: {
        adapter: "cli",
        repository: "repo",
        selection: { kind: "explicit", id: "pi" },
        prompt: "diagnose",
        provider
      }
    }))

    expect(decoded.executeEgress).toEqual([{
      kind: "credential-proxy",
      host: "host.docker.internal",
      port: 43_117,
      provider
    }])
  })

  it("rejects a broad or mismatched host proxy exception", async () => {
    await expect(Effect.runPromise(decodeCaseRecipe({
      ...recipe,
      executeEgress: [{ host: "host.docker.internal", port: 43_117 }]
    }))).rejects.toThrow(/internal or invalid host/)
    await expect(Effect.runPromise(decodeCaseRecipe({
      ...recipe,
      executeEgress: [{
        kind: "credential-proxy",
        host: "host.docker.internal",
        port: 43_117,
        provider: "xai"
      }],
      agent: {
        adapter: "cli",
        repository: "repo",
        selection: { kind: "explicit", id: "pi" },
        prompt: "diagnose",
        provider: "openai-codex"
      }
    }))).rejects.toThrow(/openai-codex/)
  })

  it("rejects embedded credentials and escaping command directories", async () => {
    await expect(Effect.runPromise(decodeCaseRecipe({
      ...recipe,
      repositories: [{ ...recipe.repositories[0], provision: [{ argv: ["npm", "ci"], env: { OPENAI_API_KEY: "nope" } }] }]
    }))).rejects.toThrow(/credentials may not be embedded/)
    await expect(Effect.runPromise(decodeCaseRecipe({
      ...recipe,
      verify: [{ argv: ["true"], cwd: "../oracle" }]
    }))).rejects.toThrow(/unsafe command cwd/)
  })

  it("confines resolved paths", () => {
    expect(resolveInside("/tmp/root", "a/b")).toBe("/tmp/root/a/b")
    expect(() => resolveInside("/tmp/root", "../secret")).toThrow(/escapes workspace/)
  })

  it("property-checks randomized traversal destinations", () => {
    let state = 0x5eed1234
    const next = () => (state = (state * 1664525 + 1013904223) >>> 0)
    for (let index = 0; index < 500; index++) {
      const segment = Array.from({ length: 1 + next() % 20 }, () => String.fromCharCode(97 + next() % 26)).join("")
      expect(isSafeDestination(`../${segment}`)).toBe(false)
      expect(isSafeDestination(`${segment}/${segment}`)).toBe(false)
      expect(isSafeDestination(segment)).toBe(true)
    }
  })
})
