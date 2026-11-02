import { promises as fs } from "node:fs"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { ReplacementError } from "../errors.js"
import type { CaseLock, LockedReplacement } from "../lock.js"
import type { MaterializedWorkspace } from "../workspace.js"
import { canonicalJson, sha256 } from "../util/canonical.js"

export interface AppliedReplacement {
  readonly repository: string
  readonly match: LockedReplacement["match"]
  readonly replacement: LockedReplacement["replacement"]
  readonly reason: string
  readonly originalRequested: string
  readonly artifactSha256?: string
  readonly mechanism: string
  readonly fidelity: "substituted" | "reconstructed" | "degraded"
  readonly finalResolution: string
}

export interface DependencyInventoryEntry {
  readonly repository: string
  readonly location: string
  readonly name: string
  readonly version: string
  readonly integrity?: string
}

export interface DependencyPreparation {
  readonly applied: ReadonlyArray<Omit<AppliedReplacement, "finalResolution">>
  readonly beforeInventory: Readonly<Record<string, ReadonlyArray<DependencyInventoryEntry>>>
}

export interface DependencyAdapterService {
  readonly prepare: (lock: CaseLock, workspace: MaterializedWorkspace) => Effect.Effect<DependencyPreparation, ReplacementError>
  readonly finalize: (lock: CaseLock, workspace: MaterializedWorkspace, preparation: DependencyPreparation) => Effect.Effect<{
    readonly replacements: ReadonlyArray<AppliedReplacement>
    readonly inventory: ReadonlyArray<DependencyInventoryEntry>
  }, ReplacementError>
}

export class DependencyAdapter extends Context.Tag("effect-epochbox/DependencyAdapter")<DependencyAdapter, DependencyAdapterService>() {}

type PackageJson = Record<string, unknown> & {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  overrides?: Record<string, string>
}

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const

const repoRoot = (lock: CaseLock, workspace: MaterializedWorkspace, name: string): string => {
  const repository = lock.repositories.find((candidate) => candidate.name === name)
  if (repository === undefined) throw new Error(`unknown repository ${name}`)
  return path.join(workspace.repositoriesRoot, repository.destination)
}

const readPackageJson = async (root: string): Promise<PackageJson> => JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as PackageJson

