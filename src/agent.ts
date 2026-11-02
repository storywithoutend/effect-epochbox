import { Effect } from "effect"
import {
  createInvocationPlan,
  normalizeUsage,
  probeInstalledAgentsWith,
  selectAgent,
  type AgentSelection,
  type NormalizedUsage,
  type ProbeCommandResult
} from "effect-agent-bind"
import type { AgentAction, AgentRecipe, ProviderService } from "./schema.js"
import { AgentError } from "./errors.js"
import type { BackendCommandResult, SealedWorkspace } from "./services/backend.js"

export interface HostProcessTranscriptEntry {
  readonly kind: "action"
  readonly sequence: number
  readonly action: AgentAction
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CliAgentTranscriptEntry {
  readonly kind: "cli"
  readonly sequence: number
  readonly agentId: string
  readonly provider: ProviderService
  readonly model: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly permissionMode: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly usage: NormalizedUsage
}

export type AgentTranscriptEntry = HostProcessTranscriptEntry | CliAgentTranscriptEntry

export interface SandboxCapabilities {
  readonly repositoryPath: (repository: string) => string
  readonly command: (repository: string, argv: ReadonlyArray<string>) => Effect.Effect<BackendCommandResult, AgentError>
  readonly agentCommand: (
    repository: string,
    argv: ReadonlyArray<string>,
    env: Readonly<Record<string, string>>,
    provider: ProviderService
  ) => Effect.Effect<BackendCommandResult, AgentError>
  readonly write: (repository: string, file: string, contents: string, append: boolean) => Effect.Effect<BackendCommandResult, AgentError>
  readonly read: (repository: string, file: string) => Effect.Effect<BackendCommandResult, AgentError>
  readonly search: (repository: string, query: string) => Effect.Effect<BackendCommandResult, AgentError>
}

export interface AgentAdapter {
  readonly name: string
  readonly execute: (
    workspace: SealedWorkspace,
    capabilities: SandboxCapabilities,
    agent: AgentRecipe
  ) => Effect.Effect<ReadonlyArray<AgentTranscriptEntry>, AgentError>
}

const adapterMismatch = (expected: string, actual: string): AgentError =>
  new AgentError({ message: `${expected} adapter cannot execute ${actual} agent recipe` })

export const HostProcessAgent: AgentAdapter = {
  name: "host-process",
  execute: (_workspace, capabilities, agent) => Effect.gen(function* () {
    if (agent.adapter !== "host-process") return yield* adapterMismatch("host-process", agent.adapter)
    const transcript: HostProcessTranscriptEntry[] = []
    for (const [sequence, action] of agent.actions.entries()) {
      const result = yield* (() => {
        switch (action.kind) {
          case "command": return capabilities.command(action.repository, action.argv)
          case "write": return capabilities.write(action.repository, action.path, action.content, false)
          case "append": return capabilities.write(action.repository, action.path, action.content, true)
          case "read": return capabilities.read(action.repository, action.path)
          case "search": return capabilities.search(action.repository, action.query)
        }
      })().pipe(Effect.mapError((cause) => new AgentError({ message: cause.message, action: sequence, cause })))
      transcript.push({ kind: "action", sequence, action, ...result })
    }
    return transcript
  })
}

const locateBinaryScript = `const fs=require('fs'),p=require('path');
const name=process.argv[1],extra=JSON.parse(process.argv[2]);
const dirs=[...extra,...(process.env.PATH||'').split(p.delimiter)].filter(Boolean);
for(const dir of dirs){const candidate=p.resolve(dir,name);try{fs.accessSync(candidate,fs.constants.X_OK);process.stdout.write(fs.realpathSync(candidate)+'\\n');process.exit(0)}catch{}}
process.exit(1)`

const probeResult = (result: BackendCommandResult): ProbeCommandResult => ({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr
})

export const CliAgentAdapter: AgentAdapter = {
  name: "cli",
  execute: (_workspace, capabilities, agent) => Effect.gen(function* () {
    if (agent.adapter !== "cli") return yield* adapterMismatch("cli", agent.adapter)
    const repositoryPath = capabilities.repositoryPath(agent.repository)
    const extraPaths = (agent.path ?? []).map((entry) => `${repositoryPath}/${entry}`)
    const prepared = yield* Effect.tryPromise({
      try: async () => {
        const installed = await probeInstalledAgentsWith(async (input) => {
          const result = input.command === "which"
            ? await Effect.runPromise(capabilities.command(agent.repository, [
              "node",
              "-e",
              locateBinaryScript,
              input.args[0] ?? "",
              JSON.stringify(extraPaths)
            ]))
            : await Effect.runPromise(capabilities.command(agent.repository, [input.command, ...input.args]))
          return probeResult(result)
        })
        const selection: AgentSelection = agent.selection.kind === "explicit"
          ? { kind: "explicit", id: agent.selection.id }
          : agent.selection.preference === undefined
            ? { kind: "auto" }
            : { kind: "auto", preference: agent.selection.preference }
        const resolved = selectAgent(selection, installed)
        return createInvocationPlan(resolved, {
          prompt: agent.prompt,
          cwd: repositoryPath,
          env: { NO_COLOR: "1" },
          ...(agent.model === undefined ? {} : { model: agent.model }),
          provider: agent.provider,
          timeoutMs: 5 * 60 * 1_000,
          session: "ephemeral",
          userConfig: "auth-only",
          permissionMode: "unattended",
          tools: agent.tools ?? "full"
        })
      },
      catch: (cause) => new AgentError({ message: cause instanceof Error ? cause.message : String(cause), cause })
    })
    const started = Date.now()
    const result = yield* capabilities.agentCommand(
      agent.repository,
      [prepared.command, ...prepared.args],
      prepared.env,
      agent.provider
    )
    const usage = normalizeUsage(prepared.agentId, result.stdout, (Date.now() - started) / 1_000)
    return [{
      kind: "cli" as const,
      sequence: 0,
      agentId: prepared.agentId,
      provider: agent.provider,
      model: prepared.model,
      command: prepared.command,
      args: prepared.args,
      permissionMode: prepared.permissionMode,
      ...result,
      usage
    }]
  })
}
