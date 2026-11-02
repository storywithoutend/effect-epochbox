import { Effect } from "effect"
import { PhaseTransitionError } from "./errors.js"

export type Phase = "created" | "materialize" | "provision" | "seal" | "execute" | "collect" | "verify" | "complete"

const nextPhase: Readonly<Record<Phase, Phase | undefined>> = {
  created: "materialize",
  materialize: "provision",
  provision: "seal",
  seal: "execute",
  execute: "collect",
  collect: "verify",
  verify: "complete",
  complete: undefined
}

export class PhaseMachine {
  private currentValue: Phase = "created"

  get current(): Phase { return this.currentValue }

  transition(to: Phase): Effect.Effect<void, PhaseTransitionError> {
    if (nextPhase[this.currentValue] !== to) return Effect.fail(new PhaseTransitionError({ from: this.currentValue, to }))
    this.currentValue = to
    return Effect.void
  }
}
