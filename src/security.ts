export const credentialEnvironmentNames = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "NEBIUS_API_KEY",
  "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "CODEX_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "SSH_AUTH_SOCK", "SSH_AUTH_SOCK_GATEWAY", "BASH_ENV",
  "SBX_CRED_OPENAI_MODE", "SBX_CRED_ANTHROPIC_MODE", "SBX_CRED_OPENROUTER_MODE", "SBX_CRED_GOOGLE_MODE", "SBX_CRED_MISTRAL_MODE",
  "SBX_CRED_XAI_MODE", "SBX_CRED_NEBIUS_MODE", "SBX_CRED_GITHUB_MODE"
] as const

export const isSensitiveEnvironmentName = (name: string): boolean =>
  credentialEnvironmentNames.includes(name as typeof credentialEnvironmentNames[number]) ||
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS?)($|_)/i.test(name)

export const hostCredentialEnvironmentNames = (): ReadonlyArray<string> => Object.keys(process.env).filter(isSensitiveEnvironmentName)

export const XAI_PROXY_CREDENTIAL_MARKER = "xai-0000000000000000000000000000000000000000000000000000000000000000"

export interface ProviderCredentialMarker {
  readonly name: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "OPENROUTER_API_KEY" | "GROK_CODE_XAI_API_KEY"
  readonly value: "proxy-managed" | typeof XAI_PROXY_CREDENTIAL_MARKER
}

export const providerCredentialMarker = (
  provider: import("./schema.js").ProviderService
): ProviderCredentialMarker | undefined => {
  switch (provider) {
    case "anthropic": return { name: "ANTHROPIC_API_KEY", value: "proxy-managed" }
    case "openai": return { name: "OPENAI_API_KEY", value: "proxy-managed" }
    case "openrouter": return { name: "OPENROUTER_API_KEY", value: "proxy-managed" }
    case "xai": return { name: "GROK_CODE_XAI_API_KEY", value: XAI_PROXY_CREDENTIAL_MARKER }
    case "openai-codex": return undefined
  }
}
