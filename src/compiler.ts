import { promises as fs } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { ConfigurationError, IntegrityError } from "./errors.js"
import type { CaseLock, CaseLockBody, LockedReplacement } from "./lock.js"
import { decodeCaseRecipe } from "./schema.js"
import { GitSource } from "./services/git-source.js"
import { ImageResolver } from "./services/image-resolver.js"
import { canonicalJson, sha256 } from "./util/canonical.js"
import { readJson, writeJson } from "./util/fs.js"
import { isSafeRelativePath } from "./schema.js"
import { isSafeDestination } from "./util/path.js"

const copyReplacementArtifact = (
  replacement: LockedReplacement,
  artifactDirectory: string
): Effect.Effect<LockedReplacement, ConfigurationError | IntegrityError> => {
  if (replacement.replacement.kind !== "artifact") return Effect.succeed(replacement)
  const target = replacement.replacement
  return Effect.tryPromise({
    try: async () => {
      const bytes = await fs.readFile(target.path)
      const actual = sha256(bytes)
      if (actual !== target.sha256) {
        throw new Error(`artifact hash mismatch: declared ${target.sha256}, actual ${actual}`)
      }
      const extension = path.extname(target.path) || ".tgz"
      const relative = `artifacts/${actual}${extension}`
      const destination = path.join(artifactDirectory, relative)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, bytes)
      return { ...replacement, artifactPath: relative, artifactSha256: actual }
    },
    catch: (cause) => new ConfigurationError({ message: String(cause), path: target.path })
  })
}

export const compileCase = (
  input: unknown,
  artifactDirectory: string
): Effect.Effect<CaseLock, ConfigurationError | IntegrityError | import("./errors.js").SourceArchiveError | import("./errors.js").BackendError, GitSource | ImageResolver> =>
  Effect.gen(function* () {
    const recipe = yield* decodeCaseRecipe(input)
    const gitSource = yield* GitSource
    const imageResolver = yield* ImageResolver
    const imageIdentity = yield* imageResolver.resolve(recipe.image)
    yield* Effect.tryPromise({
      try: () => fs.mkdir(path.join(artifactDirectory, "archives"), { recursive: true }),
      catch: (cause) => new IntegrityError({ message: String(cause), path: artifactDirectory })
    })
    const repositories = []
    for (const repository of recipe.repositories) {
      const snapshot = yield* gitSource.archive(repository.source, repository.commit, repository.name)
      const archivePath = `archives/${repository.destination}.tar`
      yield* Effect.tryPromise({
        try: () => fs.writeFile(path.join(artifactDirectory, archivePath), snapshot.bytes),
        catch: (cause) => new IntegrityError({ message: String(cause), path: archivePath })
      })
      repositories.push({
        name: repository.name,
        source: path.resolve(repository.source),
        commit: snapshot.commit,
        tree: snapshot.tree,
        destination: repository.destination,
        archivePath,
        archiveSha256: snapshot.sha256,
        archiveSize: snapshot.bytes.length,
        provision: repository.provision ?? []
      })
    }
    const replacements: LockedReplacement[] = []
    for (const replacement of recipe.replacements ?? []) {
      replacements.push(yield* copyReplacementArtifact(replacement, artifactDirectory))
    }
    const body: CaseLockBody = {
      formatVersion: 2,
      caseName: recipe.name,
      image: { reference: recipe.image, identity: imageIdentity },
      repositories,
      replacements,
      allowChanges: [...recipe.allowChanges].sort(),
      executeEgress: [...(recipe.executeEgress ?? [])].sort((left, right) =>
        left.host.localeCompare(right.host) || left.port - right.port
      ),
      collect: [...(recipe.collect ?? [])].sort((left, right) =>
        left.repository.localeCompare(right.repository) || left.path.localeCompare(right.path)
      ),
      agent: recipe.agent,
      verify: recipe.verify ?? []
    }
    return { ...body, lockId: sha256(canonicalJson(body)) }
  })

export const compileCaseFile = (
  recipePath: string,
  lockPath: string
): Effect.Effect<CaseLock, ConfigurationError | IntegrityError | import("./errors.js").SourceArchiveError | import("./errors.js").BackendError, GitSource | ImageResolver> =>
  Effect.gen(function* () {
    const input = yield* readJson(recipePath)
    const artifactDirectory = `${lockPath}.artifacts`
    const lock = yield* compileCase(input, artifactDirectory)
    yield* writeJson(lockPath, lock)
    return lock
  })

export const validateLock = (input: unknown): Effect.Effect<CaseLock, ConfigurationError> => {
  if (input === null || typeof input !== "object") return Effect.fail(new ConfigurationError({ message: "lock must be an object" }))
  const candidate = input as Partial<CaseLock>
  if (
    candidate.formatVersion !== 2 || typeof candidate.lockId !== "string" || !/^[0-9a-f]{64}$/.test(candidate.lockId) ||
    typeof candidate.caseName !== "string" || candidate.image === undefined || typeof candidate.image.reference !== "string" || typeof candidate.image.identity !== "string" ||
    !Array.isArray(candidate.repositories) || candidate.repositories.length === 0 || !Array.isArray(candidate.replacements) ||
    !Array.isArray(candidate.allowChanges) || !Array.isArray(candidate.executeEgress) || !Array.isArray(candidate.collect) ||
    candidate.agent === undefined || !Array.isArray(candidate.verify)
  ) return Effect.fail(new ConfigurationError({ message: "invalid case lock" }))
  const lock = candidate as CaseLock
  for (const [index, repository] of lock.repositories.entries()) {
    if (
      typeof repository.name !== "string" || typeof repository.source !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(repository.commit) ||
      !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(repository.tree) || !isSafeDestination(repository.destination) ||
      !isSafeRelativePath(repository.archivePath) || !/^[0-9a-f]{64}$/.test(repository.archiveSha256) ||
      !Number.isSafeInteger(repository.archiveSize) || repository.archiveSize <= 0 || !Array.isArray(repository.provision)
    ) return Effect.fail(new ConfigurationError({ message: "invalid locked repository", path: `repositories[${index}]` }))
  }
  for (const [index, replacement] of lock.replacements.entries()) {
    if (replacement.artifactPath !== undefined && !isSafeRelativePath(replacement.artifactPath)) {
      return Effect.fail(new ConfigurationError({ message: "unsafe locked artifact path", path: `replacements[${index}].artifactPath` }))
    }
    if (replacement.artifactSha256 !== undefined && !/^[0-9a-f]{64}$/.test(replacement.artifactSha256)) {
      return Effect.fail(new ConfigurationError({ message: "invalid locked artifact hash", path: `replacements[${index}].artifactSha256` }))
    }
  }
  return Effect.gen(function* () {
    yield* decodeCaseRecipe({
      version: 1,
      name: lock.caseName,
      image: lock.image.reference,
      repositories: lock.repositories.map(({ name, source, commit, destination, provision }) => ({ name, source, commit, destination, provision })),
      replacements: lock.replacements,
      allowChanges: lock.allowChanges,
      executeEgress: lock.executeEgress,
      collect: lock.collect,
      agent: lock.agent,
      verify: lock.verify
    })
    const { lockId: _lockId, ...body } = lock
    const expected = sha256(canonicalJson(body))
    if (expected !== lock.lockId) return yield* new ConfigurationError({ message: `lock identity mismatch: expected ${expected}, got ${lock.lockId}` })
    return lock
  })
}
