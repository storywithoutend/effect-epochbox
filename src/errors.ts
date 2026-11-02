import { Data } from "effect"

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly message: string
  readonly path?: string
}> {}

export class SourceArchiveError extends Data.TaggedError("SourceArchiveError")<{
  readonly message: string
  readonly repository?: string
  readonly cause?: unknown
}> {}

export class BackendError extends Data.TaggedError("BackendError")<{
  readonly message: string
  readonly operation: string
  readonly cause?: unknown
}> {}

export class SecurityCapabilityError extends Data.TaggedError("SecurityCapabilityError")<{
  readonly message: string
  readonly capability: string
}> {}

export class PhaseTransitionError extends Data.TaggedError("PhaseTransitionError")<{
  readonly from: string
  readonly to: string
}> {}

export class ReplacementError extends Data.TaggedError("ReplacementError")<{
  readonly message: string
  readonly repository: string
  readonly packageName?: string
}> {}

export class IntegrityError extends Data.TaggedError("IntegrityError")<{
  readonly message: string
  readonly path?: string
}> {}

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly message: string
  readonly action?: number
  readonly cause?: unknown
}> {}

export class VerificationError extends Data.TaggedError("VerificationError")<{
  readonly message: string
  readonly check?: string
}> {}

export type EpochboxError =
  | ConfigurationError
  | SourceArchiveError
  | BackendError
  | SecurityCapabilityError
  | PhaseTransitionError
  | ReplacementError
  | IntegrityError
  | AgentError
  | VerificationError
