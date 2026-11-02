import { spawn } from "node:child_process"
import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http"
import https from "node:https"
import { isSensitiveEnvironmentName, XAI_PROXY_CREDENTIAL_MARKER } from "../security.js"

export const SUBSCRIPTION_PROXY_HOST = "host.docker.internal"
export const SUBSCRIPTION_PROXY_PORT = 43_117

export type SubscriptionProvider = "openai-codex" | "xai"
export type SubscriptionHeaderShape = "bearer" | "codex-bearer-with-account"

export interface SubscriptionProviderProfile {
  readonly provider: SubscriptionProvider
  readonly upstreamBaseUrl: string
  readonly allowedUpstreamHosts: ReadonlyArray<string>
  readonly credentialSource: {
    readonly command: string
    readonly args: ReadonlyArray<string>
  }
  readonly headerShape: SubscriptionHeaderShape
}

export interface SubscriptionSandboxConfiguration {
  readonly settings: { readonly transport: "sse" }
  readonly models: {
    readonly providers: Readonly<Record<string, { readonly baseUrl: string }>>
  }
  readonly auth: Readonly<Record<string, {
    readonly type: "oauth"
    readonly access: string
    readonly refresh: "proxy-managed"
    readonly expires: number
  }>>
  readonly environment: Readonly<Record<string, string>>
}

export interface SubscriptionEgressProxyHandle {
  readonly provider: SubscriptionProvider
  readonly endpoint: { readonly host: typeof SUBSCRIPTION_PROXY_HOST; readonly port: number }
  readonly upstreamHosts: ReadonlyArray<string>
  readonly credentialSource: "host-pi-auth"
  readonly headerNames: ReadonlyArray<string>
  readonly refresh: "per-request-host-refresh"
  readonly close: () => Promise<void>
}

const PROFILES = {
  "openai-codex": {
    provider: "openai-codex",
    upstreamBaseUrl: "https://chatgpt.com/backend-api",
    allowedUpstreamHosts: ["chatgpt.com"],
    credentialSource: {
      command: "pi",
      args: ["auth", "print-bearer-token", "--provider", "openai-codex", "--min-expiry", "10m"]
    },
    headerShape: "codex-bearer-with-account"
  },
  xai: {
    provider: "xai",
    upstreamBaseUrl: "https://api.x.ai/v1",
    allowedUpstreamHosts: ["api.x.ai"],
    credentialSource: {
      command: "pi",
      args: ["auth", "print-bearer-token", "--provider", "xai", "--min-expiry", "10m"]
    },
    headerShape: "bearer"
  }
} as const satisfies Record<SubscriptionProvider, SubscriptionProviderProfile>

const DUMMY_CODEX_ACCOUNT_ID = "epochbox-proxy-account"
const DUMMY_CODEX_TOKEN = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: DUMMY_CODEX_ACCOUNT_ID }
  })).toString("base64url"),
  "epochbox-proxy-signature"
].join(".")
const DUMMY_OAUTH_EXPIRY = Date.UTC(2100, 0, 1)

export const isSubscriptionProvider = (provider: string): provider is SubscriptionProvider =>
  provider === "openai-codex" || provider === "xai"

export const subscriptionProviderProfile = (provider: SubscriptionProvider): SubscriptionProviderProfile =>
  PROFILES[provider]

export const subscriptionSandboxConfiguration = (
  provider: SubscriptionProvider,
  endpoint: { readonly host: typeof SUBSCRIPTION_PROXY_HOST; readonly port: number }
): SubscriptionSandboxConfiguration => {
  const upstreamPath = new URL(PROFILES[provider].upstreamBaseUrl).pathname.replace(/\/$/u, "")
  const baseUrl = `http://${endpoint.host}:${endpoint.port}${upstreamPath}`
  const access = provider === "openai-codex" ? DUMMY_CODEX_TOKEN : "proxy-managed"
  return {
    settings: { transport: "sse" },
    models: { providers: { [provider]: { baseUrl } } },
    auth: {
      [provider]: {
        type: "oauth",
        access,
        refresh: "proxy-managed",
        expires: DUMMY_OAUTH_EXPIRY
      }
    },
    environment: provider === "xai"
      ? {
        XAI_API_KEY: XAI_PROXY_CREDENTIAL_MARKER,
        GROK_CODE_XAI_API_KEY: XAI_PROXY_CREDENTIAL_MARKER,
        XAI_API_BASE_URL: baseUrl,
        GROK_XAI_API_BASE_URL: `http://${endpoint.host}:${endpoint.port}`
      }
      : {}
  }
}

const credentialEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !isSensitiveEnvironmentName(name)))

