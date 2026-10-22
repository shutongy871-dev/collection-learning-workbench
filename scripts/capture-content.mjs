// 只通过正常页面播放器读取当前可访问媒体；不构造平台私有接口、不绕过登录/内容限制。
import { chromium } from "playwright-core";
import { parseArgs } from "node:util";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "./daily.mjs";
import { openSelfPage } from "./local-scan.mjs";
import { readJSON, atomicJSON, digest } from "../src/understanding/pipeline.mjs";
import { contentConfig, loadContentEnv } from "../src/understanding/config.mjs";
import { inspectMedia, execute, fail } from "../src/understanding/media.mjs";
import { routeContent } from "../src/understanding/route.mjs";
import { browserLaunchOptions, reuseBackgroundBrowser } from "./browser-session.mjs";
import { recordAccountLogin, recordAccountFailure } from "./account-status.mjs";

export function commentsFromResponse(data, sourceUrl, collectedAt = new Date().toISOString()) {
  if (data?.status_code !== 0 || !Array.isArray(data.comments)) return null;
  return [...new Map(data.comments.filter(c => typeof c.cid === "string" && typeof c.text === "string" && c.text.trim())
    .map(c => [c.cid, { id: c.cid, text: c.text.trim().slice(0, 2000), sourceUrl, collectedAt }])).values()].slice(0, 30);
}

async function download(url, path, sourceUrl, config) {
  const response = await fetch(url, { headers: { Referer: sourceUrl, Range: "bytes=0-" }, signal: AbortSignal.timeout(120000) });
  if (!response.ok || !/video|audio|octet-stream/.test(response.headers.get("content-type") || "")) throw fail("media_download_failed");
  const length = Number(response.headers.get("content-length"));
  const range = response.headers.get("content-range");
  if (range && !/^bytes 0-\d+\/\d+$/.test(range)) throw fail("partial_media_response");
  if (length > config.maxMediaBytes) { await response.body.cancel(); throw fail("media_size_limit"); }
  const handle = await open(path, "w", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > config.maxMediaBytes) throw fail("media_size_limit");
      await handle.write(chunk);
    }
    if ((length && bytes !== length) || (range && bytes !== Number(range.split("/")[1]))) throw fail("partial_media_response");
  } catch (e) { await unlink(path).catch(() => {}); throw e; }
  finally { await handle.close(); }
  return inspectMedia(path, config);
}

