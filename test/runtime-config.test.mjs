import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { macLaunchAgent } from "../scripts/runtime-config.mjs";

test("macOS启动日志避开受保护的项目目录，XML路径转义与任务配置保持有效", { skip: process.platform !== "darwin" }, async t => {
  await mkdir(resolve(".data"), { recursive: true });
  const dir = await mkdtemp(resolve(".data/launch-config-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const userDir = "/Users/example & 测试";
  const node = "/opt/runtime/node";
  for (const folder of ["Desktop", "Documents"]) {
    const root = `${userDir}/${folder}/收藏 & 学习`;
    const file = join(dir, `${folder}.plist`);
    await writeFile(file, macLaunchAgent(root, node, { HOME: userDir, PATH: "/usr/bin", SECRET_TEST: "must-not-leak" }));
    execFileSync("/usr/bin/plutil", ["-lint", file]);
    const config = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
    assert.equal(config.StandardOutPath, `${userDir}/Library/Logs/collection-tidy-agent/daily.log`);
    assert.equal(config.StandardErrorPath, config.StandardOutPath);
    assert.equal(config.WorkingDirectory, root);
    assert.deepEqual(config.ProgramArguments, [node, `${root}/scripts/daily.mjs`, "--tick"]);
    assert.deepEqual(config.StartCalendarInterval, { Hour: 9, Minute: 0 });
    assert.equal(config.StartInterval, 60);
    assert.equal(config.RunAtLoad, true);
    assert.equal(config.EnvironmentVariables.SECRET_TEST, undefined);
  }
});
