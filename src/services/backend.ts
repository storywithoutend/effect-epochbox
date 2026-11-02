import { Context, Effect } from "effect"
import type { CaseLock } from "../lock.js"
import type { CommandSpec, ExecuteEgress, ProviderService } from "../schema.js"
import type { SubscriptionEgressProxyHandle } from "./subscription-egress.js"
import type { BackendError, SecurityCapabilityError } from "../errors.js"

export interface BackendHandle {
  readonly id: string
  readonly kind: "fake" | "sbx"
  readonly workspaceRoot: string
  readonly executeEgress: ReadonlyArray<ExecuteEgress>
  readonly subscriptionProxy?: SubscriptionEgressProxyHandle
}

declare const sealedWorkspaceBrand: unique symbol
export interface SealedWorkspace extends BackendHandle {
  readonly [sealedWorkspaceBrand]: true
}

export interface BackendCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CredentialProxyAttestation {
  readonly provider: "openai-codex" | "xai"
  readonly endpoint: string
  readonly policyEndpoint: string
  readonly upstreamHosts: ReadonlyArray<string>
  readonly credentialSource: "host-pi-auth"
  readonly headerNames: ReadonlyArray<string>
  readonly refresh: "per-request-host-refresh"
  readonly sandboxCredentialMaterial: "placeholder-only"
  readonly adjacentHostPortsDenied: boolean
}

export interface SealAttestation {
  readonly backend: "fake" | "sbx"
  readonly sandboxId: string
  readonly provisionPublicEgressAllowed: boolean
  readonly provisionProcessesTerminated: boolean
  readonly temporaryCredentialsRemoved: boolean
  readonly providerEnvironmentScrubbed: boolean
  readonly providerCredentialsBrokered: boolean
  readonly sshAgentAbsent: boolean
  readonly secretMountEmpty: boolean
  readonly hostEnforcedDenyRule: string
  readonly executeEgress: ReadonlyArray<ExecuteEgress>
  readonly allowedEgressPolicyChecksPassed: boolean
  readonly defaultDenyCanaryTargets: ReadonlyArray<string>
  readonly unlistedHostnameCanaryTarget: string
  readonly outboundCanaryTarget: string
  readonly dnsCanaryDenied: boolean
  readonly outboundCanaryDenied: boolean
  readonly unlistedHostnameCanaryDenied: boolean
  readonly dockerSocketAbsent: boolean
  readonly privateNetworkDenyResources: ReadonlyArray<string>
  readonly credentialProxy?: CredentialProxyAttestation
}

export interface SandboxBackendService {
  readonly create: (root: string, lock: CaseLock) => Effect.Effect<BackendHandle, BackendError | SecurityCapabilityError>
  readonly exec: (handle: BackendHandle, command: CommandSpec, allowFailure?: boolean) => Effect.Effect<BackendCommandResult, BackendError>
  readonly execAgent: (
    handle: SealedWorkspace,
    command: CommandSpec,
    provider: ProviderService
  ) => Effect.Effect<BackendCommandResult, BackendError | SecurityCapabilityError>
  readonly seal: (handle: BackendHandle, lock: CaseLock) => Effect.Effect<{ readonly workspace: SealedWorkspace; readonly attestation: SealAttestation }, BackendError | SecurityCapabilityError>
  readonly destroy: (handle: BackendHandle) => Effect.Effect<void, never>
}

export class SandboxBackend extends Context.Tag("effect-epochbox/SandboxBackend")<SandboxBackend, SandboxBackendService>() {}
