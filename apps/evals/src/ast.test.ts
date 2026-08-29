import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { analyzeProject, matchAstCheck, type AstIndex } from "./ast";

let tmp: string;
function fixture(files: Record<string, string>): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ast-test-"));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
    }
    return tmp;
}

afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const WELL_COMPOSED = {
    "src/App.tsx": `
import React, { useState } from "react";
import { BarChart } from "recharts";
export function Card({ title }: { title: string }) { return <div>{title}</div>; }
export function Dashboard() {
  const [x, setX] = useState(0);
  return (
    <div>
      <Card title="hi" />
      <BarChart data={[]} />
    </div>
  );
}
`,
};

describe("ast:render composition checks", () => {
    let index: AstIndex;
    beforeAll(async () => {
        index = await analyzeProject(fixture(WELL_COMPOSED));
    });

    test("single-arg render: some component renders child", () => {
        expect(matchAstCheck(index, "ast:render:Card").passed).toBe(true);
        expect(matchAstCheck(index, "ast:render:BarChart").passed).toBe(true);
        expect(matchAstCheck(index, "ast:render:Missing").passed).toBe(false);
    });

    test("two-arg render: parent composes child", () => {
        const ok = matchAstCheck(index, "ast:render:Dashboard:Card");
        expect(ok.passed).toBe(true);
        expect(matchAstCheck(index, "ast:render:Dashboard:BarChart").passed).toBe(true);
    });

    test("renders by the wrong parent fail", () => {
        expect(matchAstCheck(index, "ast:render:Card:Dashboard").passed).toBe(false);
        expect(matchAstCheck(index, "ast:render:Card:BarChart").passed).toBe(false);
    });
});

describe("ast:hook top-level checks", () => {
    test("hook called at top level of a component body passes", async () => {
        const index = await analyzeProject(fixture(WELL_COMPOSED));
        expect(matchAstCheck(index, "ast:hook:useState:top").passed).toBe(true);
    });

    test("hook nested inside a handler is NOT top-level", async () => {
        const index = await analyzeProject(
            fixture({
                "src/App.tsx": `
import React from "react";
export function Bad() {
  return <button onClick={() => { const [y, setY] = React.useState(0); return y; }}>x</button>;
}
`,
            }),
        );
        expect(matchAstCheck(index, "ast:hook:useState:top").passed).toBe(false);
    });

    test("missing hook fails", async () => {
        const index = await analyzeProject(
            fixture({ "src/App.tsx": `export function Nada() { return <div/>; }` }),
        );
        expect(matchAstCheck(index, "ast:hook:useState").passed).toBe(false);
    });
});

describe("basic ast checks still work", () => {
    test("import and jsx presence", async () => {
        const index = await analyzeProject(fixture(WELL_COMPOSED));
        expect(matchAstCheck(index, "ast:import:recharts").passed).toBe(true);
        expect(matchAstCheck(index, "ast:jsx:BarChart").passed).toBe(true);
        expect(matchAstCheck(index, "ast:component:Card").passed).toBe(true);
    });

    test("empty index returns failed, not crash", () => {
        const r = matchAstCheck(undefined, "ast:jsx:Foo");
        expect(r.passed).toBe(false);
        expect(r.detail).toBeTruthy();
    });
});
