import { getImageMetadata, resizeToJpeg } from "openclaw/plugin-sdk/media-runtime";

// Buzz relays refuse images that carry metadata (EXIF, XMP, ICC, text chunks)
// with HTTP 422, and Buzz clients strip it before upload. These match the
// relay's allowlist in buzz-media's validation.rs.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_RENDERING_CHUNKS = new Set([
  "cHRM",
  "gAMA",
  "sBIT",
  "sRGB",
  "bKGD",
  "hIST",
  "tRNS",
  "sPLT",
  "acTL",
  "fcTL",
  "fdAT",
]);
const JPEG_SANITIZE_QUALITY = 85;

export type BuzzUploadMedia = {
  buffer: Buffer;
  contentType: string;
};

/**
 * Drops every ancillary PNG chunk the relay does not allow and anything after
 * IEND. Critical chunks pass through untouched, so pixels, transparency and
 * APNG frames are unchanged. Returns undefined for malformed input.
 */
export function stripPngMetadata(buffer: Buffer): Buffer | undefined {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return undefined;
  }
  const kept: Buffer[] = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= buffer.length) {
    const end = offset + 12 + buffer.readUInt32BE(offset);
    if (end > buffer.length) {
      return undefined;
    }
    const kind = buffer.toString("latin1", offset + 4, offset + 8);
    const ancillary = (buffer.readUInt8(offset + 4) & 0x20) !== 0;
    if (!ancillary || PNG_RENDERING_CHUNKS.has(kind)) {
      kept.push(buffer.subarray(offset, end));
    }
    if (kind === "IEND") {
      return Buffer.concat(kept);
    }
    offset = end;
  }
  return undefined;
}

/**
 * Prepares an attachment for a Buzz relay. JPEGs are re-encoded at full size,
 * which applies EXIF orientation before dropping it; PNGs lose their metadata
 * chunks. Other types pass through and the relay remains the authority.
 */
export async function sanitizeBuzzUploadMedia(media: BuzzUploadMedia): Promise<BuzzUploadMedia> {
  if (media.contentType === "image/png") {
    const stripped = stripPngMetadata(media.buffer);
    if (!stripped) {
      throw new Error("Buzz media sanitize failed: malformed PNG");
    }
    return { buffer: stripped, contentType: media.contentType };
  }
  if (media.contentType === "image/jpeg") {
    const meta = await getImageMetadata(media.buffer);
    if (!meta) {
      throw new Error("Buzz media sanitize failed: unreadable JPEG");
    }
    const buffer = await resizeToJpeg({
      buffer: media.buffer,
      maxSide: Math.max(meta.width, meta.height),
      quality: JPEG_SANITIZE_QUALITY,
      withoutEnlargement: true,
    });
    return { buffer, contentType: "image/jpeg" };
  }
  return media;
}
