import { createHash } from "node:crypto"

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)])
    )
  }
  return value
}

export const canonicalJson = (value: unknown): string => `${JSON.stringify(normalize(value), null, 2)}\n`
export const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex")
