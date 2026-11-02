import path from "node:path"
import { Effect } from "effect"
import { promises as fs } from "node:fs"
import { CliAgentAdapter, HostProcessAgent, type AgentAdapter, type SandboxCapabilities } from "./agent.js"
import { AgentError, BackendError, IntegrityError } from "./errors.js"
import type { CaseLock } from "./lock.js"
import { PhaseMachine, type Phase } from "./phases.js"
import { DependencyAdapter } from "./services/dependency-adapter.js"
import { ImageResolver } from "./services/image-resolver.js"
import { SandboxBackend, type BackendHandle } from "./services/backend.js"
import { emitEvidence, type CollectedOutputEvidence, type CommandEvidence, type RepositoryEvidence } from "./evidence.js"
import { hashTree, hashTreeIdentity, readJson } from "./util/fs.js"
import { sha256 } from "./util/canonical.js"
import {
  assertNoEscapingSymlinks,
  materializeWorkspace,
  removeWorkspace,
  restoreWorkspaceCompatibilitySymlinks,
  type MaterializedWorkspace
} from "./workspace.js"
import { validateLock } from "./compiler.js"

export interface RunOptions {
  readonly failureInjectionPhase?: Exclude<Phase, "created" | "complete">
}

export interface RunResult {
  readonly lockId: string
  readonly evidenceDirectory: string
  readonly unauthorizedRepositories: ReadonlyArray<string>
  readonly agentPassed: boolean
  readonly testsPassed: boolean
  readonly phase: "complete"
}

const injectedFailure = (phase: Phase, options: RunOptions) =>
  options.failureInjectionPhase === phase
    ? Effect.fail(new IntegrityError({ message: `injected failure at ${phase}` }))
    : Effect.void

const repositoryCwd = (lock: CaseLock, name: string): string => {
  const repository = lock.repositories.find((candidate) => candidate.name === name)
  if (repository === undefined) throw new Error(`unknown repository ${name}`)
  return `repos/${repository.destination}`
}

const makeCapabilities = (lock: CaseLock, backend: typeof SandboxBackend.Service, sealed: import("./services/backend.js").SealedWorkspace): SandboxCapabilities => {
  const execute = (repository: string, argv: ReadonlyArray<string>, env?: Readonly<Record<string, string>>) =>
    backend.exec(sealed, { argv, cwd: repositoryCwd(lock, repository), ...(env === undefined ? {} : { env }) }, true).pipe(
      Effect.mapError((cause) => new AgentError({ message: cause.message, cause }))
    )
  const nodeFileScript = "const fs=require('fs'),p=require('path'),f=process.env.EPOCHBOX_FILE,c=Buffer.from(process.env.EPOCHBOX_CONTENT,'base64');if(!f||f.startsWith('/')||f.split('/').includes('..'))process.exit(64);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,c,{flag:process.env.EPOCHBOX_APPEND==='1'?'a':'w'})"
  return {
    repositoryPath: (repository) => `${sealed.workspaceRoot}/${repositoryCwd(lock, repository)}`,
    command: (repository, argv) => execute(repository, argv),
    agentCommand: (repository, argv, env, provider) => backend.execAgent(sealed, {
      argv,
      cwd: repositoryCwd(lock, repository),
      env
    }, provider).pipe(
      Effect.mapError((cause) => new AgentError({ message: cause.message, cause }))
    ),
    write: (repository, file, contents, append) => execute(repository, ["node", "-e", nodeFileScript], {
      EPOCHBOX_FILE: file,
      EPOCHBOX_CONTENT: Buffer.from(contents).toString("base64"),
      EPOCHBOX_APPEND: append ? "1" : "0"
    }),
    read: (repository, file) => execute(repository, ["node", "-e", "const fs=require('fs'),f=process.argv[1];if(!f||f.startsWith('/')||f.split('/').includes('..'))process.exit(64);process.stdout.write(fs.readFileSync(f))", file]),
    search: (repository, query) => execute(repository, ["grep", "-R", "-n", "-F", "--exclude-dir=.git", "--", query, "."])
  }
}

