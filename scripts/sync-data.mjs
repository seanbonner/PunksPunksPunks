#!/usr/bin/env node
// Builds the hub's committed data cache from its sibling repos, following the
// family rule: sync into a committed cache, never fetch a sibling at build time.
//
// Reads:
//   ../BurnedPunks/punks/*.md          burned registry frontmatter + narrative
//   ../MuseumPunks/punks/*.md          museum registry frontmatter + narrative
//   ../MuseumPunks/institutions/*.md   institution names
//   ../LostPunks/_data/cached/*        the same snapshot lostpunks.com builds from
//   ../LostPunks/_data/labels.js       vault labels (LostPunks excludes vaults by default)
//
// Writes _data/cached/hub.json. Re-run after the monthly refresh:
//   npm run sync-data
//
// The sibling root is found by walking up from this repo until a directory
// holding BurnedPunks/, MuseumPunks/ and LostPunks/ appears, so the hub works
// as PunkSites/PunksPunksPunks or nested deeper. PUNKSITES_ROOT overrides it.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CACHE = join(ROOT, "_data", "cached");
const SIBLINGS = ["BurnedPunks", "MuseumPunks", "LostPunks"];

function findSiblingRoot() {
  if (process.env.PUNKSITES_ROOT) return resolve(process.env.PUNKSITES_ROOT);
  let dir = resolve(ROOT, "..");
  for (let i = 0; i < 5; i++) {
    if (SIBLINGS.every((s) => existsSync(join(dir, s)))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const SITES = findSiblingRoot();
if (!SITES) {
  console.error(`expected sibling repos (${SIBLINGS.join(", ")}) above ${ROOT}`);
  process.exit(1);
}

// Minimal frontmatter reader: the registries use flat `key: value` pairs only.
function readMd(path) {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`no frontmatter in ${path}`);
  const data = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (/^".*"$/.test(val)) val = val.slice(1, -1);
    if (val === "true") val = true;
    else if (val === "false") val = false;
    data[key] = val;
  }
  return { data, body: m[2].trim() };
}

// First paragraph of a narrative, markdown links flattened, cut at a sentence.
function excerpt(body, max = 230) {
  let p = body.split(/\n\s*\n/)[0] || "";
  p = p.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_]/g, "").replace(/\s+/g, " ").trim();
  if (p.length <= max) return p;
  const cut = p.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "));
  return end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
}

function mdFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
}

console.log(`syncing from ${SITES}:`);

// Burned registry (V2 tokens).
const burned = {};
for (const path of mdFiles(join(SITES, "BurnedPunks", "punks"))) {
  const { data, body } = readMd(path);
  if (data.id == null) continue;
  burned[String(data.id)] = {
    date: data.burn_date,
    intent: data.intent,
    excerpt: excerpt(body),
  };
}
console.log(`  BurnedPunks: ${Object.keys(burned).length} punks`);

// Museum registry.
const institutions = {};
for (const path of mdFiles(join(SITES, "MuseumPunks", "institutions"))) {
  const { data } = readMd(path);
  institutions[data.slug] = data.name;
}
const museum = {};
for (const path of mdFiles(join(SITES, "MuseumPunks", "punks"))) {
  const { data, body } = readMd(path);
  if (data.id == null) continue;
  museum[String(data.id)] = {
    institution: data.institution,
    type: data.acquisition_type,
    acquired: data.acquired || null,
    donor: data.donor_name || null,
    v1Held: data.v1_held === true,
    excerpt: excerpt(body),
  };
}
console.log(`  MuseumPunks: ${Object.keys(museum).length} punks, ${Object.keys(institutions).length} institutions`);

// LostPunks snapshot, scored the way LostPunks search scores it by default:
// burned excluded from V2 only, known vaults excluded, never-outbound wallets
// treated as silent.
const LP = join(SITES, "LostPunks", "_data");
const holders = JSON.parse(readFileSync(join(LP, "cached", "holders.json"), "utf8"));
const { syncedAt } = JSON.parse(readFileSync(join(LP, "cached", "synced-at.json"), "utf8"));
const labels = (await import(pathToFileURL(join(LP, "labels.js")).href)).default;
const vaults = new Set(
  Object.entries(labels)
    .filter(([, v]) => typeof v === "object" && v?.vault === true)
    .map(([k]) => k.toLowerCase())
);
const wallets = {};
for (const line of readFileSync(join(LP, "cached", "wallets-activity.jsonl"), "utf8").split("\n")) {
  if (!line) continue;
  const r = JSON.parse(line);
  wallets[r.address] = r.lastOutboundTs ?? null;
}

const YEAR = 365.25 * 86400;
const THRESHOLD = 5;
const now = syncedAt; // score against the snapshot moment, not the hub's build time
const years = (ts) => Math.round(((now - ts) / YEAR) * 10) / 10;

// Per contract, one compact string per id: "moved|silent|flag" where silent is
// "n" for a wallet that has never sent, and flag is L (possibly lost),
// V (known vault), or - (neither). Empty string = no snapshot record.
const lost = { v1: new Array(10000).fill(""), v2: new Array(10000).fill("") };
const counts = { v1: 0, v2: 0 };
const cutoff = now - THRESHOLD * YEAR;
for (const c of ["v1", "v2"]) {
  // Walk every key, not just 0–9999: the V1 archive also holds a few
  // out-of-range ids, and the counts must match LostPunks' own search.
  for (const [idStr, h] of Object.entries(holders[c])) {
    const id = Number(idStr);
    const wts = wallets[h.holder];
    const vault = vaults.has(String(h.holder).toLowerCase());
    const isBurned = c === "v2" && Boolean(burned[idStr]);
    // Compare exact timestamps (as LostPunks does), not the rounded display years.
    const isLost = !isBurned && !vault && h.lastMoveTs <= cutoff && (wts == null || wts <= cutoff);
    if (isLost) counts[c]++;
    if (Number.isInteger(id) && id >= 0 && id < 10000) {
      const silent = wts == null ? "n" : years(wts);
      lost[c][id] = `${years(h.lastMoveTs)}|${silent}|${isLost ? "L" : vault ? "V" : "-"}`;
    }
  }
}
console.log(`  LostPunks snapshot ${new Date(syncedAt * 1000).toISOString().slice(0, 10)}: ${counts.v2} V2 / ${counts.v1} V1 possibly lost at ${THRESHOLD}y/${THRESHOLD}y`);

mkdirSync(CACHE, { recursive: true });
writeFileSync(
  join(CACHE, "hub.json"),
  JSON.stringify({ syncedAt, threshold: THRESHOLD, burned, museum, institutions, counts, lost }) + "\n"
);
console.log(`  → ${join(CACHE, "hub.json")}`);
console.log("done.");