const readInventory = async (root: string, repository: string): Promise<ReadonlyArray<DependencyInventoryEntry>> => {
  const lockPath = path.join(root, "package-lock.json")
  let parsed: { packages?: Record<string, { name?: string; version?: string; integrity?: string }> }
  try { parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as typeof parsed } catch { return [] }
  return Object.entries(parsed.packages ?? {})
    .filter(([location, item]) => location !== "" && typeof item.version === "string")
    .map(([location, item]) => ({
      repository,
      location,
      name: item.name ?? location.replace(/^.*node_modules\//, ""),
      version: item.version!,
      ...(item.integrity === undefined ? {} : { integrity: item.integrity })
    }))
    .sort((left, right) => left.location.localeCompare(right.location))
}

const installedResolution = async (root: string, replacement: LockedReplacement): Promise<string> => {
  const installedPackage = path.join(root, "node_modules", replacement.match.package, "package.json")
  const parsed = JSON.parse(await fs.readFile(installedPackage, "utf8")) as { name?: string; version?: string }
  const name = parsed.name ?? replacement.match.package
  const version = parsed.version ?? "unknown"
  if (replacement.replacement.kind === "version" && version !== replacement.replacement.version) {
    throw new Error(`resolution drift for ${replacement.match.package}: expected ${replacement.replacement.version}, got ${version}`)
  }
  if (replacement.replacement.kind === "alias" && (name !== replacement.replacement.package || version !== replacement.replacement.version)) {
    throw new Error(`alias drift for ${replacement.match.package}: expected ${replacement.replacement.package}@${replacement.replacement.version}, got ${name}@${version}`)
  }
  return `${name}@${version}`
}

export const NpmDependencyAdapterLive = Layer.succeed(DependencyAdapter, {
  prepare: (lock, workspace) => Effect.tryPromise({
    try: async () => {
      const beforeInventory: Record<string, ReadonlyArray<DependencyInventoryEntry>> = {}
      for (const repository of lock.repositories) beforeInventory[repository.name] = await readInventory(repoRoot(lock, workspace, repository.name), repository.name)
      const applied: Array<Omit<AppliedReplacement, "finalResolution">> = []
      for (const replacement of lock.replacements) {
        if (replacement.ecosystem !== "npm") throw new Error(`unsupported ecosystem ${(replacement as { ecosystem: string }).ecosystem}`)
        const root = repoRoot(lock, workspace, replacement.repository)
        const packageJson = await readPackageJson(root)
        let originalRequested: string | undefined
        let section: typeof dependencySections[number] | undefined
        for (const candidate of dependencySections) {
          const requested = packageJson[candidate]?.[replacement.match.package]
          if (requested !== undefined) { originalRequested = requested; section = candidate; break }
        }
        if (originalRequested === undefined || section === undefined) throw new Error(`matched package is not a direct dependency: ${replacement.match.package}`)
        if (replacement.match.requested !== undefined && replacement.match.requested !== originalRequested) {
          throw new Error(`requested range mismatch for ${replacement.match.package}: expected ${replacement.match.requested}, got ${originalRequested}`)
        }
        let value: string
        let mechanism: string
        let fidelity: AppliedReplacement["fidelity"]
        switch (replacement.replacement.kind) {
          case "version":
            value = replacement.replacement.version
            mechanism = "package.json exact version"
            fidelity = "substituted"
            break
          case "alias":
            value = `npm:${replacement.replacement.package}@${replacement.replacement.version}`
            mechanism = "npm package alias"
            fidelity = "substituted"
            break
          case "artifact": {
            if (replacement.artifactSha256 === undefined || replacement.artifactPath === undefined) throw new Error("locked artifact metadata missing")
            const artifact = path.join(workspace.root, ".epochbox-artifacts", path.basename(replacement.artifactPath))
            const actual = sha256(await fs.readFile(artifact))
            if (actual !== replacement.artifactSha256 || actual !== replacement.replacement.sha256) throw new Error(`artifact hash mismatch for ${replacement.match.package}`)
            value = `file:${path.relative(root, artifact).split(path.sep).join("/")}`
            mechanism = "content-addressed local npm artifact"
            fidelity = "reconstructed"
            break
          }
          case "workspace": {
            const target = repoRoot(lock, workspace, replacement.replacement.repository)
            value = `file:${path.relative(root, target).split(path.sep).join("/")}`
            mechanism = "materialized workspace file dependency"
            fidelity = "degraded"
            break
          }
        }
        packageJson[section]![replacement.match.package] = value
        await fs.writeFile(path.join(root, "package.json"), canonicalJson(packageJson))
        applied.push({
          repository: replacement.repository,
          match: replacement.match,
          replacement: replacement.replacement,
          reason: replacement.reason,
          originalRequested,
          ...(replacement.artifactSha256 === undefined ? {} : { artifactSha256: replacement.artifactSha256 }),
          mechanism,
          fidelity
        })
      }
      return { applied, beforeInventory }
    },
    catch: (cause) => new ReplacementError({ repository: "unknown", message: cause instanceof Error ? cause.message : String(cause) })
  }),
  finalize: (lock, workspace, preparation) => Effect.tryPromise({
    try: async () => {
      const inventory: DependencyInventoryEntry[] = []
      for (const repository of lock.repositories) inventory.push(...await readInventory(repoRoot(lock, workspace, repository.name), repository.name))
      const replacements: AppliedReplacement[] = []
      for (const [index, replacement] of lock.replacements.entries()) {
        const prepared = preparation.applied[index]
        if (prepared === undefined) throw new Error("replacement preparation mismatch")
        const root = repoRoot(lock, workspace, replacement.repository)
        replacements.push({ ...prepared, finalResolution: await installedResolution(root, replacement) })
      }
      for (const repository of lock.repositories) {
        const before = preparation.beforeInventory[repository.name] ?? []
        const after = inventory.filter((entry) => entry.repository === repository.name)
        const repositoryReplacements = lock.replacements.filter((item) => item.repository === repository.name)
        const declared = new Set(repositoryReplacements.map((item) => `node_modules/${item.match.package}`))
        for (const item of repositoryReplacements) {
          if (item.replacement.kind !== "workspace") continue
          const target = repoRoot(lock, workspace, item.replacement.repository)
          declared.add(path.relative(repoRoot(lock, workspace, repository.name), target).split(path.sep).join("/"))
        }
        const beforeMap = new Map(before.map((item) => [item.location, `${item.name}@${item.version}:${item.integrity ?? ""}`]))
        const afterMap = new Map(after.map((item) => [item.location, `${item.name}@${item.version}:${item.integrity ?? ""}`]))
        for (const item of after) {
          const old = beforeMap.get(item.location)
          const current = `${item.name}@${item.version}:${item.integrity ?? ""}`
          if (old !== current && !declared.has(item.location)) {
            throw new Error(`undeclared resolution drift in ${repository.name}: ${item.location} changed from ${old ?? "missing"} to ${current}`)
          }
        }
        for (const item of before) if (!afterMap.has(item.location) && !declared.has(item.location)) {
          throw new Error(`undeclared resolution drift in ${repository.name}: ${item.location} was removed`)
        }
      }
      return { replacements, inventory }
    },
    catch: (cause) => new ReplacementError({ repository: "unknown", message: cause instanceof Error ? cause.message : String(cause) })
  })
} satisfies DependencyAdapterService)
