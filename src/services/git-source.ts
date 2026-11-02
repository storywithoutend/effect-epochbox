import { Context, Effect, Layer } from "effect"
import { SourceArchiveError } from "../errors.js"
import { sha256 } from "../util/canonical.js"
import { runProcess, stdoutText } from "../util/process.js"

export interface ArchiveSnapshot {
  readonly commit: string
  readonly tree: string
  readonly bytes: Buffer
  readonly sha256: string
}

export interface GitSourceService {
  readonly archive: (source: string, revision: string, repository: string) => Effect.Effect<ArchiveSnapshot, SourceArchiveError>
}

export class GitSource extends Context.Tag("effect-epochbox/GitSource")<GitSource, GitSourceService>() {}

const git = (source: string, args: ReadonlyArray<string>, repository: string) =>
  runProcess("git", ["-C", source, ...args]).pipe(
    Effect.mapError((cause) => new SourceArchiveError({ message: cause.message, repository, cause }))
  )

export const GitSourceLive = Layer.succeed(GitSource, {
  archive: (source, revision, repository) => Effect.gen(function* () {
    const commit = stdoutText(yield* git(source, ["rev-parse", "--verify", `${revision}^{commit}`], repository)).trim()
    const tree = stdoutText(yield* git(source, ["rev-parse", "--verify", `${commit}^{tree}`], repository)).trim()
    const archive = yield* git(source, ["archive", "--format=tar", commit], repository)
    if (archive.stdout.length === 0) {
      return yield* new SourceArchiveError({ message: "git archive produced an empty archive", repository })
    }
    return { commit, tree, bytes: archive.stdout, sha256: sha256(archive.stdout) }
  })
} satisfies GitSourceService)
