import { Effect, Exit, Layer } from "effect"
import { BackendError, SecurityCapabilityError } from "../errors.js"
import type { CaseLock } from "../lock.js"
import {
  isCredentialProxyEgress,
  isProviderEgress,
  providerEndpoint,
  type CommandSpec,
  type ProviderService
} from "../schema.js"
import { runProcess, stdoutText } from "../util/process.js"
import type { BackendCommandResult, BackendHandle, SandboxBackendService, SealedWorkspace } from "./backend.js"
import { SandboxBackend } from "./backend.js"
import {
  isSubscriptionProvider,
  startSubscriptionEgressProxy,
  subscriptionSandboxConfiguration,
  type SubscriptionEgressProxyHandle
} from "./subscription-egress.js"
import {
  credentialEnvironmentNames,
  hostCredentialEnvironmentNames,
  isSensitiveEnvironmentName,
  providerCredentialMarker
} from "../security.js"

const privateDenyResources = [
  "localhost",
  "*.localhost",
  "*.local",
  "host.docker.internal",
  "gateway.docker.internal",
  "127.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "169.254.169.254",
  "metadata.google.internal"
] as const

const defaultDenyCanaryTargets = [
  "example.com:443",
  "example.net:443",
  "www.cloudflare.com:443",
  "registry.npmjs.org:443",
  "github.com:443",
  "pypi.org:443"
] as const

const provisioningProviderDenyResources = [
  "api.openai.com",
  "api.anthropic.com",
  "chatgpt.com",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
  "api.mistral.ai",
  "api.x.ai",
  "api.studio.nebius.ai"
] as const

const sbx = (args: ReadonlyArray<string>, allowFailure = false) =>
  runProcess("sbx", args, { allowFailure, unsetEnv: hostCredentialEnvironmentNames() }).pipe(
    Effect.mapError((cause) => new BackendError({ operation: `sbx ${args[0] ?? ""}`, message: cause.message, cause }))
  )

