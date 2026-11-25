import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { usePlayerStore } from "../features/player/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..");

function collectTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function extractImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(importRegex)) {
    const spec = match[1];
    if (spec) specs.push(spec);
  }
  return specs;
}

describe("FSD architectural boundaries & player store invariants", () => {
  it("shared/ has zero reverse imports from entities/, features/, widgets/, pages/, or app/", () => {
    const files = collectTsFiles(path.join(SRC_ROOT, "shared"));
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const spec of extractImportSpecifiers(content)) {
        if (!spec.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        const relFromSrc = path.relative(SRC_ROOT, resolved).replace(/\\/g, "/");
        const topLayer = relFromSrc.split("/")[0];
        if (topLayer && ["entities", "features", "widgets", "pages", "app"].includes(topLayer)) {
          violations.push(`${path.relative(SRC_ROOT, file)} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("entities/ has zero reverse imports from features/, widgets/, pages/, or app/", () => {
    const files = collectTsFiles(path.join(SRC_ROOT, "entities"));
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const spec of extractImportSpecifiers(content)) {
        if (!spec.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        const relFromSrc = path.relative(SRC_ROOT, resolved).replace(/\\/g, "/");
        const topLayer = relFromSrc.split("/")[0];
        if (topLayer && ["features", "widgets", "pages", "app"].includes(topLayer)) {
          violations.push(`${path.relative(SRC_ROOT, file)} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("features/ has zero reverse imports from widgets/, pages/, or app/", () => {
    const files = collectTsFiles(path.join(SRC_ROOT, "features"));
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const spec of extractImportSpecifiers(content)) {
        if (!spec.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        const relFromSrc = path.relative(SRC_ROOT, resolved).replace(/\\/g, "/");
        const topLayer = relFromSrc.split("/")[0];
        if (topLayer && ["widgets", "pages", "app"].includes(topLayer)) {
          violations.push(`${path.relative(SRC_ROOT, file)} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("pages/ and widgets/ import features only through module Public API index.ts", () => {
    const targetFiles = [
      ...collectTsFiles(path.join(SRC_ROOT, "pages")),
      ...collectTsFiles(path.join(SRC_ROOT, "widgets")),
    ];
    expect(targetFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of targetFiles) {
      const content = fs.readFileSync(file, "utf8");
      for (const spec of extractImportSpecifiers(content)) {
        if (!spec.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), spec).replace(/\.js$/, "");
        const relFromSrc = path.relative(SRC_ROOT, resolved).replace(/\\/g, "/");
        if (relFromSrc.startsWith("features/")) {
          const segments = relFromSrc.split("/");
          // Must be features/<feature>/index
          if (segments.length !== 3 || segments[2] !== "index") {
            violations.push(`${path.relative(SRC_ROOT, file)} -> ${spec}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("usePlayerStore does not expose raw unpersisted queue mutation methods", () => {
    const storeState = usePlayerStore.getState() as unknown as Record<string, unknown>;
    expect(storeState.addToQueue).toBeUndefined();
    expect(storeState.insertNextInQueue).toBeUndefined();
    expect(storeState.removeFromQueue).toBeUndefined();
    expect(storeState.clearQueue).toBeUndefined();
  });
});