const initializeBaselines = (lock: CaseLock, backend: typeof SandboxBackend.Service, handle: BackendHandle) =>
  Effect.gen(function* () {
    for (const repository of lock.repositories) {
      const cwd = `repos/${repository.destination}`
      const env = {
        GIT_AUTHOR_NAME: "effect-epochbox",
        GIT_AUTHOR_EMAIL: "epochbox@invalid",
        GIT_COMMITTER_NAME: "effect-epochbox",
        GIT_COMMITTER_EMAIL: "epochbox@invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
      }
      yield* backend.exec(handle, { argv: ["git", "init", "-q"], cwd })
      yield* backend.exec(handle, { argv: ["git", "add", "-A"], cwd })
      yield* backend.exec(handle, { argv: ["git", "commit", "-q", "-m", "effect-epochbox synthetic baseline"], cwd, env })
      const remotes = yield* backend.exec(handle, { argv: ["git", "remote"], cwd })
      if (remotes.stdout.trim() !== "") return yield* new IntegrityError({ message: `synthetic baseline has remotes in ${repository.name}` })
    }
  })

const runCore = (
  lock: CaseLock,
  artifactDirectory: string,
  evidenceDirectory: string,
  workspace: MaterializedWorkspace,
  backend: typeof SandboxBackend.Service,
  handle: BackendHandle,
  dependencyAdapter: typeof DependencyAdapter.Service,
  agent: AgentAdapter,
  options: RunOptions
) => Effect.gen(function* () {
  const phases = new PhaseMachine()
  yield* phases.transition("materialize")
  yield* injectedFailure("materialize", options)
  yield* phases.transition("provision")
  yield* injectedFailure("provision", options)
  const preparation = yield* dependencyAdapter.prepare(lock, workspace)
  const provisioning: CommandEvidence[] = []
  for (const repository of lock.repositories) {
    for (const command of repository.provision) {
      const cwd = command.cwd === undefined ? `repos/${repository.destination}` : `repos/${repository.destination}/${command.cwd}`
      const result = yield* backend.exec(handle, { ...command, cwd })
      provisioning.push({ argv: command.argv, cwd, ...result })
    }
  }
  yield* phases.transition("seal")
  yield* injectedFailure("seal", options)
  const sealed = yield* backend.seal(handle, lock)
  yield* assertNoEscapingSymlinks(workspace.root)
  const dependencyResult = yield* dependencyAdapter.finalize(lock, workspace, preparation)
  yield* initializeBaselines(lock, backend, sealed.workspace)
  const sealedEntries = yield* hashTree(workspace.root, new Set(
    lock.repositories.map((repository) => `repos/${repository.destination}/.git`)
  ))
  const sealedWorkspaceSha256 = hashTreeIdentity(sealedEntries)
  yield* phases.transition("execute")
  yield* injectedFailure("execute", options)
  const transcript = yield* agent.execute(sealed.workspace, makeCapabilities(lock, backend, sealed.workspace), lock.agent)
  const workspaceSymlinks = yield* restoreWorkspaceCompatibilitySymlinks(workspace)
  yield* phases.transition("collect")
  yield* injectedFailure("collect", options)
  const repositories: RepositoryEvidence[] = []
  for (const repository of lock.repositories) {
    const cwd = `repos/${repository.destination}`
    yield* backend.exec(sealed.workspace, { argv: ["git", "add", "-N", "--all"], cwd })
    const statusResult = yield* backend.exec(sealed.workspace, { argv: ["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd })
    const patchResult = yield* backend.exec(sealed.workspace, { argv: ["git", "diff", "--binary", "--no-ext-diff", "HEAD", "--"], cwd })
    const status = statusResult.stdout.split("\n").filter(Boolean)
    repositories.push({
      name: repository.name,
      destination: repository.destination,
      status,
      patch: patchResult.stdout,
      changed: status.length > 0,
      authorized: lock.allowChanges.includes(repository.name)
    })
  }
  const outputs: CollectedOutputEvidence[] = []
  const collectScript = "const fs=require('fs'),p=require('path'),f=process.argv[1];if(!f||f.startsWith('/')||f.split('/').includes('..'))process.exit(64);let current=process.cwd();for(const part of f.split('/')){current=p.join(current,part);try{const s=fs.lstatSync(current);if(s.isSymbolicLink())process.exit(65)}catch(e){if(e&&e.code==='ENOENT')process.exit(44);throw e}}const stat=fs.statSync(current);if(!stat.isFile())process.exit(66);process.stdout.write(fs.readFileSync(current).toString('base64'))"
  for (const output of lock.collect) {
    const result = yield* backend.exec(sealed.workspace, {
      argv: ["node", "-e", collectScript, output.path],
      cwd: repositoryCwd(lock, output.repository)
    }, true)
    if (result.exitCode === 44) {
      outputs.push({ repository: output.repository, path: output.path, exists: false })
      continue
    }
    if (result.exitCode !== 0) {
      return yield* new IntegrityError({ message: `could not collect ${output.repository}/${output.path}: ${result.stderr}`, path: output.path })
    }
    const bytes = Buffer.from(result.stdout, "base64")
    outputs.push({
      repository: output.repository,
      path: output.path,
      exists: true,
      sha256: sha256(bytes),
      size: bytes.length,
      contentBase64: result.stdout
    })
  }
  yield* phases.transition("verify")
  yield* injectedFailure("verify", options)
  const tests: CommandEvidence[] = []
  for (const command of lock.verify) {
    const result = yield* backend.exec(sealed.workspace, command, true)
    tests.push({ argv: command.argv, ...(command.cwd === undefined ? {} : { cwd: command.cwd }), ...result })
  }
  yield* emitEvidence(evidenceDirectory, {
    lock,
    artifactDirectory,
    replacements: dependencyResult.replacements,
    inventory: dependencyResult.inventory,
    provisioning,
    attestation: { ...sealed.attestation, sealedWorkspaceSha256 },
    transcript,
    workspaceSymlinks,
    repositories,
    outputs,
    tests
  })
  yield* phases.transition("complete")
  return {
    lockId: lock.lockId,
    evidenceDirectory,
    unauthorizedRepositories: repositories.filter((repository) => repository.changed && !repository.authorized).map((repository) => repository.name),
    agentPassed: transcript.every((entry) => entry.exitCode === 0),
    testsPassed: tests.every((test) => test.exitCode === 0),
    phase: "complete" as const
  }
})

export const runLockedCase = (
  lock: CaseLock,
  artifactDirectory: string,
  evidenceDirectory: string,
  agent: AgentAdapter,
  options: RunOptions = {}
): Effect.Effect<RunResult, unknown, SandboxBackend | DependencyAdapter | ImageResolver> =>
  Effect.gen(function* () {
    const backend = yield* SandboxBackend
    const dependencyAdapter = yield* DependencyAdapter
    const imageResolver = yield* ImageResolver
    yield* imageResolver.assertCurrent(lock.image.reference, lock.image.identity)
    return yield* Effect.acquireUseRelease(
      materializeWorkspace(lock, artifactDirectory),
      (workspace) => Effect.acquireUseRelease(
        backend.create(workspace.root, lock),
        (handle) => runCore(lock, artifactDirectory, evidenceDirectory, workspace, backend, handle, dependencyAdapter, agent, options),
        (handle) => backend.destroy(handle)
      ),
      (workspace) => removeWorkspace(workspace)
    )
  })

export const runLockFile = (
  lockPath: string,
  evidenceDirectory: string,
  agent?: AgentAdapter,
  options: RunOptions = {}
) => Effect.gen(function* () {
  const unknown = yield* readJson(lockPath)
  const lock = yield* validateLock(unknown)
  const selectedAgent = agent ?? (lock.agent.adapter === "cli" ? CliAgentAdapter : HostProcessAgent)
  return yield* runLockedCase(lock, `${lockPath}.artifacts`, evidenceDirectory, selectedAgent, options)
})
