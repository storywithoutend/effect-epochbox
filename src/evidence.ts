import { promises as fs } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { IntegrityError, VerificationError } from "./errors.js"
import type { CaseLock } from "./lock.js"
import type { AgentTranscriptEntry } from "./agent.js"
import type { AppliedReplacement, DependencyInventoryEntry } from "./services/dependency-adapter.js"
import type { SealAttestation } from "./services/backend.js"
import { hashTree, writeJson } from "./util/fs.js"
import { sha256 } from "./util/canonical.js"
import { validateLock } from "./compiler.js"
import type { WorkspaceSymlinkRepair } from "./workspace.js"

export interface RepositoryEvidence {
  readonly name: string
  readonly destination: string
  readonly status: ReadonlyArray<string>
  readonly patch: string
  readonly changed: boolean
  readonly authorized: boolean
}

export interface CommandEvidence {
  readonly argv: ReadonlyArray<string>
  readonly cwd?: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CollectedOutputEvidence {
  readonly repository: string
  readonly path: string
  readonly exists: boolean
  readonly sha256?: string
  readonly size?: number
  readonly contentBase64?: string
}

export interface EvidenceInput {
  readonly lock: CaseLock
  readonly artifactDirectory: string
  readonly replacements: ReadonlyArray<AppliedReplacement>
  readonly inventory: ReadonlyArray<DependencyInventoryEntry>
  readonly provisioning: ReadonlyArray<CommandEvidence>
  readonly attestation: SealAttestation & { readonly sealedWorkspaceSha256: string }
  readonly transcript: ReadonlyArray<AgentTranscriptEntry>
  readonly workspaceSymlinks: ReadonlyArray<WorkspaceSymlinkRepair>
  readonly repositories: ReadonlyArray<RepositoryEvidence>
  readonly outputs: ReadonlyArray<CollectedOutputEvidence>
  readonly tests: ReadonlyArray<CommandEvidence>
}

export const emitEvidence = (directory: string, input: EvidenceInput): Effect.Effect<void, IntegrityError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await fs.access(directory)
          throw new Error(`evidence directory already exists: ${directory}`)
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
        }
        await fs.mkdir(path.join(directory, "archives"), { recursive: true })
        await fs.mkdir(path.join(directory, "repositories"), { recursive: true })
        await fs.mkdir(path.join(directory, "outputs"), { recursive: true })
        for (const repository of input.lock.repositories) {
          await fs.copyFile(path.join(input.artifactDirectory, repository.archivePath), path.join(directory, "archives", `${repository.destination}.tar`))
        }
        for (const replacement of input.lock.replacements) {
          if (replacement.artifactPath === undefined) continue
          const destination = path.join(directory, replacement.artifactPath)
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.copyFile(path.join(input.artifactDirectory, replacement.artifactPath), destination)
        }
        for (const repository of input.repositories) {
          await fs.writeFile(path.join(directory, "repositories", `${repository.destination}.patch`), repository.patch)
          await fs.writeFile(path.join(directory, "repositories", `${repository.destination}.status.json`), JSON.stringify(repository.status, null, 2) + "\n")
        }
        for (const output of input.outputs) {
          if (!output.exists || output.contentBase64 === undefined) continue
          const destination = path.join(directory, "outputs", output.repository, output.path)
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.writeFile(destination, Buffer.from(output.contentBase64, "base64"))
        }
      },
      catch: (cause) => new IntegrityError({ message: String(cause), path: directory })
    })
    yield* writeJson(path.join(directory, "case-lock.json"), input.lock)
    yield* writeJson(path.join(directory, "snapshot-manifest.json"), input.lock.repositories.map((repository) => ({
      name: repository.name,
      destination: repository.destination,
      commit: repository.commit,
      tree: repository.tree,
      archive: `archives/${repository.destination}.tar`,
      sha256: repository.archiveSha256,
      size: repository.archiveSize,
      fidelity: (() => {
        const replacements = input.replacements.filter((replacement) => replacement.repository === repository.name)
        if (replacements.length === 0) return "exact"
        if (replacements.some((replacement) => replacement.fidelity === "degraded")) return "degraded"
        if (replacements.some((replacement) => replacement.fidelity === "reconstructed")) return "reconstructed"
        return "substituted"
      })()
    })))
    yield* writeJson(path.join(directory, "replacement-manifest.json"), input.replacements)
    yield* writeJson(path.join(directory, "resolved-dependencies.json"), input.inventory)
    yield* writeJson(path.join(directory, "provisioning-record.json"), input.provisioning)
    yield* writeJson(path.join(directory, "network-seal-attestation.json"), input.attestation)
    yield* writeJson(path.join(directory, "agent-transcript.json"), input.transcript)
    yield* writeJson(path.join(directory, "workspace-symlink-compatibility.json"), input.workspaceSymlinks)
    yield* writeJson(path.join(directory, "output-manifest.json"), input.outputs.map(({ contentBase64: _contentBase64, ...output }) => output))
    yield* writeJson(path.join(directory, "test-results.json"), {
      commands: input.tests,
      repositories: input.repositories.map(({ patch: _patch, ...repository }) => repository),
      unauthorizedRepositories: input.repositories.filter((repository) => repository.changed && !repository.authorized).map((repository) => repository.name),
      agentPassed: input.transcript.every((entry) => entry.exitCode === 0),
      passed: input.transcript.every((entry) => entry.exitCode === 0) &&
        input.tests.every((test) => test.exitCode === 0) &&
        input.repositories.every((repository) => !repository.changed || repository.authorized)
    })
    const hashes = yield* hashTree(directory, new Set(["hash-manifest.json"]))
    yield* writeJson(path.join(directory, "hash-manifest.json"), { algorithm: "sha256", files: hashes })
  })

