import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { Effect, Layer } from "effect"
import { afterAll } from "vitest"
import type { CaseRecipe } from "../src/schema.js"
import { compileCase } from "../src/compiler.js"
import { GitSourceLive } from "../src/services/git-source.js"
import { ImageResolverFixed } from "../src/services/image-resolver.js"
import { FakeBackendLive } from "../src/services/fake-backend.js"
import { NpmDependencyAdapterLive } from "../src/services/dependency-adapter.js"
import type { CaseLock } from "../src/lock.js"

const temporaryDirectories = new Set<string>()

afterAll(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => fs.rm(directory, { recursive: true, force: true })))
  temporaryDirectories.clear()
})

export const tempDirectory = async (name: string): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `epochbox-test-${name}-`))
  temporaryDirectories.add(directory)
  return directory
}

export const command = (cwd: string, executable: string, args: ReadonlyArray<string>): string => {
  const result = spawnSync(executable, [...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

export const makeRepository = async (root: string, name: string, files: Readonly<Record<string, string>>): Promise<{ path: string; commit: string }> => {
  const repository = path.join(root, name)
  await fs.mkdir(repository, { recursive: true })
  command(repository, "git", ["init", "-q"])
  command(repository, "git", ["config", "user.name", "Fixture"])
  command(repository, "git", ["config", "user.email", "fixture@invalid"])
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repository, file)), { recursive: true })
    await fs.writeFile(path.join(repository, file), contents)
  }
  command(repository, "git", ["add", "-A"])
  command(repository, "git", ["commit", "-q", "-m", "historical"])
  return { path: repository, commit: command(repository, "git", ["rev-parse", "HEAD"]).trim() }
}

export const baseRecipe = (repositories: ReadonlyArray<{ path: string; commit: string; name: string }>): CaseRecipe => ({
  version: 1,
  name: "fixture",
  image: "fake:shell",
  repositories: repositories.map((repository) => ({
    name: repository.name,
    source: repository.path,
    commit: repository.commit,
    destination: repository.name,
    provision: []
  })),
  replacements: [],
  allowChanges: repositories.map((repository) => repository.name),
  agent: { adapter: "host-process", actions: [] },
  verify: []
})

export const compileFixture = (recipe: CaseRecipe, artifacts: string): Promise<CaseLock> =>
  Effect.runPromise(compileCase(recipe, artifacts).pipe(Effect.provide(Layer.merge(GitSourceLive, ImageResolverFixed()))))

export const fakeRunLayer = Layer.mergeAll(FakeBackendLive, NpmDependencyAdapterLive, ImageResolverFixed())
