import { spawn } from "node:child_process"
import { Effect } from "effect"
import { BackendError } from "../errors.js"

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export interface RunProcessOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: Uint8Array
  readonly allowFailure?: boolean
  readonly unsetEnv?: ReadonlyArray<string>
}

export const runProcess = (
  executable: string,
  args: ReadonlyArray<string>,
  options: RunProcessOptions = {}
): Effect.Effect<ProcessResult, BackendError> =>
  Effect.tryPromise({
    try: (signal) => new Promise<ProcessResult>((resolve, reject) => {
      const environment = { ...process.env }
      for (const name of options.unsetEnv ?? []) delete environment[name]
      for (const [name, value] of Object.entries(options.env ?? {})) environment[name] = value
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"]
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.on("error", reject)
      child.on("close", (code) => {
        const result = { exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
        if (result.exitCode !== 0 && !options.allowFailure) {
          reject(new Error(`${executable} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.toString("utf8")}${result.stdout.toString("utf8")}`))
        } else resolve(result)
      })
      signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true })
      if (options.stdin === undefined) child.stdin.end()
      else child.stdin.end(options.stdin)
    }),
    catch: (cause) => new BackendError({ operation: executable, message: cause instanceof Error ? cause.message : String(cause), cause })
  })

export const stdoutText = (result: ProcessResult): string => result.stdout.toString("utf8")
