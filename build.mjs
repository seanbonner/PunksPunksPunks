#!/usr/bin/env node
// Zero-dependency build: injects the committed data cache into src/index.html
// and copies static assets into _site/. No live fetches, no npm install needed,
// so the Cloudflare Pages build command is just `node build.mjs`.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "_site");
const DATA = join(ROOT, "_data", "cached", "hub.json");

if (!existsSync(DATA)) {
  console.error(`missing ${DATA}; run \`npm run sync-data\` first`);
  process.exit(1);
}

// Escape "</" so the JSON can't close the inline <script> early.
const data = readFileSync(DATA, "utf8").trim().replace(/<\//g, "<\\/");
const html = readFileSync(join(ROOT, "src", "index.html"), "utf8");
if (!html.includes("__HUB_DATA__")) throw new Error("src/index.html is missing the __HUB_DATA__ placeholder");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "index.html"), html.replace("__HUB_DATA__", data));
cpSync(join(ROOT, "images"), join(OUT, "images"), { recursive: true });
for (const f of ["favicon.svg", "favicon.ico", "favicon-32.png", "favicon-16.png", "apple-touch-icon.png", "icon-512.png"]) {
  cpSync(join(ROOT, f), join(OUT, f));
}
console.log(`built ${join(OUT, "index.html")}`);
