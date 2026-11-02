import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Exit } from "effect"
import { IntegrityError } from "./errors.js"
import type { CaseLock } from "./lock.js"
import { sha256 } from "./util/canonical.js"
import { runProcess, stdoutText } from "./util/process.js"

export interface WorkspaceSymlinkCompatibility {
  readonly repository: string
  readonly repositoryDestination: string
  readonly path: string
  readonly target: string
  readonly placeholderPath: string
}

export interface WorkspaceSymlinkRepair extends WorkspaceSymlinkCompatibility {
  readonly restored: boolean
}

export interface MaterializedWorkspace {
  readonly root: string
  readonly repositoriesRoot: string
  readonly originalLockfiles: Readonly<Record<string, string | null>>
  readonly compatibilitySymlinks: ReadonlyArray<WorkspaceSymlinkCompatibility>
}

export const assertNoEscapingSymlinks = (
  root: string,
  confinementRoot: string = root
): Effect.Effect<void, IntegrityError> =>
  Effect.tryPromise({
    try: async () => {
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const absolute = path.join(directory, entry.name)
          if (entry.isDirectory()) await visit(absolute)
          else if (entry.isSymbolicLink()) {
            const target = await fs.readlink(absolute)
            const resolved = path.resolve(path.dirname(absolute), target)
            if (resolved !== confinementRoot && !resolved.startsWith(`${confinementRoot}${path.sep}`)) {
              throw new Error(`symlink escapes workspace: ${path.relative(root, absolute)} -> ${target}`)
            }
          }
        }
      }
      await visit(root)
    },
    catch: (cause) => new IntegrityError({ message: String(cause), path: root })
  })

interface MaterializedSymlinkTarget {
  readonly path: string
  readonly target: string
  readonly placeholderPath: string
}

export const materializeWorkspaceSymlinkTargets = (
  root: string,
  confinementRoot: string
): Effect.Effect<ReadonlyArray<MaterializedSymlinkTarget>, IntegrityError> =>
  Effect.tryPromise({
    try: async () => {
      const materialized: MaterializedSymlinkTarget[] = []
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const absolute = path.join(directory, entry.name)
          if (entry.isDirectory()) {
            await visit(absolute)
            continue
          }
          if (!entry.isSymbolicLink()) continue
          const target = await fs.readlink(absolute)
          const resolved = path.resolve(path.dirname(absolute), target)
          const isInsideConfinement = resolved === confinementRoot || resolved.startsWith(`${confinementRoot}${path.sep}`)
          const isOutsideRepository = resolved !== root && !resolved.startsWith(`${root}${path.sep}`)
          if (!isInsideConfinement || !isOutsideRepository) continue
          const exists = await fs.lstat(resolved).then(() => true, (cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return false
            throw cause
          })
          if (!exists) await fs.mkdir(resolved, { recursive: true })
          materialized.push({
            path: path.relative(root, absolute),
            target,
            placeholderPath: path.relative(confinementRoot, resolved)
          })
        }
      }
      await visit(root)
      return materialized
    },
    catch: (cause) => new IntegrityError({ message: String(cause), path: root })
  })

const assertSafeArchive = (archive: string) =>
  runProcess("tar", ["-tf", archive]).pipe(
    Effect.flatMap((result) => {
      const unsafe = stdoutText(result).split("\n").filter(Boolean).find((entry) =>
        entry.startsWith("/") || entry.split("/").some((part) => part === "..")
      )
      return unsafe === undefined
        ? Effect.void
        : Effect.fail(new IntegrityError({ message: `unsafe archive entry ${unsafe}`, path: archive }))
    }),
    Effect.mapError((cause) => cause instanceof IntegrityError ? cause : new IntegrityError({ message: cause.message, path: archive }))
  )

