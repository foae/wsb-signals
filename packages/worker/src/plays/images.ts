/**
 * LLM image prep (P2, plays-plan §4/§10): load a play's archived media and shape it for the vision
 * request — sharp downscale/re-encode off the main path (pure JS cannot resize a JPEG; shipping
 * full-size screenshots would blow both the token budget and §1's memory cap).
 *
 *  - The FIRST `max_images_llm` items in gallery order, never an arbitrary subset (the first image
 *    is nearly always the position screenshot — product §4.1).
 *  - Everything re-encodes to JPEG (longest edge ≤ MAX_EDGE_PX, quality Q) — one uniform mediaType,
 *    predictable size, animated GIFs collapse to their first frame.
 *  - `max_request_mb` bounds the TOTAL payload: images past the cap are dropped from the tail (the
 *    head is the screenshot that matters) and the drop is reported, not silent.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'

import type { PlayMediaItem } from '@wsb/shared'

import { log } from '../logger'
import type { AnalyzerImage } from './analyzer'

const MAX_EDGE_PX = 1600
const JPEG_QUALITY = 80

/** THE production encoding — exported so `plays-eval` scores exactly what production sends
 *  (scoring raw archived images would measure a model on inputs it never sees). */
export async function encodeForLlm(raw: Buffer): Promise<AnalyzerImage> {
  const data = await sharp(raw, { animated: false })
    .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer()
  return { data, mediaType: 'image/jpeg' }
}

export interface PreparedImages {
  images: AnalyzerImage[]
  /** Items that could not be loaded/encoded or fell past the request-byte cap. */
  dropped: string[]
  totalBytes: number
}

export async function preparePlayImages(
  playId: string, media: readonly PlayMediaItem[], opts: { mediaDir: string; maxImagesLlm: number; maxRequestBytes: number },
): Promise<PreparedImages> {
  const take = [...media].sort((a, b) => a.order - b.order).slice(0, opts.maxImagesLlm)
  const images: AnalyzerImage[] = []
  const dropped: string[] = []
  let totalBytes = 0
  for (const [i, item] of take.entries()) {
    try {
      const raw = await readFile(join(opts.mediaDir, item.path))
      const { data: encoded } = await encodeForLlm(raw)
      if (totalBytes + encoded.length > opts.maxRequestBytes) {
        // Cap hit: drop the WHOLE tail, not just this image — skipping one and sending the next
        // would present the model a gapped "original order".
        dropped.push(...take.slice(i).map((it) => `${it.path} (request byte cap)`))
        break
      }
      totalBytes += encoded.length
      images.push({ data: encoded, mediaType: 'image/jpeg' })
    } catch (e) {
      // A missing/corrupt file is a volume problem, not a reason to fail the play — extract from
      // what loads, and say what was lost.
      dropped.push(`${item.path} (${String(e).slice(0, 120)})`)
    }
  }
  if (dropped.length) log.warn({ playId, dropped }, 'plays llm: some archived images not sent')
  return { images, dropped, totalBytes }
}
