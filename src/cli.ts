#!/usr/bin/env node
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { compileCaseFile } from "./compiler.js"
import { verifyEvidence } from "./evidence.js"
import { runLockFile } from "./runner.js"
import { NpmDependencyAdapterLive } from "./services/dependency-adapter.js"
import { FakeBackendLive } from "./services/fake-backend.js"
import { GitSourceLive } from "./services/git-source.js"
import { ImageResolverFixed, ImageResolverSbx } from "./services/image-resolver.js"
import { SbxBackendLive } from "./services/sbx-backend.js"
import { canonicalJson } from "./util/canonical.js"

const usage = `effect-epochbox 0.1.0

Usage:
  effect-epochbox lock <case.json> --out <case.lock.json> [--backend sbx|fake]
  effect-epochbox run <case.lock.json> --evidence <directory> [--backend sbx|fake]
  effect-epochbox verify <evidence-directory>
`

const option = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const program = (args: ReadonlyArray<string>) => {
  const [command, input] = args
  if (command === "lock" && input !== undefined) {
    const output = option(args, "--out")
    if (output === undefined) return Effect.fail(new Error("--out is required"))
    const backendName = option(args, "--backend") ?? "sbx"
    if (backendName !== "sbx" && backendName !== "fake") return Effect.fail(new Error("--backend must be sbx or fake"))
    return compileCaseFile(input, output).pipe(
      Effect.provide(Layer.merge(GitSourceLive, backendName === "sbx" ? ImageResolverSbx : ImageResolverFixed())),
      Effect.map((lock) => ({ command: "lock", backend: backendName, lockId: lock.lockId, output, artifacts: `${output}.artifacts` }))
    )
  }
  if (command === "run" && input !== undefined) {
    const evidence = option(args, "--evidence")
    if (evidence === undefined) return Effect.fail(new Error("--evidence is required"))
    const backendName = option(args, "--backend") ?? "sbx"
    if (backendName !== "sbx" && backendName !== "fake") return Effect.fail(new Error("--backend must be sbx or fake"))
    const layer = Layer.mergeAll(
      backendName === "sbx" ? SbxBackendLive : FakeBackendLive,
      NpmDependencyAdapterLive,
      backendName === "sbx" ? ImageResolverSbx : ImageResolverFixed()
    )
    return runLockFile(input, evidence).pipe(
      Effect.provide(layer),
      Effect.map((result) => ({
        command: "run",
        ...result,
        passed: result.agentPassed && result.testsPassed && result.unauthorizedRepositories.length === 0
      }))
    )
  }
  if (command === "verify" && input !== undefined) {
    return verifyEvidence(input).pipe(Effect.map((report) => ({ command: "verify", ...report })))
  }
  return Effect.fail(new Error(usage))
}

Effect.runPromiseExit(program(process.argv.slice(2)) as Effect.Effect<Record<string, unknown>, unknown, never>).then((exit) => {
  if (Exit.isSuccess(exit)) {
    const result = exit.value
    process.stdout.write(canonicalJson(result))
    if (("passed" in result && result.passed === false) || ("valid" in result && result.valid === false)) process.exitCode = 2
    return
  }
  const failure = Cause.failureOption(exit.cause)
  const error = Option.isSome(failure) ? failure.value as { _tag?: string; message?: string } : undefined
  process.stderr.write(canonicalJson({ error: Option.isSome(failure) ? error?._tag ?? "Error" : "Defect", message: error?.message ?? Cause.pretty(exit.cause) }))
  process.exitCode = 1
})
