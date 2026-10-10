import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProjectAndNotifyToRun } from "./buildSource";
import { getMemoryEvents, resetEventSink } from "../../../events/sink";

for (const exitCode of [0, 1]) {
  test(`manual build emits progress and a terminal result when the build exits ${exitCode}`, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lovable-build-progress-"));
    const dir = path.join(base, "test");
    const oldShared = process.env.SHARED_DIR;
    const oldEval = process.env.EVAL_MODE;
    process.env.SHARED_DIR = base;
    process.env.EVAL_MODE = "1";
    resetEventSink();
    try {
      fs.mkdirSync(path.join(dir, "node_modules", "vite"), { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: `bun -e "process.exit(${exitCode})"` } }));
      expect(await buildProjectAndNotifyToRun("test", "job-test")).toBe(exitCode === 0);
      const types = getMemoryEvents()
        .filter(event => event.event === "agent.sse.message")
        .map(event => event.metadata?.type);
      expect(types).toEqual(["build_started", "building", exitCode === 0 ? "build_success" : "build_failed"]);
    } finally {
      if (oldShared === undefined) delete process.env.SHARED_DIR; else process.env.SHARED_DIR = oldShared;
      if (oldEval === undefined) delete process.env.EVAL_MODE; else process.env.EVAL_MODE = oldEval;
      resetEventSink();
      // Only remove the isolated directory created by this test.
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}
