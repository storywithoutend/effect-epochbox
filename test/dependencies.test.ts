import { promises as fs } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { HostProcessAgent } from "../src/agent.js"
import { runLockedCase } from "../src/runner.js"
import type { CaseRecipe, DependencyReplacement } from "../src/schema.js"
import { sha256 } from "../src/util/canonical.js"
import { baseRecipe, command, compileFixture, fakeRunLayer, makeRepository, tempDirectory } from "./helpers.js"

const runFake = (lock: Awaited<ReturnType<typeof compileFixture>>, artifacts: string, evidence: string) =>
  Effect.runPromise(runLockedCase(lock, artifacts, evidence, HostProcessAgent).pipe(Effect.provide(fakeRunLayer)))

const packageFixture = async (root: string, name: string, dependency: string, requested: string) => {
  const packageJson = { name: `${name}-app`, version: "1.0.0", private: true, dependencies: { [dependency]: requested } }
  return makeRepository(root, name, {
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    ".gitignore": "node_modules/\n"
  })
}

const syntheticInstall = (dependency: string, name: string, version: string): ReadonlyArray<string> => [
  "node",
  "-e",
  `const fs=require('fs');fs.mkdirSync('node_modules/${dependency}',{recursive:true});fs.writeFileSync('node_modules/${dependency}/package.json',JSON.stringify({name:${JSON.stringify(name)},version:${JSON.stringify(version)}}));const p=JSON.parse(fs.readFileSync('package.json'));fs.writeFileSync('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'':p,'node_modules/${dependency}':{name:${JSON.stringify(name)},version:${JSON.stringify(version)}}}},null,2)+'\\n')`
]

