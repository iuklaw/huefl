// Sets the app's version everywhere it lives: package.json, Cargo.toml and
// tauri.conf.json (the one the updater compares). Usage:
//   node scripts/bump-version.mjs 0.2.0
// Then commit, tag v0.2.0 and push the tag — the Release workflow builds it.

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("Usage: node scripts/bump-version.mjs <major.minor.patch>");
  process.exit(1);
}

const json = (path, edit) => {
  const data = JSON.parse(readFileSync(path, "utf8"));
  edit(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};
json("package.json", (p) => (p.version = version));
json("src-tauri/tauri.conf.json", (c) => (c.version = version));

const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
// Only the [package] version (the first `version =` line).
writeFileSync("src-tauri/Cargo.toml", cargo.replace(/^version = ".*"$/m, `version = "${version}"`));

console.log(`Version set to ${version}. Next: git commit -am "release: v${version}" && git tag v${version} && git push --follow-tags`);