export const materializeWorkspace = (
  lock: CaseLock,
  artifactDirectory: string
): Effect.Effect<MaterializedWorkspace, IntegrityError> =>
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => fs.mkdtemp(path.join(os.tmpdir(), `effect-epochbox-${lock.lockId.slice(0, 8)}-`)),
      catch: (cause) => new IntegrityError({ message: String(cause), path: os.tmpdir() })
    })
    const build = Effect.gen(function* () {
      const repositoriesRoot = path.join(root, "repos")
      yield* Effect.tryPromise({
      try: () => fs.mkdir(repositoriesRoot, { recursive: true }),
      catch: (cause) => new IntegrityError({ message: String(cause), path: repositoriesRoot })
      })
      const originalLockfiles: Record<string, string | null> = {}
      const compatibilitySymlinks: WorkspaceSymlinkCompatibility[] = []
      for (const repository of lock.repositories) {
      const archive = path.join(artifactDirectory, repository.archivePath)
      const bytes = yield* Effect.tryPromise({
        try: () => fs.readFile(archive),
        catch: (cause) => new IntegrityError({ message: String(cause), path: archive })
      })
      if (bytes.length !== repository.archiveSize || sha256(bytes) !== repository.archiveSha256) {
        return yield* new IntegrityError({ message: `archive integrity mismatch for ${repository.name}`, path: archive })
      }
      yield* assertSafeArchive(archive)
      const destination = path.join(repositoriesRoot, repository.destination)
      yield* Effect.tryPromise({
        try: () => fs.mkdir(destination, { recursive: true }),
        catch: (cause) => new IntegrityError({ message: String(cause), path: destination })
      })
      yield* runProcess("tar", ["-xf", archive, "-C", destination]).pipe(
        Effect.mapError((cause) => new IntegrityError({ message: cause.message, path: archive }))
      )
      yield* assertNoEscapingSymlinks(destination, repositoriesRoot)
      const materializedSymlinks = yield* materializeWorkspaceSymlinkTargets(destination, repositoriesRoot)
      compatibilitySymlinks.push(...materializedSymlinks.map((entry) => ({
        repository: repository.name,
        repositoryDestination: repository.destination,
        ...entry
      })))
      const dotGit = path.join(destination, ".git")
      const gitPresent = yield* Effect.tryPromise({ try: () => fs.stat(dotGit).then(() => true, () => false), catch: () => new IntegrityError({ message: "cannot inspect materialized repository", path: dotGit }) })
      if (gitPresent) return yield* new IntegrityError({ message: "source archive unexpectedly contains .git", path: dotGit })
      const packageLock = path.join(destination, "package-lock.json")
      originalLockfiles[repository.name] = yield* Effect.tryPromise({
        try: () => fs.readFile(packageLock).then((value) => sha256(value), () => null),
        catch: (cause) => new IntegrityError({ message: String(cause), path: packageLock })
      })
      }
      const retainedArtifacts = path.join(root, ".epochbox-artifacts")
      yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(retainedArtifacts, { recursive: true })
        for (const replacement of lock.replacements) {
          if (replacement.replacement.kind !== "artifact" || replacement.artifactPath === undefined || replacement.artifactSha256 === undefined) continue
          const source = path.join(artifactDirectory, replacement.artifactPath)
          const bytes = await fs.readFile(source)
          if (sha256(bytes) !== replacement.artifactSha256) throw new Error(`replacement artifact tampered: ${source}`)
          await fs.copyFile(source, path.join(retainedArtifacts, path.basename(replacement.artifactPath)))
        }
      },
      catch: (cause) => new IntegrityError({ message: String(cause), path: retainedArtifacts })
      })
      return { root, repositoriesRoot, originalLockfiles, compatibilitySymlinks }
    })
    return yield* build.pipe(Effect.onExit((exit) => Exit.isFailure(exit)
      ? Effect.tryPromise({ try: () => fs.rm(root, { recursive: true, force: true }), catch: () => undefined }).pipe(Effect.ignore)
      : Effect.void))
  })

export const restoreWorkspaceCompatibilitySymlinks = (
  workspace: MaterializedWorkspace
): Effect.Effect<ReadonlyArray<WorkspaceSymlinkRepair>, IntegrityError> =>
  Effect.tryPromise({
    try: async () => {
      const repairs: WorkspaceSymlinkRepair[] = []
      for (const entry of workspace.compatibilitySymlinks) {
        const absolute = path.join(workspace.repositoriesRoot, entry.repositoryDestination, entry.path)
        const stat = await fs.lstat(absolute).then((value) => value, (cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return undefined
          throw cause
        })
        const observedTarget = stat?.isSymbolicLink() === true ? await fs.readlink(absolute) : undefined
        const wasExpectedSymlink = observedTarget === entry.target
        await fs.rm(absolute, { recursive: true, force: true })
        await fs.mkdir(path.dirname(absolute), { recursive: true })
        await fs.symlink(entry.target, absolute)
        repairs.push({ ...entry, restored: !wasExpectedSymlink })
      }
      return repairs
    },
    catch: (cause) => new IntegrityError({ message: String(cause), path: workspace.root })
  })

export const removeWorkspace = (workspace: MaterializedWorkspace): Effect.Effect<void, never> =>
  Effect.tryPromise({ try: () => fs.rm(workspace.root, { recursive: true, force: true }), catch: () => undefined }).pipe(Effect.ignore)