export interface OfflineVerificationReport {
  readonly valid: boolean
  readonly filesChecked: number
  readonly lockId: string
  readonly errors: ReadonlyArray<string>
}

export const verifyEvidence = (directory: string): Effect.Effect<OfflineVerificationReport, VerificationError> =>
  Effect.tryPromise({
    try: async () => {
      const errors: string[] = []
      const rootStat = await fs.lstat(directory)
      const manifestPath = path.join(directory, "hash-manifest.json")
      const manifestStat = await fs.lstat(manifestPath)
      if (rootStat.isSymbolicLink() || manifestStat.isSymbolicLink()) throw new Error("evidence root and hash manifest must not be symbolic links")
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        algorithm?: string
        files?: ReadonlyArray<{ path: string; sha256: string; size: number; kind: "file" | "symlink" }>
      }
      if (manifest.algorithm !== "sha256" || !Array.isArray(manifest.files)) throw new Error("invalid hash manifest")
      const actual = await Effect.runPromise(hashTree(directory, new Set(["hash-manifest.json"])))
      const expectedMap = new Map(manifest.files.map((entry) => [entry.path, entry]))
      const actualMap = new Map(actual.map((entry) => [entry.path, entry]))
      for (const [file, expected] of expectedMap) {
        const found = actualMap.get(file)
        if (found === undefined) errors.push(`missing file: ${file}`)
        else if (found.sha256 !== expected.sha256 || found.size !== expected.size || found.kind !== expected.kind) errors.push(`hash mismatch: ${file}`)
      }
      for (const file of actualMap.keys()) if (!expectedMap.has(file)) errors.push(`unmanifested file: ${file}`)
      const unsafeSymlinks = actual.filter((entry) => entry.kind === "symlink")
      for (const entry of unsafeSymlinks) errors.push(`symbolic link is not allowed in evidence: ${entry.path}`)
      if (unsafeSymlinks.length > 0) return { valid: false, filesChecked: manifest.files.length, lockId: "unverified", errors }
      const lockUnknown = JSON.parse(await fs.readFile(path.join(directory, "case-lock.json"), "utf8")) as unknown
      const lock = await Effect.runPromise(validateLock(lockUnknown))
      for (const repository of lock.repositories) {
        const archive = await fs.readFile(path.join(directory, "archives", `${repository.destination}.tar`))
        if (archive.length !== repository.archiveSize || sha256(archive) !== repository.archiveSha256) errors.push(`snapshot mismatch: ${repository.name}`)
      }
      for (const replacement of lock.replacements) {
        if (replacement.artifactPath === undefined || replacement.artifactSha256 === undefined) continue
        const bytes = await fs.readFile(path.join(directory, replacement.artifactPath))
        if (sha256(bytes) !== replacement.artifactSha256) errors.push(`replacement artifact mismatch: ${replacement.match.package}`)
      }
      return { valid: errors.length === 0, filesChecked: manifest.files.length, lockId: lock.lockId, errors }
    },
    catch: (cause) => new VerificationError({ message: cause instanceof Error ? cause.message : String(cause), check: "offline-integrity" })
  })
