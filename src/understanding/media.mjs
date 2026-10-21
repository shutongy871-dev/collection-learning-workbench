import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { mkdir, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
export const execute = promisify(execFile);
export const fail = (code, detail) => Object.assign(new Error(code), { code, detail });
export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function inspectMedia(path, config) {
  if (typeof path !== "string" || !path || /^[a-z][a-z\d+.-]*:/i.test(path)) throw fail("local_media_required");
  const file = await realpath(resolve(path));
  const info = await stat(file);
  if (!info.isFile() || info.size <= 0 || info.size > config.maxMediaBytes) throw fail("media_size_limit");
  let result;
  try {
    result = await execute(config.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe",
      "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json", file],
    { timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch { throw fail("media_probe_failed"); }
  const data = JSON.parse(result.stdout);
  const durationMs = Math.round(Number(data.format?.duration) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw fail("media_duration_unknown");
  if (durationMs > config.maxDurationMs) throw fail("duration_limit");
  return { path: file, hash: await hashFile(file), size: info.size, durationMs,
    hasAudio: data.streams?.some(s => s.codec_type === "audio") ?? false,
    hasVideo: data.streams?.some(s => s.codec_type === "video") ?? false };
}
export async function extractAudio(asset, directory, config) {
  if (!asset.hasAudio) throw fail("no_audio_track");
  await mkdir(directory, { recursive: true });
  const audio = join(directory, "audio.wav");
  try {
    await execute(config.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-protocol_whitelist", "file,pipe", "-i", asset.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audio],
    { timeout: 120_000, maxBuffer: 1024 * 1024 });
  } catch { throw fail("audio_extraction_failed"); }
  return audio;
}
/** 均匀覆盖整个时长；上限限制采样密度，不把稀疏帧宣称为完整视频理解。 */
export function frameTimes(durationMs, maxFrames = 6, intervalMs = 15000) {
  if (!(durationMs > 0) || !Number.isInteger(maxFrames) || maxFrames < 1 || !(intervalMs > 0))
    throw fail("invalid_frame_settings");
  const count = Math.min(maxFrames, Math.max(1, Math.ceil(durationMs / intervalMs)), durationMs);
  return Array.from({ length: count }, (_, i) => Math.min(durationMs - 1, Math.floor((i + .5) * durationMs / count)));
}
export async function extractFrames(asset, directory, config) {
  if (!asset.hasVideo) throw fail("no_video_track");
  await mkdir(directory, { recursive: true });
  const frames = [];
  for (const [i, timestampMs] of frameTimes(asset.durationMs, config.maxFrames, config.frameIntervalMs).entries()) {
    const path = join(directory, `frame-${i + 1}.jpg`);
    try {
      await execute(config.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-protocol_whitelist", "file,pipe", "-ss", String(timestampMs / 1000), "-i", asset.path,
        "-frames:v", "1", "-vf", "scale=768:768:force_original_aspect_ratio=decrease", "-q:v", "3", path],
      { timeout: 30_000, maxBuffer: 1024 * 1024 });
      const size = (await stat(path)).size;
      if (!size || size > 1024 * 1024) throw fail("frame_size_limit");
    } catch { throw fail("frame_extraction_failed"); }
    frames.push({ id: `frame-${i + 1}`, timestampMs, path, hash: await hashFile(path) });
  }
  return frames;
}
