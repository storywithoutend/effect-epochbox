import { Effect, Layer } from "effect"
import path from "node:path"
import { BackendError, SecurityCapabilityError } from "../errors.js"
import type { BackendCommandResult, BackendHandle, SandboxBackendService, SealedWorkspace } from "./backend.js"
import { SandboxBackend } from "./backend.js"
import { isProviderEgress, type CommandSpec, type ProviderService } from "../schema.js"
import { resolveInside } from "../util/path.js"
import { runProcess } from "../util/process.js"
import {
  credentialEnvironmentNames,
  hostCredentialEnvironmentNames,
  providerCredentialMarker
} from "../security.js"

let nextId = 0
export const activeFakeSandboxes = new Map<string, string>()

const unsetCredentialEnvironment = (): ReadonlyArray<string> =>
  [...new Set([...credentialEnvironmentNames, ...hostCredentialEnvironmentNames()])]

const execute = (
  handle: BackendHandle,
  command: CommandSpec,
  allowFailure: boolean,
  environment: Readonly<Record<string, string>> = command.env ?? {}
): Effect.Effect<BackendCommandResult, BackendError> => {
  const cwd = resolveInside(handle.workspaceRoot, command.cwd ?? ".")
  const executable = command.argv[0]
  if (executable === undefined) return Effect.fail(new BackendError({ operation: "exec", message: "empty argv" }))
  return runProcess(executable, command.argv.slice(1), {
    cwd,
    env: environment,
    allowFailure,
    unsetEnv: unsetCredentialEnvironment()
  }).pipe(
    Effect.map((result) => ({
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8")
    }))
  )
}

const providerIsAllowed = (handle: BackendHandle, provider: ProviderService): boolean =>
  handle.executeEgress.some((entry) => isProviderEgress(entry, provider))

export const FakeBackendLive = Layer.succeed(SandboxBackend, {
  create: (root, lock) => Effect.sync(() => {
    const handle = {
      id: `fake-${++nextId}`,
      kind: "fake" as const,
      workspaceRoot: root,
      executeEgress: lock.executeEgress
    }
    activeFakeSandboxes.set(handle.id, root)
    return handle
  }),
  exec: (handle, command, allowFailure = false) => execute(handle, command, allowFailure),
  execAgent: (handle, command, provider) => {
    if (!providerIsAllowed(handle, provider)) {
      return Effect.fail(new SecurityCapabilityError({
        capability: "locked provider egress",
        message: `provider ${provider} is not present in the locked execute egress list`
      }))
    }
    const marker = providerCredentialMarker(provider)
    return execute(handle, command, true, {
      ...(command.env ?? {}),
      ...(marker === undefined ? {} : { [marker.name]: marker.value })
    })
  },
  seal: (handle) => Effect.succeed({
    workspace: handle as SealedWorkspace,
    attestation: {
      backend: "fake",
      sandboxId: handle.id,
      provisionPublicEgressAllowed: true,
      provisionProcessesTerminated: true,
      temporaryCredentialsRemoved: true,
      providerEnvironmentScrubbed: true,
      providerCredentialsBrokered: false,
      sshAgentAbsent: true,
      secretMountEmpty: true,
      hostEnforcedDenyRule: "fake-backend-test-boundary",
      executeEgress: handle.executeEgress,
      allowedEgressPolicyChecksPassed: false,
      defaultDenyCanaryTargets: ["fake-canary.invalid:443"],
      unlistedHostnameCanaryTarget: "fake-canary.invalid:443",
      outboundCanaryTarget: "192.0.2.1:443",
      dnsCanaryDenied: false,
      outboundCanaryDenied: false,
      unlistedHostnameCanaryDenied: false,
      dockerSocketAbsent: true,
      privateNetworkDenyResources: []
    }
  }),
  destroy: (handle: BackendHandle) => Effect.sync(() => { activeFakeSandboxes.delete(handle.id) })
} satisfies SandboxBackendService)
