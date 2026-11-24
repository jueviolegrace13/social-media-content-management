import sharp from 'sharp'
import { AppError, badRequest } from '../errors.js'

/**
 * Image checks and clean-up for uploads (FR-3). The type comes from the file's first bytes, never the name or the
 * Content-Type header. Every image is decoded and re-encoded, which drops EXIF/XMP/ICC metadata (location, camera)
 * after applying the EXIF orientation.
 */

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
/** Refuse decompression bombs: a small file that decodes to a huge bitmap. */
const MAX_PIXELS = 50_000_000

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp'

export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const b = bytes
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png'
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' &&
    String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export interface CleanImage {
  bytes: Uint8Array
  contentType: 'image/jpeg' | 'image/png'
  extension: 'jpg' | 'png'
  width: number
  height: number
}

/**
 * JPEG stays JPEG and PNG stays PNG. WebP becomes JPEG (or PNG when it has transparency), since every network we
 * publish to accepts those two.
 */
export async function cleanImage(bytes: Uint8Array): Promise<CleanImage> {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new AppError(413, 'PayloadTooLarge', 'Images can be at most 8 MB')
  const type = sniffImageType(bytes)
  if (!type) throw new AppError(415, 'UnsupportedMediaType', 'Upload a JPEG, PNG or WebP image')
  try {
    const input = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
    const meta = await input.metadata()
    const toPng = type === 'image/png' || (type === 'image/webp' && meta.hasAlpha === true)
    // .rotate() with no argument applies the EXIF orientation; metadata isn't copied unless asked for.
    const pipeline = input.rotate()
    const out = toPng
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer({ resolveWithObject: true })
    return {
      bytes: new Uint8Array(out.data),
      contentType: toPng ? 'image/png' : 'image/jpeg',
      extension: toPng ? 'png' : 'jpg',
      width: out.info.width,
      height: out.info.height,
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw badRequest('The image could not be read')
  }
}
