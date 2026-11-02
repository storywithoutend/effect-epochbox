import { Context, Effect, Layer } from "effect"
import { BackendError, ConfigurationError } from "../errors.js"
import { runProcess, stdoutText } from "../util/process.js"

export interface ImageResolverService {
  readonly resolve: (reference: string) => Effect.Effect<string, ConfigurationError | BackendError>
  readonly assertCurrent: (reference: string, identity: string) => Effect.Effect<void, ConfigurationError | BackendError>
}

export class ImageResolver extends Context.Tag("effect-epochbox/ImageResolver")<ImageResolver, ImageResolverService>() {}

interface TemplateImage { readonly id: string; readonly repository: string; readonly tag: string }

const normalize = (reference: string): string => reference.replace(/^docker\.io\//, "")

const templates = Effect.gen(function* () {
  const result = yield* runProcess("sbx", ["template", "ls", "--json"])
  const output = stdoutText(result)
  const jsonStart = output.indexOf("{")
  if (jsonStart === -1) return yield* new BackendError({ operation: "sbx template ls", message: `sbx returned no JSON: ${output}` })
  const parsed = yield* Effect.try({
    try: () => JSON.parse(output.slice(jsonStart)) as { images?: ReadonlyArray<TemplateImage> },
    catch: (cause) => new BackendError({ operation: "sbx template ls", message: `invalid sbx JSON: ${String(cause)}`, cause })
  })
  return parsed.images ?? []
})

const findImage = (images: ReadonlyArray<TemplateImage>, reference: string): TemplateImage | undefined => {
  const wanted = normalize(reference)
  return images.find((image) => normalize(`${image.repository}:${image.tag}`) === wanted || image.id === wanted)
}

export const ImageResolverSbx = Layer.succeed(ImageResolver, {
  resolve: (reference) => templates.pipe(
    Effect.flatMap((images) => {
      const image = findImage(images, reference)
      return image === undefined
        ? Effect.fail(new ConfigurationError({ message: `sbx template is not installed: ${reference}`, path: "image" }))
        : Effect.succeed(image.id)
    })
  ),
  assertCurrent: (reference, identity) => templates.pipe(
    Effect.flatMap((images) => {
      const image = findImage(images, reference)
      return image?.id === identity
        ? Effect.void
        : Effect.fail(new ConfigurationError({ message: `image identity drift: locked ${identity}, current ${image?.id ?? "missing"}`, path: "image" }))
    })
  )
} satisfies ImageResolverService)

export const ImageResolverFixed = (identity = "fake-image-v1") => Layer.succeed(ImageResolver, {
  resolve: () => Effect.succeed(identity),
  assertCurrent: (_reference, expected) => expected === identity
    ? Effect.void
    : Effect.fail(new ConfigurationError({ message: `image identity drift: locked ${expected}, current ${identity}`, path: "image" }))
} satisfies ImageResolverService)
