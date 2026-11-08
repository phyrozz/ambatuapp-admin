import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { transformMedia, validateVideo, run, probe } from "./transform.mjs";
import { byteRange } from "./gateway.mjs";
import { inputKeys } from "./worker.mjs";

test("invalid secret configuration exits without logging private values", () => {
  for (const entry of ["gateway.mjs", "worker.mjs"]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL(entry, import.meta.url).pathname.replace(
          /^\/(?=[A-Za-z]:)/,
          "",
        ),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          STAGE: "dev",
          DATABASE_CONFIG: "{fixture-private-value",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MEDIA_\w+_START_FAILED/);
    assert(!result.stderr.includes("fixture-private-value"));
  }
});

test("ranges reject malformed/multiple/unsatisfiable values and preserve suffix and open-ended seeking", () => {
  assert.equal(byteRange(undefined, 100), null);
  assert.deepEqual(byteRange("bytes=20-", 100), { start: 20, end: 99 });
  assert.deepEqual(byteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange("bytes=0-999", 100), { start: 0, end: 99 });
  for (const value of [
    "bytes=",
    "bytes=-0",
    "bytes=200-",
    "bytes=9-1",
    "bytes=0-1,4-5",
    "items=1-4",
    "bytes=99999999999999999999-",
  ])
    assert.throws(() => byteRange(value, 100));
});
test("input events accept only the configured bucket and actual object creates", () => {
  const record = {
    eventSource: "aws:s3",
    eventName: "ObjectCreated:Put",
    s3: { bucket: { name: "fixture" }, object: { key: "input%2Ftest+file" } },
  };
  assert.deepEqual(
    inputKeys(JSON.stringify({ Records: [record] }), "fixture"),
    ["input/test file"],
  );
  assert.deepEqual(
    inputKeys(JSON.stringify({ Records: [record] }), "other"),
    [],
  );
  assert.deepEqual(
    inputKeys(
      JSON.stringify({
        Records: [{ ...record, eventName: "ObjectRemoved:Delete" }],
      }),
      "fixture",
    ),
    [],
  );
});
test("real decoding converts PNG transparency to white JPG, strips metadata and rejects spoofed formats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dream-image-test-"));
  try {
    const source = join(dir, "source.png");
    await sharp({
      create: {
        width: 100,
        height: 80,
        channels: 4,
        background: { r: 250, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toFile(source);
    const output = await transformMedia(source, dir, {
      kind: "image",
      content_type: "image/png",
    });
    const metadata = await sharp(output.file).metadata();
    assert.equal(metadata.format, "jpeg");
    assert.equal(metadata.hasAlpha, false);
    assert(!metadata.exif);
    assert(!metadata.xmp);
    const pixel = await sharp(output.file).raw().toBuffer();
    assert(pixel[0] > 245 && pixel[1] > 245 && pixel[2] > 245);
    assert.equal((await sharp(output.thumbnail).metadata()).format, "jpeg");
    await assert.rejects(
      transformMedia(source, dir, {
        kind: "image",
        content_type: "image/jpeg",
      }),
    );
    const spoof = join(dir, "spoof.jpg");
    await writeFile(
      spoof,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    await assert.rejects(
      transformMedia(spoof, dir, { kind: "image", content_type: "image/jpeg" }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("video content validation rejects non-MP4 containers and durations above one hour", () => {
  const header = Buffer.from("0000ftypisom00000000000000000000");
  const valid = {
    format: { duration: "3600", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
    streams: [{ codec_type: "video", width: 1280, height: 720 }],
  };
  assert.equal(validateVideo(valid, header).duration, 3600);
  assert.throws(
    () =>
      validateVideo(
        { ...valid, format: { ...valid.format, duration: "3600.01" } },
        header,
      ),
    (error) => error.code === "VIDEO_TOO_LONG",
  );
  assert.throws(() => validateVideo(valid, Buffer.alloc(32)));
  assert.throws(() =>
    validateVideo({ ...valid, streams: [{ codec_type: "audio" }] }, header),
  );
});
test("real FFmpeg compression supports silent/audio MP4, thumbnails and fast-start output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dream-video-test-"));
  try {
    for (const audio of [false, true]) {
      const source = join(dir, `source-${audio}.mp4`);
      await run(process.env.FFMPEG_PATH || "ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x240:d=1",
        ...(audio
          ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"]
          : []),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        ...(audio ? ["-c:a", "aac", "-shortest"] : []),
        source,
      ]);
      const output = await transformMedia(source, dir, {
        kind: "video",
        content_type: "video/mp4",
      });
      const info = await probe(output.file);
      assert.equal(
        info.streams.find((s) => s.codec_type === "video").codec_name,
        "h264",
      );
      assert.equal(
        Boolean(info.streams.find((s) => s.codec_type === "audio")),
        audio,
      );
      assert(output.duration <= 1.1 && output.bytes < 200 * 1024 ** 2);
      const bytes = await readFile(output.file);
      assert(
        bytes.indexOf(Buffer.from("moov")) < bytes.indexOf(Buffer.from("mdat")),
      );
      assert.equal((await sharp(output.thumbnail).metadata()).format, "jpeg");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