const commandArgs = (
  handle: BackendHandle,
  command: CommandSpec,
  preservedCredentialNames: ReadonlyArray<string> = []
): string[] => {
  const args = ["exec"]
  if (command.cwd !== undefined) args.push("--workdir", `${handle.workspaceRoot}/${command.cwd}`)
  for (const [name, value] of Object.entries(command.env ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    args.push("--env", `${name}=${value}`)
  }
  args.push(handle.id, "/usr/bin/env")
  const preserved = new Set(preservedCredentialNames)
  for (const name of credentialEnvironmentNames) {
    if (!preserved.has(name)) args.push("-u", name)
  }
  args.push(...command.argv)
  return args
}

const exec = (handle: BackendHandle, command: CommandSpec, allowFailure = false): Effect.Effect<BackendCommandResult, BackendError> =>
  sbx(commandArgs(handle, command), allowFailure).pipe(
    Effect.map((result) => ({ exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") }))
  )

const addDeny = (sandboxId: string, resources: ReadonlyArray<string>) =>
  resources.length === 0
    ? Effect.void
    : sbx(["policy", "deny", "network", "--sandbox", sandboxId, resources.join(",")]).pipe(
      Effect.mapError((cause) => new SecurityCapabilityError({
        capability: "sandbox-scoped network deny",
        message: `could not install the required deny policy (${resources.join(",")}): ${cause.message}`
      }))
    )

const addAllow = (sandboxId: string, resources: ReadonlyArray<string>) =>
  resources.length === 0
    ? Effect.void
    : sbx(["policy", "allow", "network", "--sandbox", sandboxId, resources.join(",")]).pipe(
      Effect.mapError((cause) => new SecurityCapabilityError({
        capability: "sandbox-scoped exact network allow",
        message: `could not permit the locked egress targets (${resources.join(",")}): ${cause.message}`
      }))
    )

const removePolicyResource = (sandboxId: string, resource: string) =>
  sbx(["policy", "rm", "network", "--sandbox", sandboxId, "--resource", resource]).pipe(
    Effect.mapError((cause) => new SecurityCapabilityError({
      capability: "atomic provisioning-to-execute network transition",
      message: `could not remove the provisioning policy for ${resource}: ${cause.message}`
    }))
  )

const hardenCredentialSurfaces = (sandboxId: string) =>
  sbx([
    "exec", "--user", "root", sandboxId, "sh", "-c",
    "rm -f /run/ssh-agent.sock /etc/sandbox-persistent.sh /home/agent/.npmrc /home/agent/.yarnrc /home/agent/.yarnrc.yml /home/agent/.netrc; test ! -e /run/ssh-agent.sock; test ! -e /var/run/docker.sock; test ! -e /run/docker.sock; test -z \"$(find /run/secrets -mindepth 1 -maxdepth 2 -print -quit 2>/dev/null)\""
  ]).pipe(
    Effect.mapError((cause) => new SecurityCapabilityError({
      capability: "credential-free sandbox surface",
      message: `could not remove the SSH agent or prove the secret mount empty: ${cause.message}`
    }))
  )

const policyDecision = (result: { readonly exitCode: number; readonly stdout: Buffer; readonly stderr: Buffer }): "allow" | "deny" | "unknown" => {
  const text = stdoutText(result)
  if (/"decision"\s*:\s*"allow"|"allowed"\s*:\s*true/i.test(text)) return "allow"
  if (/"decision"\s*:\s*"deny"|"allowed"\s*:\s*false/i.test(text) || result.exitCode !== 0) return "deny"
  return "unknown"
}

const checkPolicyDenied = (sandboxId: string, target: string) =>
  sbx(["policy", "check", "network", "--sandbox", sandboxId, "--json", target], true).pipe(
    Effect.flatMap((result) => policyDecision(result) === "deny"
      ? Effect.succeed(true)
      : Effect.fail(new SecurityCapabilityError({ capability: "host-enforced network denial", message: `policy check did not deny ${target}: ${stdoutText(result)}` })))
  )

const checkPolicyAllowed = (sandboxId: string, target: string) =>
  sbx(["policy", "check", "network", "--sandbox", sandboxId, "--json", target], true).pipe(
    Effect.flatMap((result) => policyDecision(result) === "allow"
      ? Effect.succeed(true)
      : Effect.fail(new SecurityCapabilityError({ capability: "host-enforced exact network allow", message: `policy check did not allow ${target}: ${stdoutText(result)}` })))
  )

const uniqueSandboxName = (lock: CaseLock): string =>
  `epochbox-${lock.lockId.slice(0, 10)}-${process.pid}-${Date.now().toString(36)}`.slice(0, 63)

const providerIsAllowed = (handle: BackendHandle, provider: ProviderService): boolean =>
  handle.executeEgress.some((entry) => isProviderEgress(entry, provider))

const closeSubscriptionProxy = (handle: BackendHandle): Effect.Effect<void, never> => {
  const proxy = handle.subscriptionProxy
  return proxy === undefined
    ? Effect.void
    : Effect.tryPromise({
      try: () => proxy.close(),
      catch: () => undefined
    }).pipe(Effect.asVoid, Effect.ignore)
}

const prepareSubscriptionAgent = (
  handle: BackendHandle,
  command: CommandSpec,
  provider: ProviderService
): Effect.Effect<{ readonly command: CommandSpec; readonly preservedCredentialNames?: ReadonlyArray<string> }, BackendError | SecurityCapabilityError> =>
  Effect.gen(function* () {
    if (!isSubscriptionProvider(provider)) {
      const marker = providerCredentialMarker(provider)
      if (marker === undefined) return { command }
      return {
        command: { ...command, env: { ...(command.env ?? {}), [marker.name]: marker.value } },
        preservedCredentialNames: [marker.name]
      }
    }
    const proxy = handle.subscriptionProxy
    if (proxy === undefined || proxy.provider !== provider) {
      return yield* new SecurityCapabilityError({
        capability: "host subscription credential proxy",
        message: `provider ${provider} has no matching host credential proxy`
      })
    }
    const configuration = subscriptionSandboxConfiguration(provider, proxy.endpoint)
    const agentDirectory = `${handle.workspaceRoot}/.epochbox-agent/pi`
    const writeConfiguration = yield* exec(handle, {
      argv: [
        "node",
        "-e",
        "const fs=require('fs'),p=require('path'),d=process.argv[1];fs.mkdirSync(d,{recursive:true,mode:0o700});for(const [name,value] of [['settings.json',process.argv[2]],['models.json',process.argv[3]],['auth.json',process.argv[4]]])fs.writeFileSync(p.join(d,name),Buffer.from(value,'base64'),{mode:0o600})",
        agentDirectory,
        Buffer.from(JSON.stringify(configuration.settings)).toString("base64"),
        Buffer.from(JSON.stringify(configuration.models)).toString("base64"),
        Buffer.from(JSON.stringify(configuration.auth)).toString("base64")
      ]
    }, true)
    if (writeConfiguration.exitCode !== 0) {
      return yield* new SecurityCapabilityError({
        capability: "credential-free sandbox agent configuration",
        message: "could not install the proxy-only agent configuration"
      })
    }
    const marker = providerCredentialMarker(provider)
    const environment = {
      ...(command.env ?? {}),
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_SKIP_VERSION_CHECK: "1",
      ...configuration.environment,
      ...(marker === undefined ? {} : { [marker.name]: marker.value })
    }
    return {
      command: { ...command, env: environment },
      ...(marker === undefined ? {} : {
        preservedCredentialNames: provider === "xai" ? [marker.name, "XAI_API_KEY"] : [marker.name]
      })
    }
  })

const policyTarget = (entry: CaseLock["executeEgress"][number]): string =>
  isCredentialProxyEgress(entry) ? `localhost:${entry.port}` : `${entry.host}:${entry.port}`

const chooseUnlistedHostname = (lock: CaseLock): string => {
  const allowed = new Set(lock.executeEgress.map((entry) => entry.host))
  return ["example.com", "example.net", "www.iana.org", "www.cloudflare.com"]
    .find((host) => !allowed.has(host)) ?? `epochbox-${lock.lockId.slice(0, 12)}.example.com`
}

export const SbxBackendLive = Layer.succeed(SandboxBackend, {
  create: (root, lock) => {
    const id = uniqueSandboxName(lock)
    const startProxy: Effect.Effect<SubscriptionEgressProxyHandle | undefined, SecurityCapabilityError> = Effect.gen(function* () {
      const agent = lock.agent
      if (agent.adapter !== "cli" || !isSubscriptionProvider(agent.provider)) return undefined
      const provider = agent.provider
      return yield* Effect.tryPromise({
        try: () => startSubscriptionEgressProxy(provider, providerEndpoint(provider).port),
        catch: (cause) => new SecurityCapabilityError({
          capability: "host subscription credential proxy",
          message: cause instanceof Error ? cause.message : String(cause)
        })
      })
    })
    return startProxy.pipe(Effect.flatMap((subscriptionProxy) => {
      const handle: BackendHandle = {
        id,
        kind: "sbx",
        workspaceRoot: root,
        executeEgress: lock.executeEgress,
        ...(subscriptionProxy === undefined ? {} : { subscriptionProxy })
      }
      const setup = Effect.gen(function* () {
        yield* sbx(["create", "shell", "--quiet", "--name", id, "--template", lock.image.reference, root])
        for (const target of defaultDenyCanaryTargets) yield* checkPolicyDenied(id, target)
        yield* addAllow(id, ["**"])
        yield* addDeny(id, privateDenyResources)
        yield* addDeny(id, provisioningProviderDenyResources)
        for (const target of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.0.1", "host.docker.internal", "metadata.google.internal", "api.openai.com"]) {
          yield* checkPolicyDenied(id, target)
        }
        yield* hardenCredentialSurfaces(id)
        return handle
      })
      return setup.pipe(Effect.onExit((exit) => Exit.isFailure(exit)
        ? Effect.all([
          sbx(["rm", "--force", id], true).pipe(Effect.ignore),
          closeSubscriptionProxy(handle)
        ]).pipe(Effect.asVoid)
        : Effect.void))
    }))
  },
  exec,
  execAgent: (handle, command, provider) => Effect.gen(function* () {
    if (!providerIsAllowed(handle, provider)) {
      return yield* new SecurityCapabilityError({
        capability: "locked provider egress",
        message: `provider ${provider} is not present in the locked execute egress list`
      })
    }
    const sensitive = Object.keys(command.env ?? {}).find(isSensitiveEnvironmentName)
    if (sensitive !== undefined) {
      return yield* new SecurityCapabilityError({
        capability: "host-side provider credential broker",
        message: `agent command attempted to supply sensitive environment variable ${sensitive}`
      })
    }
    const prepared = yield* prepareSubscriptionAgent(handle, command, provider)
    const run = sbx(commandArgs(handle, prepared.command, prepared.preservedCredentialNames), true).pipe(
      Effect.map((result) => ({
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8")
      }))
    )
    if (!isSubscriptionProvider(provider)) return yield* run
    return yield* run.pipe(Effect.ensuring(exec(handle, {
      argv: ["rm", "-rf", `${handle.workspaceRoot}/.epochbox-agent`]
    }, true).pipe(Effect.ignore)))
  }),
  seal: (handle, lock) => Effect.gen(function* () {
    const cleanup = yield* exec(handle, {
      argv: ["sh", "-c", "rm -f \"$HOME/.npmrc\" \"$HOME/.yarnrc\" \"$HOME/.yarnrc.yml\" \"$HOME/.netrc\"; test ! -e /var/run/docker.sock && test ! -e /run/docker.sock"]
    }, true)
    if (cleanup.exitCode !== 0) {
      return yield* new SecurityCapabilityError({ capability: "credential and Docker socket cleanup", message: cleanup.stderr || "Docker socket is present" })
    }
    yield* sbx(["stop", handle.id])
    yield* removePolicyResource(handle.id, "**")
    for (const entry of lock.executeEgress) {
      if (isCredentialProxyEgress(entry)) {
        yield* removePolicyResource(handle.id, "localhost")
      } else if (provisioningProviderDenyResources.includes(entry.host as typeof provisioningProviderDenyResources[number])) {
        yield* removePolicyResource(handle.id, entry.host)
      }
    }
    const allowedTargets = lock.executeEgress.map(policyTarget)
    yield* addAllow(handle.id, allowedTargets)
    yield* hardenCredentialSurfaces(handle.id)
    for (const target of allowedTargets) yield* checkPolicyAllowed(handle.id, target)
    for (const target of ["127.0.0.1:443", "10.0.0.1:443", "169.254.169.254:80", "localhost:443", "localhost:43118", "host.docker.internal:443", "host.docker.internal:43118", "metadata.google.internal:80"]) {
      yield* checkPolicyDenied(handle.id, target)
    }
    if (handle.subscriptionProxy !== undefined) {
      const health = yield* exec(handle, {
        argv: [
          "curl",
          "--fail",
          "--silent",
          "--show-error",
          "--max-time",
          "5",
          "--output",
          "/dev/null",
          `http://${handle.subscriptionProxy.endpoint.host}:${handle.subscriptionProxy.endpoint.port}/__epochbox_health`
        ]
      }, true)
      if (health.exitCode !== 0) {
        return yield* new SecurityCapabilityError({
          capability: "locked host credential proxy reachability",
          message: "the exact proxy endpoint was not reachable after sealing"
        })
      }
    }
    const unlistedHostname = chooseUnlistedHostname(lock)
    const policyDns = yield* checkPolicyDenied(handle.id, `${unlistedHostname}:53`)
    const policyOutbound = yield* checkPolicyDenied(handle.id, "1.1.1.1:443")
    const policyUnlisted = yield* checkPolicyDenied(handle.id, `${unlistedHostname}:443`)
    const unlisted = yield* exec(handle, {
      argv: ["node", "-e", "const tls=require('tls'),s=tls.connect({host:process.argv[1],port:443,servername:process.argv[1]});s.setTimeout(5000);s.on('secureConnect',()=>process.exit(1));s.on('error',()=>process.exit(0));s.on('timeout',()=>process.exit(0))", unlistedHostname]
    }, true)
    const outbound = yield* exec(handle, {
      argv: ["node", "-e", "const tls=require('tls'),s=tls.connect({host:'1.1.1.1',port:443,servername:'cloudflare-dns.com'});s.setTimeout(5000);s.on('secureConnect',()=>process.exit(1));s.on('error',()=>process.exit(0));s.on('timeout',()=>process.exit(0))"]
    }, true)
    if (unlisted.exitCode !== 0 || outbound.exitCode !== 0 || !policyDns || !policyOutbound || !policyUnlisted) {
      return yield* new SecurityCapabilityError({
        capability: "post-seal non-allowlisted egress canary",
        message: `network denial proof failed (unlisted=${unlisted.exitCode}, outbound=${outbound.exitCode})`
      })
    }
    return {
      workspace: handle as SealedWorkspace,
      attestation: {
        backend: "sbx",
        sandboxId: handle.id,
        provisionPublicEgressAllowed: true,
        provisionProcessesTerminated: true,
        temporaryCredentialsRemoved: true,
        providerEnvironmentScrubbed: true,
        providerCredentialsBrokered: true,
        sshAgentAbsent: true,
        secretMountEmpty: true,
        hostEnforcedDenyRule: handle.subscriptionProxy === undefined
          ? "default-deny with exact host:port allow rules"
          : "default-deny with one exact localhost proxy port for the Docker host alias",
        executeEgress: lock.executeEgress,
        allowedEgressPolicyChecksPassed: true,
        defaultDenyCanaryTargets,
        unlistedHostnameCanaryTarget: `${unlistedHostname}:443`,
        outboundCanaryTarget: "1.1.1.1:443",
        dnsCanaryDenied: true,
        outboundCanaryDenied: true,
        unlistedHostnameCanaryDenied: true,
        dockerSocketAbsent: true,
        privateNetworkDenyResources: privateDenyResources,
        ...(handle.subscriptionProxy === undefined ? {} : {
          credentialProxy: {
            provider: handle.subscriptionProxy.provider,
            endpoint: `${handle.subscriptionProxy.endpoint.host}:${handle.subscriptionProxy.endpoint.port}`,
            policyEndpoint: `localhost:${handle.subscriptionProxy.endpoint.port}`,
            upstreamHosts: handle.subscriptionProxy.upstreamHosts,
            credentialSource: handle.subscriptionProxy.credentialSource,
            headerNames: handle.subscriptionProxy.headerNames,
            refresh: handle.subscriptionProxy.refresh,
            sandboxCredentialMaterial: "placeholder-only" as const,
            adjacentHostPortsDenied: true
          }
        })
      }
    }
  }),
  destroy: (handle) => Effect.all([
    sbx(["rm", "--force", handle.id], true).pipe(Effect.asVoid, Effect.ignore),
    closeSubscriptionProxy(handle)
  ]).pipe(Effect.asVoid)
} satisfies SandboxBackendService)
