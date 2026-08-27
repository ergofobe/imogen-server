import { createHash } from 'node:crypto'
import { mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import ort from 'onnxruntime-node'

/**
 * The face models are downloaded onto the server the first time face grouping is
 * enabled, rather than shipped inside the image.
 *
 * Two reasons. They are 190 MB, which would roughly double the image for a feature many
 * deployments will never switch on. And the InsightFace weights are licensed for
 * non-commercial research use — imogen redistributing them would put that decision on
 * everyone who pulls the image, so it stays with the operator who enables the feature.
 */
export const MODELS = {
  detection: {
    file: 'scrfd_10g_bnkps.onnx',
    url: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/detection/model.onnx',
    approximateBytes: 16_923_827,
  },
  recognition: {
    file: 'arcface_w600k_r50.onnx',
    url: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx',
    approximateBytes: 174_383_860,
  },
} as const

export type ModelName = keyof typeof MODELS

export type ModelStatus = {
  name: ModelName
  present: boolean
  bytes: number
  expectedBytes: number
}

export class ModelStore {
  constructor(private readonly directory: string) {}

  pathFor(name: ModelName): string {
    return join(this.directory, MODELS[name].file)
  }

  async status(): Promise<ModelStatus[]> {
    return Promise.all(
      (Object.keys(MODELS) as ModelName[]).map(async (name) => {
        const info = await stat(this.pathFor(name)).catch(() => null)
        return {
          name,
          present: info !== null && info.size > 0,
          bytes: info?.size ?? 0,
          expectedBytes: MODELS[name].approximateBytes,
        }
      }),
    )
  }

  async isReady(): Promise<boolean> {
    return (await this.status()).every((m) => m.present)
  }

  /**
   * Downloads anything missing. Writes to a temporary name and renames on completion,
   * so an interrupted download can never leave a half-file that loads as a corrupt
   * model — the next attempt simply sees it as absent.
   */
  async download(onProgress?: (name: ModelName, received: number, total: number) => void) {
    await mkdir(this.directory, { recursive: true })

    for (const name of Object.keys(MODELS) as ModelName[]) {
      const target = this.pathFor(name)
      if ((await stat(target).catch(() => null))?.size) continue

      const { url } = MODELS[name]
      const response = await fetch(url)
      if (!response.ok || !response.body) {
        throw new Error(`Could not download the ${name} model: ${response.status}`)
      }

      const total = Number(response.headers.get('content-length') ?? 0)
      const temporary = `${target}.partial`
      const sink = Bun.file(temporary).writer()
      let received = 0

      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        sink.write(value)
        received += value.byteLength
        onProgress?.(name, received, total)
      }
      await sink.end()
      await rename(temporary, target)
    }
  }

  /** Loads both sessions. Cheap to hold open; expensive to create per request. */
  async open(): Promise<{ detection: ort.InferenceSession; recognition: ort.InferenceSession }> {
    // onnxruntime reports a missing file as a load failure, which reads like a corrupt
    // model rather than one that has not been downloaded yet.
    const missing = (await this.status()).filter((m) => !m.present)
    if (missing.length > 0) {
      throw new Error(
        `Face models have not been downloaded yet: ${missing.map((m) => MODELS[m.name].file).join(', ')}`,
      )
    }

    const [detection, recognition] = await Promise.all([
      ort.InferenceSession.create(this.pathFor('detection')),
      ort.InferenceSession.create(this.pathFor('recognition')),
    ])
    return { detection, recognition }
  }
}

/** Identifies a model file in logs without printing 174 MB of weights. */
export async function fingerprint(path: string): Promise<string> {
  const hash = createHash('sha256')
  const reader = Bun.file(path).stream().getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
  }
  return hash.digest('hex').slice(0, 16)
}
