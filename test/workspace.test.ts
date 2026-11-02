import { promises as fs } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  assertNoEscapingSymlinks,
  materializeWorkspaceSymlinkTargets,
  restoreWorkspaceCompatibilitySymlinks
} from "../src/workspace.js"
import { tempDirectory } from "./helpers.js"

describe("workspace symlink confinement", () => {
  it("allows a historical repository symlink that stays inside the workspace boundary", async () => {
    const workspace = await tempDirectory("workspace-symlink")
    const repository = path.join(workspace, "repos", "apps-monorepo")
    const linkDirectory = path.join(repository, "packages", "utils")
    await fs.mkdir(linkDirectory, { recursive: true })
    await fs.symlink("../../../utils", path.join(linkDirectory, "utils"))

    await expect(Effect.runPromise(assertNoEscapingSymlinks(repository, workspace))).resolves.toBeUndefined()
    await expect(Effect.runPromise(assertNoEscapingSymlinks(repository))).rejects.toThrow(/symlink escapes/)

    const compatibility = await Effect.runPromise(materializeWorkspaceSymlinkTargets(repository, workspace))
    expect((await fs.stat(path.join(workspace, "repos", "utils"))).isDirectory()).toBe(true)
    expect((await fs.lstat(path.join(linkDirectory, "utils"))).isSymbolicLink()).toBe(true)

    await fs.unlink(path.join(linkDirectory, "utils"))
    await fs.mkdir(path.join(linkDirectory, "utils"))
    const repairs = await Effect.runPromise(restoreWorkspaceCompatibilitySymlinks({
      root: workspace,
      repositoriesRoot: path.join(workspace, "repos"),
      originalLockfiles: {},
      compatibilitySymlinks: compatibility.map((entry) => ({
        repository: "apps",
        repositoryDestination: "apps-monorepo",
        ...entry
      }))
    }))
    expect(repairs).toEqual([expect.objectContaining({ repository: "apps", path: "packages/utils/utils", restored: true })])
    expect(await fs.readlink(path.join(linkDirectory, "utils"))).toBe("../../../utils")
  })

  it("rejects a symlink that escapes the workspace boundary", async () => {
    const workspace = await tempDirectory("workspace-symlink-escape")
    const repository = path.join(workspace, "repos", "apps-monorepo")
    const linkDirectory = path.join(repository, "packages", "utils")
    await fs.mkdir(linkDirectory, { recursive: true })
    await fs.symlink("../../../../../outside", path.join(linkDirectory, "utils"))

    await expect(Effect.runPromise(assertNoEscapingSymlinks(repository, workspace))).rejects.toThrow(/symlink escapes/)
  })
})
