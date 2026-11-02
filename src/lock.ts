import type {
  AgentRecipe,
  CollectedOutput,
  CommandSpec,
  DependencyReplacement,
  ExecuteEgress
} from "./schema.js"

export interface LockedRepository {
  readonly name: string
  readonly source: string
  readonly commit: string
  readonly tree: string
  readonly destination: string
  readonly archivePath: string
  readonly archiveSha256: string
  readonly archiveSize: number
  readonly provision: ReadonlyArray<CommandSpec>
}

export interface LockedReplacement extends DependencyReplacement {
  readonly artifactPath?: string
  readonly artifactSha256?: string
}

export interface CaseLockBody {
  readonly formatVersion: 2
  readonly caseName: string
  readonly image: { readonly reference: string; readonly identity: string }
  readonly repositories: ReadonlyArray<LockedRepository>
  readonly replacements: ReadonlyArray<LockedReplacement>
  readonly allowChanges: ReadonlyArray<string>
  readonly executeEgress: ReadonlyArray<ExecuteEgress>
  readonly collect: ReadonlyArray<CollectedOutput>
  readonly agent: AgentRecipe
  readonly verify: ReadonlyArray<CommandSpec>
}

export interface CaseLock extends CaseLockBody {
  readonly lockId: string
}
