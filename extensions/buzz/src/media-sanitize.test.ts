import { crc32 } from "node:zlib";
import { getImageMetadata, resizeToJpeg } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it } from "vitest";
import { sanitizeBuzzUploadMedia, stripPngMetadata } from "./media-sanitize.js";

// 1x1 transparent PNG: IHDR, IDAT, IEND.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const IEND_OFFSET = PNG.length - 12;

function pngChunk(kind: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(kind, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function pngChunkKinds(buffer: Buffer): string[] {
  const kinds: string[] = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    kinds.push(buffer.toString("latin1", offset + 4, offset + 8));
    offset += 12 + buffer.readUInt32BE(offset);
  }
  return kinds;
}

function jpegMarkers(buffer: Buffer): number[] {
  const markers: number[] = [];
  for (let offset = 2; offset + 4 <= buffer.length;) {
    const marker = buffer.readUInt8(offset + 1);
    markers.push(marker);
    if (marker === 0xda) {
      break;
    }
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return markers;
}

describe("stripPngMetadata", () => {
  it("drops metadata chunks and trailing bytes but keeps rendering chunks", () => {
    const dirty = Buffer.concat([
      PNG.subarray(0, IEND_OFFSET),
      pngChunk("tEXt", Buffer.from("Comment\0from a camera")),
      pngChunk("eXIf", Buffer.from("MM\0*")),
      pngChunk("pHYs", Buffer.alloc(9)),
      pngChunk("tRNS", Buffer.from([0])),
      PNG.subarray(IEND_OFFSET),
      Buffer.from("trailer"),
    ]);

    const clean = stripPngMetadata(dirty);

    expect(clean && pngChunkKinds(clean)).toEqual(["IHDR", "IDAT", "tRNS", "IEND"]);
  });

  it("leaves an already clean PNG byte-identical", () => {
    expect(stripPngMetadata(PNG)?.equals(PNG)).toBe(true);
  });

  it("rejects input that is not a complete PNG", () => {
    expect(stripPngMetadata(Buffer.from("not a png"))).toBeUndefined();
    expect(stripPngMetadata(PNG.subarray(0, IEND_OFFSET))).toBeUndefined();
  });
});

describe("sanitizeBuzzUploadMedia", () => {
  it("re-encodes a JPEG without its EXIF segment", async () => {
    const jpeg = await resizeToJpeg({ buffer: PNG, maxSide: 1, quality: 85 });
    const exif = Buffer.from("Exif\0\0MM\0*\0\0\0\x08\0\0");
    const app1 = Buffer.alloc(4);
    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(exif.length + 2, 2);
    const dirty = Buffer.concat([jpeg.subarray(0, 2), app1, exif, jpeg.subarray(2)]);
    expect(jpegMarkers(dirty)).toContain(0xe1);

    const clean = await sanitizeBuzzUploadMedia({ buffer: dirty, contentType: "image/jpeg" });

    expect(clean.contentType).toBe("image/jpeg");
    expect(jpegMarkers(clean.buffer)).not.toContain(0xe1);
    expect(await getImageMetadata(clean.buffer)).toMatchObject({ width: 1, height: 1 });
  });

  it("applies EXIF orientation before dropping it", async () => {
    const wide = await resizeToJpeg({
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=",
        "base64",
      ),
      maxSide: 2,
      quality: 85,
    });
    // "Exif\0\0", then a big-endian TIFF whose one IFD entry is Orientation
    // (0x0112) = 6, rotate 90° CW.
    const exif = Buffer.from(
      "4578696600004d4d002a00000008000101120003000000010006000000000000",
      "hex",
    );
    const app1 = Buffer.alloc(4);
    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(exif.length + 2, 2);
    const rotated = Buffer.concat([wide.subarray(0, 2), app1, exif, wide.subarray(2)]);

    const clean = await sanitizeBuzzUploadMedia({ buffer: rotated, contentType: "image/jpeg" });

    expect(jpegMarkers(clean.buffer)).not.toContain(0xe1);
    expect(await getImageMetadata(clean.buffer)).toMatchObject({ width: 1, height: 2 });
  });

  it("passes other media types through untouched", async () => {
    const video = { buffer: Buffer.from("not inspected"), contentType: "video/mp4" };
    expect(await sanitizeBuzzUploadMedia(video)).toBe(video);
  });

  it("throws on a malformed PNG so the caller degrades the attachment", async () => {
    await expect(
      sanitizeBuzzUploadMedia({ buffer: Buffer.from("broken"), contentType: "image/png" }),
    ).rejects.toThrow(/malformed PNG/u);
  });
});
