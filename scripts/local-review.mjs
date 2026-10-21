import { readFile, mkdir } from "node:fs/promises";
import { connect, watch, trigger, finishPages, collect, unique, save, dir } from "./local-scan.mjs";

const { page } = await connect();
const capture = watch(page);
const snapshot = JSON.parse(await readFile(dir + "snapshot.json"));
const review = JSON.parse(await readFile(dir + "review-groups.json"));
const assigned = new Set(Object.values(review.groups).flat());
await trigger(page, "/aweme/listcollection/", () => page.goto(
  "https://www.douyin.com/user/self?showTab=favorite_collection&showSubTab=video",
  { waitUntil: "domcontentloaded" }
));
const pages = await finishPages(page, capture, "/aweme/listcollection/",
  () => collect(capture.records, "/aweme/listcollection/"));
await save("review-favorites.json", { at: new Date().toISOString(), pages, items: unique(pages, "items") });
await mkdir(dir + "review", { recursive: true });
for (const [index, item] of snapshot.unclassified.entries()) {
  if (assigned.has(index)) continue;
  const card = page.locator("li:visible").filter({ has: page.locator(`a[href*="/${item.id}"]`) });
  await card.screenshot({ path: `${dir}review/${index}.png` });
  console.log(JSON.stringify({ screenshot: index, id: item.id }));
}
capture.stop();
process.exit();
