import { promises as fs } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { IntegrityError } from "../errors.js"
import { canonicalJson, sha256 } from "./canonical.js"
import { normalizeEvidencePath } from "./path.js"

export const readJson = (file: string): Effect.Effect<unknown, IntegrityError> =>
  Effect.tryPromise({
    try: async () => JSON.parse(await fs.readFile(file, "utf8")) as unknown,
    catch: (cause) => new IntegrityError({ message: `cannot read JSON: ${String(cause)}`, path: file })
  })

export const writeJson = (file: string, value: unknown): Effect.Effect<void, IntegrityError> =>
  Effect.tryPromise({
    try: async () => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, canonicalJson(value)) },
    catch: (cause) => new IntegrityError({ message: `cannot write JSON: ${String(cause)}`, path: file })
  })

export interface FileHash { readonly path: string; readonly sha256: string; readonly size: number; readonly kind: "file" | "symlink" }

export const hashTree = (root: string, exclude: ReadonlySet<string> = new Set()): Effect.Effect<ReadonlyArray<FileHash>, IntegrityError> =>
  Effect.tryPromise({
    try: async () => {
      const output: FileHash[] = []
      const visit = async (directory: string): Promise<void> => {
        const entries = await fs.readdir(directory, { withFileTypes: true })
        entries.sort((left, right) => left.name.localeCompare(right.name))
        for (const entry of entries) {
          const absolute = path.join(directory, entry.name)
          const relative = normalizeEvidencePath(path.relative(root, absolute))
          if (exclude.has(relative)) continue
          if (entry.isDirectory()) await visit(absolute)
          else if (entry.isSymbolicLink()) {
            const target = await fs.readlink(absolute)
            output.push({ path: relative, sha256: sha256(`symlink:${target}`), size: Buffer.byteLength(target), kind: "symlink" })
          } else if (entry.isFile()) {
            const contents = await fs.readFile(absolute)
            output.push({ path: relative, sha256: sha256(contents), size: contents.length, kind: "file" })
          } else throw new Error(`unsupported filesystem entry ${relative}`)
        }
      }
      await visit(root)
      return output
    },
    catch: (cause) => new IntegrityError({ message: `cannot hash tree: ${String(cause)}`, path: root })
  })

export const hashTreeIdentity = (entries: ReadonlyArray<FileHash>): string => sha256(canonicalJson(entries))