export async function captureContent({ item, dataDir, config }) {
  const browserDir = join(dataDir, "local-browser"), dailyDir = join(dataDir, "daily");
  await mkdir(dailyDir, { recursive: true });
  await mkdir(browserDir, { recursive: true });
  const dailyLock = await acquireLock(join(dailyDir, "execution.lock"));
  if (!dailyLock) throw fail("browser_busy");
  let localLock, browser, context, page, ownContext = false;
  try {
    localLock = await acquireLock(join(browserDir, "execution.lock"));
    if (!localLock) throw fail("browser_busy");
    const session = await reuseBackgroundBrowser(browserDir, { timeout: 3000 });
    browser = session?.browser;
    if (browser) context = browser.contexts()[0];
    else {
      context = await chromium.launchPersistentContext(join(browserDir, "profile"), browserLaunchOptions());
      ownContext = true;
    }
    if (!context) throw fail("browser_context_missing");
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    const self = await openSelfPage(page, { folders: false, expectedAccountId: item.accountId });
    self.capture.stop();
    await recordAccountLogin(dataDir, self.account, item.accountId);
    const sourceUrl = `https://www.douyin.com/video/${encodeURIComponent(item.id)}`;
    const observedMedia = new Map();
    let capturedComments = null, finishComments;
    const commentsReady = new Promise(r => { finishComments = r; });
    const settleComments = async () => {
      let timer;
      try { await Promise.race([commentsReady, new Promise(r => { timer = setTimeout(r, 10000); })]); }
      finally { clearTimeout(timer); }
      return { comments: capturedComments ?? [], commentsStatus: capturedComments ? "visible_page_response" : "not_available" };
    };
    page.on("response", response => {
      const type = response.headers()["content-type"] || "";
      if (/^(?:video|audio)\//i.test(type) && response.status() < 400)
        observedMedia.set(response.url(), { type, bytes: Number(response.headers()["content-length"]) || null });
      const url = new URL(response.url());
      if (url.hostname === "www.douyin.com" && url.pathname.endsWith("/comment/list/") &&
          url.searchParams.get("aweme_id") === item.id && capturedComments === null) {
        void response.json().then(data => {
          const comments = commentsFromResponse(data, sourceUrl);
          if (comments !== null && capturedComments === null) { capturedComments = comments; finishComments(); }
        }).catch(() => {});
      }
    });
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const directory = join(dataDir, "content-media", digest(item.key));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (routeContent(item).route === "entertainment") {
      const comments = await settleComments();
      await atomicJSON(join(directory, "input.json"), { itemKey: item.key, sourceUrl,
        capturedAt: new Date().toISOString(), ...comments, acquisition: "visible_page_metadata" });
      return { input: join(directory, "input.json"), mediaBytes: 0, comments: comments.comments.length };
    }
    await page.locator("video").first().waitFor({ state: "attached", timeout: 30000 });
    await page.waitForFunction(() => [...document.querySelectorAll("video")].some(v => v.readyState >= 1 && v.duration > 0),
      null, { timeout: 30000 });
    const media = await page.locator("video").first().evaluate(v => ({
      src: v.currentSrc, durationMs: Math.round(v.duration * 1000)
    }));
    const urls = /^https:\/\//.test(media.src) ? [media.src] : [...observedMedia.keys()];
    if (!urls.length || urls.length > 2) throw fail("player_media_ambiguous", { candidates: [...observedMedia.values()] });
    if (!Number.isFinite(media.durationMs) || media.durationMs > config.maxDurationMs) throw fail("duration_limit");
    const temp = join(directory, "video.part");
    const parts = [];
    for (const [i, url] of urls.entries()) {
      const part = await download(url, join(directory, `part-${i}.mp4`), sourceUrl, config);
      if (Math.abs(part.durationMs - media.durationMs) > 2000) throw fail("incomplete_media_download");
      parts.push(part);
    }
    if (parts.length === 1 && parts[0].hasVideo) await rename(parts[0].path, temp);
    else {
      const audio = parts.filter(p => p.hasAudio && !p.hasVideo), video = parts.filter(p => p.hasVideo && !p.hasAudio);
      if (audio.length !== 1 || video.length !== 1) throw fail("player_media_ambiguous", {
        tracks: parts.map(p => ({ hasAudio: p.hasAudio, hasVideo: p.hasVideo, durationMs: p.durationMs }))
      });
      await execute(config.ffmpeg, ["-nostdin", "-v", "error", "-y", "-i", video[0].path, "-i", audio[0].path,
        "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-f", "mp4", temp], { timeout: 120000 });
      for (const part of parts) await unlink(part.path);
    }
    const asset = await inspectMedia(temp, config);
    if (Math.abs(asset.durationMs - media.durationMs) > 2000) throw fail("incomplete_media_download");
    const mediaPath = join(directory, `${asset.hash}.mp4`);
    await rename(temp, mediaPath);
    const manifest = { itemKey: item.key, mediaPath, sourceUrl, capturedAt: new Date().toISOString(),
      mediaHash: asset.hash, durationMs: asset.durationMs, ...await settleComments(), acquisition: "visible_player" };
    await atomicJSON(join(directory, "input.json"), manifest);
    return { input: join(directory, "input.json"), durationMs: asset.durationMs, mediaBytes: asset.size };
  } catch (error) {
    await recordAccountFailure(dataDir, error);
    throw error;
  } finally {
    if (ownContext) await context?.close().catch(() => {});
    else { await page?.close().catch(() => {}); await browser?.close().catch(() => {}); }
    await localLock?.release();
    await dailyLock.release();
  }
}
async function main() {
  const { values } = parseArgs({ options: { item: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) return console.log("npm run content:capture -- --item <视频ID或学习键>（读取专用浏览器登录状态，只下载正常播放器可访问的媒体）");
  loadContentEnv();
  const dataDir = resolve(process.env.LEARNING_DATA_DIR || ".data");
  const state = await readJSON(join(dataDir, "learning/state.json"));
  const items = state.items.filter(i => values.item && (i.id === values.item || i.key === values.item));
  if (items.length !== 1) throw fail("single_item_required");
  console.log(JSON.stringify(await captureContent({ item: items[0], dataDir, config: contentConfig() }), null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(e.code || "capture_failed", e.detail || ""); process.exitCode = 1;
});
