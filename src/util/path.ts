import path from "node:path"
import { IntegrityError } from "../errors.js"

const safeDestinationPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const isSafeDestination = (value: string): boolean =>
  safeDestinationPattern.test(value) && value !== "." && value !== ".." && !value.endsWith(".lock")

export const resolveInside = (root: string, relative: string): string => {
  const absoluteRoot = path.resolve(root)
  const resolved = path.resolve(root, relative)
  if (resolved !== absoluteRoot && !resolved.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new IntegrityError({ message: "path escapes workspace", path: relative })
  }
  return resolved
}

export const normalizeEvidencePath = (value: string): string => value.split(path.sep).join("/")
