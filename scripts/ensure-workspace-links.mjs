import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const workspacePackages = [
  { name: "@trackvault/shared", relDir: "packages/shared" },
  { name: "@trackvault/audio-tags", relDir: "packages/audio-tags" },
];

for (const pkg of workspacePackages) {
  const targetDir = path.resolve(rootDir, pkg.relDir);
  const linkDir = path.resolve(rootDir, "node_modules", ...pkg.name.split("/"));
  const pkgJsonPath = path.join(linkDir, "package.json");

  if (fs.existsSync(pkgJsonPath)) {
    continue;
  }

  fs.mkdirSync(path.dirname(linkDir), { recursive: true });

  try {
    fs.symlinkSync(targetDir, linkDir, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    // Fallback for Windows network/SMB shares (EPERM/ENOTSUP) where NTFS junctions/symlinks are unavailable.
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") {
      throw err;
    }
    fs.mkdirSync(linkDir, { recursive: true });
    const relDist = path
      .relative(linkDir, path.join(targetDir, "dist/index.js"))
      .split(path.sep)
      .join("/");
    fs.writeFileSync(
      pkgJsonPath,
      `${JSON.stringify(
        {
          name: pkg.name,
          version: "2.0.0",
          private: true,
          type: "module",
          exports: {
            ".": {
              types: "./index.d.ts",
              default: "./index.js",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(path.join(linkDir, "index.js"), `export * from "${relDist}";\n`);
    fs.writeFileSync(path.join(linkDir, "index.d.ts"), `export * from "${relDist}";\n`);
  }
}
