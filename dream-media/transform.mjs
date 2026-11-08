import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export class InvalidMedia extends Error {
  constructor(code = "INVALID_MEDIA") {
    super(code);
    this.code = code;
  }
}
export function run(command, args, timeout = 120_000, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cancel = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    let output = "",
      bytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("PROCESSING_TIMEOUT"));
    }, timeout);
    child.stdout.on("data", (data) => {
      bytes += data.length;
      if (bytes > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
        reject(new Error("PROBE_TOO_LARGE"));
      } else output += data;
    });
    child.stderr.resume(); // Decoder messages can contain private metadata. Never log them.
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      code === 0
        ? resolve(output)
        : reject(
            signal?.aborted
              ? new Error("PROCESSING_CANCELLED")
              : new InvalidMedia(),
          );
    });
  });
}
export async function probe(file, signal) {
  return JSON.parse(
    await run(
      process.env.FFPROBE_PATH || "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        file,
      ],
      120_000,
      signal,
    ),
  );
}
export function validateVideo(info, header) {
  const brand = header.subarray(8, 12).toString("ascii");
  const duration = Number(info.format?.duration),
    video = info.streams?.find(
      (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
    );
  if (
    header.subarray(4, 8).toString("ascii") !== "ftyp" ||
    ![
      "isom",
      "iso2",
      "iso3",
      "iso4",
      "iso5",
      "iso6",
      "mp41",
      "mp42",
      "avc1",
      "dash",
      "M4V ",
    ].includes(brand) ||
    !info.format?.format_name?.split(",").includes("mp4") ||
    !video ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 3600 ||
    !video.width ||
    !video.height ||
    video.width * video.height > 34_000_000
  )
    throw new InvalidMedia(
      duration > 3600 ? "VIDEO_TOO_LONG" : "INVALID_MEDIA",
    );
  return { duration, video };
}
export async function transformMedia(source, directory, attachment, signal) {
  if (attachment.kind === "image") {
    const input = sharp(source, {
      limitInputPixels: 268_402_689,
      failOn: "warning",
    });
    const metadata = await input.metadata().catch(() => {
      throw new InvalidMedia();
    });
    if (
      !["jpeg", "png"].includes(metadata.format) ||
      (metadata.pages ?? 1) > 1 ||
      (attachment.content_type === "image/png") !== (metadata.format === "png")
    )
      throw new InvalidMedia();
    const file = join(directory, "media.jpg"),
      thumbnail = join(directory, "thumbnail.jpg");
    const result = await input
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({
        width: 2048,
        height: 2048,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80, mozjpeg: true })
      .toFile(file);
    await sharp(file)
      .resize({
        width: 480,
        height: 480,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 75 })
      .toFile(thumbnail);
    return {
      file,
      thumbnail,
      bytes: result.size,
      width: result.width,
      height: result.height,
      duration: null,
    };
  }
  const handle = await open(source, "r");
  const header = Buffer.alloc(32);
  try {
    await handle.read(header, 0, 32, 0);
  } finally {
    await handle.close();
  }
  const { duration, video: inputVideo } = validateVideo(
    await probe(source, signal),
    header,
  );
  const file = join(directory, "media.mp4"),
    thumbnail = join(directory, "thumbnail.jpg");
  const target = Math.min(160 * 1024 ** 2, (await stat(source)).size * 0.9);
  const bitrate = Math.max(
    150_000,
    Math.min(2_500_000, Math.floor((target * 8) / duration - 96_000)),
  );
  const video = [
    "-map",
    `0:${inputVideo.index ?? 0}`,
    "-vf",
    "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    String(bitrate),
    "-threads",
    "2",
    "-passlogfile",
    join(directory, "pass"),
  ];
  const input = [
    "-y",
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    source,
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
  ];
  await run(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      ...input,
      ...video,
      "-pass",
      "1",
      "-an",
      "-f",
      "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ],
    7_200_000,
    signal,
  );
  await run(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      ...input,
      ...video,
      "-pass",
      "2",
      "-map",
      "0:a:0?",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      file,
    ],
    7_200_000,
    signal,
  );
  const output = await probe(file, signal),
    bytes = (await stat(file)).size,
    stream = output.streams.find((s) => s.codec_type === "video");
  if (
    bytes > 200 * 1024 ** 2 ||
    !stream ||
    Number(output.format.duration) > 3600.1
  )
    throw new InvalidMedia();
  await run(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=480:-2",
      join(directory, "frame.png"),
    ],
    120_000,
    signal,
  );
  await sharp(join(directory, "frame.png"))
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 75 })
    .toFile(thumbnail);
  return {
    file,
    thumbnail,
    bytes,
    width: stream.width,
    height: stream.height,
    duration: Number(output.format.duration),
  };
}
