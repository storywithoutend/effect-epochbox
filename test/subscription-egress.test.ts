import { describe, expect, it } from "vitest"
import {
  subscriptionProviderProfile,
  subscriptionSandboxConfiguration,
  subscriptionUpstreamRequestPath
} from "../src/services/subscription-egress.js"

const PROXY_ENDPOINT = { host: "host.docker.internal", port: 43_117 } as const

describe("subscription credential egress", () => {
  it("defines fail-closed provider profiles for Codex and xAI subscriptions", () => {
    expect(subscriptionProviderProfile("openai-codex")).toEqual({
      provider: "openai-codex",
      upstreamBaseUrl: "https://chatgpt.com/backend-api",
      allowedUpstreamHosts: ["chatgpt.com"],
      credentialSource: {
        command: "pi",
        args: ["auth", "print-bearer-token", "--provider", "openai-codex", "--min-expiry", "10m"]
      },
      headerShape: "codex-bearer-with-account"
    })
    expect(subscriptionProviderProfile("xai")).toEqual({
      provider: "xai",
      upstreamBaseUrl: "https://api.x.ai/v1",
      allowedUpstreamHosts: ["api.x.ai"],
      credentialSource: {
        command: "pi",
        args: ["auth", "print-bearer-token", "--provider", "xai", "--min-expiry", "10m"]
      },
      headerShape: "bearer"
    })
  })

  it("maps client-relative paths beneath the provider's fixed upstream base", () => {
    const upstream = new URL("https://api.x.ai/v1")

    expect(subscriptionUpstreamRequestPath("/chat/completions?stream=true", upstream))
      .toBe("/v1/chat/completions?stream=true")
    expect(subscriptionUpstreamRequestPath("/v1/responses", upstream)).toBe("/v1/responses")
    expect(subscriptionUpstreamRequestPath("//example.com/steal", upstream)).toBeUndefined()
  })

  it("builds credential-free Pi configuration that targets only the host proxy", () => {
    const codex = subscriptionSandboxConfiguration("openai-codex", PROXY_ENDPOINT)
    const xai = subscriptionSandboxConfiguration("xai", PROXY_ENDPOINT)

    expect(codex.settings).toEqual({ transport: "sse" })
    expect(codex.models).toEqual({
      providers: {
        "openai-codex": { baseUrl: "http://host.docker.internal:43117/backend-api" }
      }
    })
    const codexAuth = codex.auth["openai-codex"]
    expect(codexAuth).toMatchObject({
      type: "oauth",
      refresh: "proxy-managed"
    })
    expect(codexAuth?.access.split(".")).toHaveLength(3)
    expect(xai).toMatchObject({
      models: { providers: { xai: { baseUrl: "http://host.docker.internal:43117/v1" } } },
      environment: {
        XAI_API_KEY: "xai-0000000000000000000000000000000000000000000000000000000000000000",
        GROK_CODE_XAI_API_KEY: "xai-0000000000000000000000000000000000000000000000000000000000000000",
        XAI_API_BASE_URL: "http://host.docker.internal:43117/v1",
        GROK_XAI_API_BASE_URL: "http://host.docker.internal:43117"
      }
    })
    expect(JSON.stringify({ codex, xai })).not.toMatch(/chatgpt-account-id|bearer-token|access_token/i)
  })
})
