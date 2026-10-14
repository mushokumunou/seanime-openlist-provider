// Offline test harness for the OpenList Seanime provider.
//
// It runs the plugin source through the *same* esbuild transform Seanime uses
// (Loader: ts, target: es2018), instantiates the provider the same way Seanime
// does (`new Provider()`), and exercises search / findEpisodes / findEpisodeServer
// against a real OpenList instance.
//
// Usage:
//   OL_BASE=http://127.0.0.1:5244 OL_TOKEN=<api token> \
//   node dev/harness.mjs
//
// Optional env vars:
//   OL_ROOT      directory on OpenList that holds the show folders (default /ol/anime)
//   PLUGIN_TS    path to the provider source (default ../openlist-provider.ts)
//   ESBUILD      path to the esbuild JS entry (default: resolve "esbuild" from node_modules)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = process.env.PLUGIN_TS || join(HERE, "..", "openlist-provider.ts");
const OL_BASE = process.env.OL_BASE || "http://127.0.0.1:5244";
const OL_TOKEN = process.env.OL_TOKEN || "";
const OL_ROOT = process.env.OL_ROOT || "/ol/anime";

let src = readFileSync(PLUGIN, "utf8");
let transformed = false;
try {
    const esbuildPath = process.env.ESBUILD || "esbuild";
    const esbuild = await import(esbuildPath.startsWith("/") ? esbuildPath : esbuildPath);
    const out = esbuild.transformSync(src, {
        target: "es2018",
        loader: "ts",
        minifyWhitespace: true,
        minifySyntax: true,
        sourcemap: false,
    });
    if (out.errors && out.errors.length) throw new Error(JSON.stringify(out.errors));
    src = out.code;
    transformed = true;
} catch (e) {
    console.log("[harness] esbuild transform unavailable, running raw source:", e.message);
}

function loadProvider(config) {
    globalThis.$getUserPreference = (k) => (Object.prototype.hasOwnProperty.call(config, k) ? config[k] : undefined);
    const Provider = new Function(src + "\n;return Provider;")();
    return new Provider();
}

const BASE_CONFIG = {
    baseUrl: OL_BASE,
    token: OL_TOKEN,
    rootDir: OL_ROOT,
    maxDepth: "3",
    minSizeMB: "0",
    includeSubtitles: "true",
    preferDirectLink: "false",
    matchThreshold: "30",
    debug: "false",
};

let failures = 0;
function check(name, cond, extra) {
    if (cond) {
        console.log("  PASS  " + name);
    } else {
        failures++;
        console.log("  FAIL  " + name + (extra !== undefined ? "  ->  " + JSON.stringify(extra) : ""));
    }
}

console.log("=== provider source:", resolve(PLUGIN), "| esbuild transform:", transformed, "===");
console.log("=== OpenList:", OL_BASE, "| root:", OL_ROOT, "===");

// ---------------------------------------------------------------- getSettings
{
    const s = loadProvider(BASE_CONFIG).getSettings();
    check("getSettings returns episodeServers", Array.isArray(s.episodeServers) && s.episodeServers.length > 0, s);
}

// ------------------------------------------------------------- search + files
let firstEpisode = null;
let firstDir = null;
{
    const p = loadProvider(BASE_CONFIG);
    const listing = await p.search({ media: { id: 1, romajiTitle: "", synonyms: [], isAdult: false }, query: process.env.OL_QUERY || "Sousou no Frieren", dub: false, year: 0 });
    console.log("  [search]", process.env.OL_QUERY || "Sousou no Frieren", "->", JSON.stringify(listing.map((r) => r.title)));
    check("search returns at least one folder", listing.length > 0, listing);
    if (listing.length > 0) {
        firstDir = listing[0].id;
        const eps = await p.findEpisodes(firstDir);
        console.log("  [episodes]", JSON.stringify(eps.map((e) => [e.number, e.title])));
        check("episodes parsed", eps.length > 0, eps);
        check("episode numbers are positive integers", eps.every((e) => Number.isInteger(e.number) && e.number > 0), eps.map((e) => e.number));
        check("no junk extensions in episodes", eps.every((e) => !/\.(jpg|png|torrent|ass|srt|nfo)$/i.test(e.title)), eps.map((e) => e.title));
        check("no extras (OP/ED/NCED/Preview/Sample) in episodes", eps.every((e) => !/(^|[^a-z0-9])(OP|ED|NCED|NCOP|Preview|PV|CM|Menu|Scan|Sample|Trailer|SP)([^a-z0-9]|$)/i.test(e.title)), eps.map((e) => e.title));
        check("episode ids carry the OpenList path", eps[0].id.indexOf("||/") > 0, eps[0].id);
        firstEpisode = eps[0];
    }

    const miss = await p.search({ media: { id: 2, romajiTitle: "Unit Test No Such Show 12345", synonyms: [], isAdult: false }, query: "Unit Test No Such Show 12345", dub: false, year: 0 });
    check("unrelated search returns nothing", miss.length === 0, miss);
}

// ------------------------------------------------------------ size filtering
{
    const p = loadProvider(Object.assign({}, BASE_CONFIG, { minSizeMB: "100000" }));
    let threw = false;
    try {
        await p.findEpisodes(firstDir);
    } catch (e) {
        threw = true;
    }
    check("minSizeMB filter drops everything above the real file size", threw);
}

// ------------------------------------------------------------ episode server
if (firstEpisode) {
    const p = loadProvider(BASE_CONFIG);
    const server = await p.findEpisodeServer(firstEpisode, "default");
    console.log("  [server]", JSON.stringify(server));
    check("server name is openlist", server.server === "openlist", server.server);
    check("at least one video source", server.videoSources.length >= 1, server.videoSources);

    const url = server.videoSources[0].url;
    check("video source points at the /d/ endpoint", url.indexOf(OL_BASE + "/d/") === 0, url);

    const res = await fetch(url, { redirect: "manual" });
    const loc = res.headers.get("location");
    console.log("  [http] GET", url, "->", res.status, loc ? "Location: " + loc : "");
    check("playback url answers 2xx/3xx (302 on non-proxy storages)", res.status >= 200 && res.status < 400, res.status);

    const range = await fetch(url, { headers: { Range: "bytes=0-1023" }, redirect: "manual" });
    console.log("  [http] Range request ->", range.status);
    check("range request works (seek/remux)", range.status === 200 || range.status === 206 || range.status === 302, range.status);

    const direct = loadProvider(Object.assign({}, BASE_CONFIG, { preferDirectLink: "true" }));
    const server2 = await direct.findEpisodeServer(firstEpisode, "default");
    check("preferDirectLink exposes a second source", server2.videoSources.length === 2, server2.videoSources.map((s) => s.label));
}

console.log("\n=== " + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + " ===");
process.exit(failures === 0 ? 0 : 1);