const readHostCredential = (profile: SubscriptionProviderProfile): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(profile.credentialSource.command, [...profile.credentialSource.args], {
      env: credentialEnvironment(),
      stdio: ["ignore", "pipe", "ignore"]
    })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        child.kill("SIGKILL")
        return
      }
      chunks.push(chunk)
    })
    child.on("error", () => reject(new Error(`credential source unavailable for ${profile.provider}`)))
    child.on("close", (code) => {
      if (code !== 0 || size > 64 * 1024) {
        reject(new Error(`credential source failed for ${profile.provider}`))
        return
      }
      const credential = Buffer.concat(chunks).toString("utf8").trim()
      if (credential.length === 0 || /\s/u.test(credential)) {
        reject(new Error(`credential source returned an invalid value for ${profile.provider}`))
        return
      }
      resolve(credential)
    })
  })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const codexAccountId = (credential: string): string => {
  const encoded = credential.split(".")[1]
  if (encoded === undefined) throw new Error("Codex credential is not a JWT")
  const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  if (!isRecord(payload)) throw new Error("Codex credential payload is invalid")
  const auth = payload["https://api.openai.com/auth"]
  if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string" || auth.chatgpt_account_id.length === 0) {
    throw new Error("Codex credential has no account identifier")
  }
  return auth.chatgpt_account_id
}

const forwardedHeaders = (
  incoming: IncomingHttpHeaders,
  profile: SubscriptionProviderProfile,
  credential: string,
  upstream: URL
): OutgoingHttpHeaders => {
  const excluded = new Set([
    "authorization",
    "chatgpt-account-id",
    "connection",
    "host",
    "proxy-authorization",
    "proxy-connection",
    "transfer-encoding",
    "x-api-key",
    "upgrade"
  ])
  const headers = Object.fromEntries(
    Object.entries(incoming).filter(([name, value]) => !excluded.has(name.toLowerCase()) && value !== undefined)
  )
  headers.host = upstream.host
  headers.authorization = `Bearer ${credential}`
  if (profile.headerShape === "codex-bearer-with-account") {
    headers["chatgpt-account-id"] = codexAccountId(credential)
  }
  return headers
}

const copyResponseHeaders = (headers: IncomingHttpHeaders): OutgoingHttpHeaders =>
  Object.fromEntries(Object.entries(headers).filter(([name, value]) =>
    value !== undefined && !["connection", "set-cookie", "transfer-encoding", "upgrade"].includes(name.toLowerCase())
  ))

export const subscriptionUpstreamRequestPath = (
  requestUrl: string,
  upstream: URL
): string | undefined => {
  if (!requestUrl.startsWith("/") || requestUrl.startsWith("//")) return undefined
  const parsed = new URL(requestUrl, upstream.origin)
  const basePath = upstream.pathname.replace(/\/$/u, "")
  if (parsed.pathname === basePath || parsed.pathname.startsWith(`${basePath}/`)) return requestUrl
  return `${basePath}${requestUrl}`
}

export const startSubscriptionEgressProxy = async (
  provider: SubscriptionProvider,
  port: number
): Promise<SubscriptionEgressProxyHandle> => {
  const profile = PROFILES[provider]
  const upstream = new URL(profile.upstreamBaseUrl)
  if (upstream.protocol !== "https:" || !profile.allowedUpstreamHosts.some((host) => host === upstream.hostname)) {
    throw new Error(`invalid upstream profile for ${provider}`)
  }
  const server = http.createServer((request, response) => {
    const requestUrl = request.url ?? ""
    if (request.method === "GET" && requestUrl === "/__epochbox_health") {
      response.writeHead(204).end()
      return
    }
    const upstreamRequestPath = subscriptionUpstreamRequestPath(requestUrl, upstream)
    if (upstreamRequestPath === undefined) {
      response.writeHead(404).end()
      return
    }
    void readHostCredential(profile).then((credential) => {
      const outgoing = https.request({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port === "" ? 443 : Number(upstream.port),
        method: request.method,
        path: upstreamRequestPath,
        headers: forwardedHeaders(request.headers, profile, credential, upstream)
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, copyResponseHeaders(upstreamResponse.headers))
        upstreamResponse.pipe(response)
      })
      outgoing.on("error", () => {
        if (!response.headersSent) response.writeHead(502)
        response.end()
      })
      request.on("aborted", () => outgoing.destroy())
      request.pipe(outgoing)
    }).catch(() => {
      response.writeHead(502).end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(new Error(`could not bind subscription proxy for ${provider}`))
    server.once("error", onError)
    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === "string" || address.port !== port) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error(`subscription proxy bound an unexpected endpoint for ${provider}`)
  }
  return {
    provider,
    endpoint: { host: SUBSCRIPTION_PROXY_HOST, port },
    upstreamHosts: profile.allowedUpstreamHosts,
    credentialSource: "host-pi-auth",
    headerNames: profile.headerShape === "codex-bearer-with-account"
      ? ["Authorization", "chatgpt-account-id"]
      : ["Authorization"],
    refresh: "per-request-host-refresh",
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