describe("npm compatibility replacements", () => {
  it("replaces a missing historical version with a declared secure exact version", async () => {
    const root = await tempDirectory("version")
    const repo = await packageFixture(root, "source", "historical-lib", "0.0.0-removed")
    const base = baseRecipe([{ ...repo, name: "app" }])
    const replacement: DependencyReplacement = {
      ecosystem: "npm",
      repository: "app",
      match: { package: "historical-lib", requested: "0.0.0-removed" },
      replacement: { kind: "version", version: "2.4.1" },
      reason: "removed vulnerable release"
    }
    const recipe: CaseRecipe = {
      ...base,
      repositories: [{ ...base.repositories[0]!, provision: [{ argv: syntheticInstall("historical-lib", "historical-lib", "2.4.1") }] }],
      replacements: [replacement]
    }
    const artifacts = path.join(root, "artifacts")
    const evidence = path.join(root, "evidence")
    await runFake(await compileFixture(recipe, artifacts), artifacts, evidence)
    const manifest = JSON.parse(await fs.readFile(path.join(evidence, "replacement-manifest.json"), "utf8")) as Array<{ finalResolution: string; mechanism: string; reason: string }>
    expect(manifest[0]).toMatchObject({ finalResolution: "historical-lib@2.4.1", mechanism: "package.json exact version", reason: "removed vulnerable release" })
  })

  it("supports a renamed npm fork through package aliases", async () => {
    const root = await tempDirectory("alias")
    const repo = await packageFixture(root, "source", "legacy-lib", "1.0.0")
    const base = baseRecipe([{ ...repo, name: "app" }])
    const recipe: CaseRecipe = {
      ...base,
      repositories: [{ ...base.repositories[0]!, provision: [{ argv: syntheticInstall("legacy-lib", "secure-fork", "3.0.0") }] }],
      replacements: [{
        ecosystem: "npm",
        repository: "app",
        match: { package: "legacy-lib", requested: "1.0.0" },
        replacement: { kind: "alias", package: "secure-fork", version: "3.0.0" },
        reason: "maintained fork"
      }]
    }
    const artifacts = path.join(root, "artifacts")
    const evidence = path.join(root, "evidence")
    await runFake(await compileFixture(recipe, artifacts), artifacts, evidence)
    const manifest = await fs.readFile(path.join(evidence, "replacement-manifest.json"), "utf8")
    expect(manifest).toContain("npm package alias")
    expect(manifest).toContain("secure-fork@3.0.0")
  })

  it("replays a content-addressed artifact offline and rejects tampering", async () => {
    const root = await tempDirectory("artifact")
    const packageRoot = path.join(root, "artifact-package")
    await fs.mkdir(packageRoot)
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "offline-lib", version: "9.1.0", files: ["index.js"] }))
    await fs.writeFile(path.join(packageRoot, "index.js"), "module.exports = 91\n")
    const packedName = command(packageRoot, "npm", ["pack", "--silent"]).trim()
    const packed = path.join(packageRoot, packedName)
    const digest = sha256(await fs.readFile(packed))
    const repo = await packageFixture(root, "source", "offline-lib", "0.0.0-removed")
    const base = baseRecipe([{ ...repo, name: "app" }])
    const recipe: CaseRecipe = {
      ...base,
      repositories: [{ ...base.repositories[0]!, provision: [{ argv: ["npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"] }] }],
      replacements: [{
        ecosystem: "npm",
        repository: "app",
        match: { package: "offline-lib", requested: "0.0.0-removed" },
        replacement: { kind: "artifact", path: packed, sha256: digest },
        reason: "registry artifact was removed"
      }]
    }
    const artifacts = path.join(root, "artifacts")
    const lock = await compileFixture(recipe, artifacts)
    await fs.rm(packageRoot, { recursive: true })
    await runFake(lock, artifacts, path.join(root, "evidence-1"))
    await runFake(lock, artifacts, path.join(root, "evidence-2"))
    const replacement = lock.replacements[0]!
    expect(replacement.artifactPath).toBeDefined()
    await fs.appendFile(path.join(artifacts, replacement.artifactPath!), "tampered")
    await expect(runFake(lock, artifacts, path.join(root, "evidence-tampered"))).rejects.toThrow(/artifact tampered|integrity mismatch/)
  })

  it("uses another materialized repository as an npm file dependency", async () => {
    const root = await tempDirectory("workspace")
    const app = await packageFixture(root, "app-source", "shared-lib", "0.0.0")
    const library = await makeRepository(root, "library-source", {
      "package.json": JSON.stringify({ name: "shared-lib", version: "4.2.0", main: "index.js" }),
      "index.js": "module.exports = 42\n"
    })
    const base = baseRecipe([{ ...app, name: "app" }, { ...library, name: "library" }])
    const recipe: CaseRecipe = {
      ...base,
      repositories: [
        { ...base.repositories[0]!, provision: [{ argv: ["npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"] }] },
        base.repositories[1]!
      ],
      replacements: [{
        ecosystem: "npm",
        repository: "app",
        match: { package: "shared-lib", requested: "0.0.0" },
        replacement: { kind: "workspace", repository: "library" },
        reason: "use co-materialized source"
      }]
    }
    const artifacts = path.join(root, "artifacts")
    const evidence = path.join(root, "evidence")
    await runFake(await compileFixture(recipe, artifacts), artifacts, evidence)
    expect(await fs.readFile(path.join(evidence, "replacement-manifest.json"), "utf8")).toContain("shared-lib@4.2.0")
  })

  it("refuses undeclared dependency resolution drift", async () => {
    const root = await tempDirectory("drift")
    const packageJson = { name: "app", version: "1.0.0", dependencies: { drifted: "1.0.0" } }
    const packageLock = { lockfileVersion: 3, packages: { "": packageJson, "node_modules/drifted": { name: "drifted", version: "1.0.0" } } }
    const repo = await makeRepository(root, "source", {
      "package.json": JSON.stringify(packageJson),
      "package-lock.json": JSON.stringify(packageLock),
      ".gitignore": "node_modules/\n"
    })
    const base = baseRecipe([{ ...repo, name: "app" }])
    const recipe: CaseRecipe = { ...base, repositories: [{ ...base.repositories[0]!, provision: [{ argv: syntheticInstall("drifted", "drifted", "2.0.0") }] }] }
    const artifacts = path.join(root, "artifacts")
    await expect(runFake(await compileFixture(recipe, artifacts), artifacts, path.join(root, "evidence"))).rejects.toThrow(/undeclared resolution drift/)
  })
})
