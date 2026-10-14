/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />
//
// OpenList provider for Seanime
// ---------------------------------------------------------------------------
// Exposes an OpenList instance (https://github.com/OpenListTeam/OpenList) as a
// Seanime online-streaming provider: Seanime asks for an anime, this provider
// searches the OpenList directory tree for a matching folder, lists the video
// files inside it (episodes) and hands back a playable URL per episode.
//
// Playback URL = <openlist>/d/<path>?sign=...
// -> OpenList answers with an HTTP 302 to the real storage/CDN link, so the
//    media bytes never transit through the Seanime server.
//
// This file is loaded as a single, self-contained script (no imports).
// The class MUST be named `Provider`.

declare function $getUserPreference(key: string): any;

// ---------------------------------------------------------------------------
// Defaults (can all be overridden through the extension's user configuration)
// ---------------------------------------------------------------------------

const DEFAULTS: { [k: string]: string } = {
    baseUrl: "https://openlist.8w8.xyz",
    token: "",
    rootDir: "/",
    maxDepth: "3",
    minSizeMB: "5",
    videoExts: "mkv,mp4,avi,ts,m2ts,webm,mov,wmv,flv,vob,iso,rmvb",
    preferDirectLink: "false",
    includeSubtitles: "true",
    matchThreshold: "30",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    excludePatterns: "NCED,NCOP,Preview,PV,CM,Menu,Scan,Sample,Trailer,OP,ED,SP,Extra,Picture,Drama,特典,预告,菜单",
    debug: "false",
};

const TARGET_WIDTHS: number[] = [1080, 720, 480, 576, 2160, 1440, 360, 240];

function cfg(key: string, def: string): string {
    try {
        const v = $getUserPreference(key);
        if (v === undefined || v === null) return def;
        const s = "" + v;
        return s.trim() === "" ? def : s.trim();
    } catch (e) {
        return def;
    }
}

function cfgInt(key: string, def: number): number {
    const n = parseInt(cfg(key, "" + def), 10);
    return isNaN(n) ? def : n;
}

function cfgBool(key: string, def: boolean): boolean {
    return /^(1|true|yes|on)$/i.test(cfg(key, def ? "true" : "false"));
}

let DEBUG = false;
function dbg(...args: any[]) {
    if (!DEBUG) DEBUG = cfgBool("debug", false);
    if (DEBUG) console.log.apply(console, ["[openlist-provider]"].concat(args as any));
}

// ---------------------------------------------------------------------------
// Text helpers (full-width / half-width, tags, similarity)
// ---------------------------------------------------------------------------

// U+FF01..U+FF5E -> ASCII, U+3000 -> space. Implemented by hand so that it
// works even where String.prototype.normalize is unavailable.
function toHalfWidth(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0x3000) out += " ";
        else if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
        else out += s.charAt(i);
    }
    return out;
}

const TAG_RE = new RegExp(
    "(^|[^a-z0-9])(1080p|720p|480p|576p|2160p|1440p|4k|8bit|10bit|hi10p|x264|x265|h264|h265|hevc|avc|vp9|aac|flac|opus|ac3|eac3|dts|bluray|blu-ray|bdrip|bd|webrip|web-dl|webdl|web|hdtv|dvdrip|dvd|remux|repack|v2|v3|multi|dual|简繁|简日|繁日|内封|内嵌|外挂|字幕组|mkv|mp4|avi)([^a-z0-9]|$)",
    "gi"
);


function stripSeasonTag(s: string): string {
    return s
        .replace(/第\s*\d+\s*[季期部]/g, " ")
        .replace(/season\s*\d+/gi, " ")
        .replace(/\b\d+(st|nd|rd|th)\s*season\b/gi, " ")
        .replace(/\bs\s*\d+\b/gi, " ");
}

function norm(s: string): string {
    let x = toHalfWidth("" + (s === undefined || s === null ? "" : s)).toLowerCase();
    x = x.replace(/[\u200b-\u200f\ufeff]/g, "");
    x = x.replace(/\b(19|20)\d{2}\b/g, " ");
    x = x.replace(/\d{3,4}\s*p\b/g, " ");
    // Drop the bracket characters but keep their content: many libraries put
    // the actual title inside 【 】 or [ ].
    x = x.replace(/[\[\]\(\)（）【】「」『』{}]/g, " ");
    // TAG_RE has two capture groups (leading / trailing separator) - keep them.
    x = x.replace(TAG_RE, "$1 $2");
    x = stripSeasonTag(x);
    x = x.replace(/[^0-9a-z\u3040-\u30ff\u4e00-\u9fff]+/g, "");
    return x;
}

function seasonOf(s: string): number {
    const t = toHalfWidth(s).toLowerCase();
    const m =
        t.match(/season\s*(\d+)/) ||
        t.match(/第\s*(\d+)\s*[季期部]/) ||
        t.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/) ||
        t.match(/\bs\s*(\d{1,2})\b/) ||
        // trailing bare number, e.g. "Mairimashita! Iruma-kun 3"
        t.match(/[^0-9](\d{1,2})\s*$/);
    if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > 0 && n <= 12) return n;
    }
    return 0;
}

function bigrams(s: string): { [g: string]: boolean } {
    const set: { [g: string]: boolean } = {};
    const t = s.replace(/\s+/g, "");
    if (t.length <= 1) {
        if (t.length === 1) set[t] = true;
        return set;
    }
    for (let i = 0; i < t.length - 1; i++) set[t.substring(i, i + 2)] = true;
    return set;
}

function countKeys(o: { [g: string]: boolean }): number {
    let n = 0;
    for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++;
    return n;
}

// 0..100 similarity, tolerant to full/half-width, tags, punctuation.
function scoreOne(query: string, name: string): number {
    const q = norm(query);
    const n = norm(name);
    if (!q || !n) return 0;

    let score = 0;
    if (q === n) score = 100;
    else if (n.indexOf(q) === 0 || q.indexOf(n) === 0) score = 80 - Math.min(20, Math.abs(n.length - q.length));
    else if (n.indexOf(q) >= 0 || q.indexOf(n) >= 0) score = 70 - Math.min(20, Math.abs(n.length - q.length));
    else {
        const qb = bigrams(q);
        const nb = bigrams(n);
        let common = 0;
        for (const g in qb) if (Object.prototype.hasOwnProperty.call(qb, g) && nb[g]) common++;
        const denom = Math.min(countKeys(qb), countKeys(nb));
        score = denom > 0 ? Math.round((common / denom) * 60) : 0;
    }

    // Season mismatch is a strong negative signal: a "… 3rd Season" query must
    // not match the season-1 folder (a folder without any marker is season 1).
    const qs = seasonOf(query);
    const ns = seasonOf(name);
    if (qs > 0 && ns > 0 && qs !== ns) score -= 45;
    else if (qs > 1 && ns === 0) score -= 45;
    return score;
}

function bestScore(name: string, queries: string[]): number {
    let best = 0;
    for (let i = 0; i < queries.length; i++) {
        const s = scoreOne(queries[i], name);
        if (s > best) best = s;
    }
    return best;
}

// ---------------------------------------------------------------------------
// OpenList HTTP helpers
// ---------------------------------------------------------------------------

function apiBase(): string {
    let b = cfg("baseUrl", DEFAULTS.baseUrl);
    if (!/^https?:\/\//i.test(b)) b = "http://" + b;
    while (b.length > 1 && b.charAt(b.length - 1) === "/") b = b.substring(0, b.length - 1);
    return b;
}

function authHeaders(): { [k: string]: string } {
    const h: { [k: string]: string } = { "Content-Type": "application/json" };
    // Some instances sit behind Cloudflare, which rejects requests without a
    // User-Agent (error 1010).
    const ua = cfg("userAgent", DEFAULTS.userAgent);
    if (ua) h["User-Agent"] = ua;
    const token = cfg("token", "");
    if (token) h["Authorization"] = token;
    return h;
}


async function olApi(path: string, body: any): Promise<any> {
    const url = apiBase() + path;
    let res: any;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(body),
        });
    } catch (e) {
        throw new Error("OpenList request failed (" + path + "): " + e);
    }

    const text = await res.text();
    let json: any = null;
    try {
        json = JSON.parse(text);
    } catch (e) {
        json = null;
    }
    if (!json) {
        throw new Error("OpenList returned a non-JSON response (" + res.status + ") for " + path + ": " + text.substring(0, 120));
    }
    if (json.code !== 200) {
        throw new Error("OpenList error " + json.code + " on " + path + ": " + json.message);
    }
    return json.data;
}

interface OLObject {
    name: string;
    size: number;
    is_dir: boolean;
    sign?: string;
    type?: number;
    modified?: string;
}

async function listDir(path: string): Promise<OLObject[]> {
    const out: OLObject[] = [];
    let page = 1;
    for (;;) {
        const data = await olApi("/api/fs/list", {
            path: path,
            page: page,
            per_page: 0,
            refresh: false,
            password: "",
        });
        const content: OLObject[] = (data && data.content) || [];
        for (let i = 0; i < content.length; i++) out.push(content[i]);
        const total = data && typeof data.total === "number" ? data.total : out.length;
        if (content.length === 0 || out.length >= total) break;
        page++;
        if (page > 50) break;
    }
    return out;
}

function joinPath(parent: string, name: string): string {
    let p = parent || "/";
    if (p.charAt(p.length - 1) !== "/") p += "/";
    return p + name;
}

function encodePath(p: string): string {
    const parts = ("" + p).split("/");
    const enc: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        enc.push(i === 0 ? "" : encodeURIComponent(parts[i]));
    }
    return enc.join("/");
}

const VIDEO_EXT_CACHE: { [k: string]: boolean } = {};
function videoExts(): { [k: string]: boolean } {
    if (countKeys(VIDEO_EXT_CACHE) > 0) return VIDEO_EXT_CACHE;
    const list = cfg("videoExts", DEFAULTS.videoExts).split(",");
    for (let i = 0; i < list.length; i++) {
        const e = list[i].trim().toLowerCase().replace(/^\./, "");
        if (e) VIDEO_EXT_CACHE[e] = true;
    }
    return VIDEO_EXT_CACHE;
}

function extOf(name: string): string {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.substring(i + 1).toLowerCase() : "";
}

function isVideo(name: string): boolean {
    return !!videoExts()[extOf(name)];
}

function isSubtitle(name: string): boolean {
    const e = extOf(name);
    return e === "ass" || e === "ssa" || e === "srt" || e === "vtt" || e === "sub";
}

function minSizeBytes(): number {
    return cfgInt("minSizeMB", 5) * 1024 * 1024;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let EXTRA_RE: any = undefined;
function isExtraneous(name: string): boolean {
    if (EXTRA_RE === undefined) {
        const raw = cfg("excludePatterns", DEFAULTS.excludePatterns);
        const list = raw.split(",");
        const parts: string[] = [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i].trim();
            if (p) parts.push(escapeRe(p));
        }
        EXTRA_RE = parts.length
            ? new RegExp("(^|[^a-z0-9\\u3040-\\u30ff\\u4e00-\\u9fff])(" + parts.join("|") + ")([^a-z0-9\\u3040-\\u30ff\\u4e00-\\u9fff]|$)", "i")
            : null;
    }
    if (!EXTRA_RE) return false;
    return EXTRA_RE.test(toHalfWidth(name).replace(/\.[a-z0-9]{2,5}$/i, ""));
}


// ---------------------------------------------------------------------------
// Episode number parsing
// ---------------------------------------------------------------------------

const EP_PATTERNS: RegExp[] = [
    /(?:^|[^a-z0-9])e(?:p)?\.?\s*0*(\d{1,4})(?:v\d)?(?:[^0-9]|$)/i,
    /第\s*0*(\d{1,4})\s*(?:话|話|集|回)/,
    /[\[\(【]\s*0*(\d{1,4})\s*(?:v\d)?\s*[\]\)】]/,
    /(?:^|[\s._-])-\s*0*(\d{1,4})(?:v\d)?(?=[\s._\-\[\]\(]|$)/,
    /(?:^|[\s._\[])(?:episode|ep)\s*0*(\d{1,4})/i,
    /(?:^|[\s._-])0*(\d{1,4})(?:v\d)?(?=[\s._\]\)]|$)/,
];

function parseEpisodeNumber(fileName: string): number {
    // Normalize full-width digits/spaces first (第０１話 -> 第01話).
    const base = toHalfWidth(fileName).replace(/\.[a-z0-9]{2,5}$/i, "");

    for (let i = 0; i < EP_PATTERNS.length; i++) {
        const m = base.match(EP_PATTERNS[i]);
        if (!m || !m[1]) continue;

        // Make sure we did not grab a resolution / year / codec number.
        const idx = base.indexOf(m[0]);
        const tail = idx >= 0 ? base.substring(idx + m[0].length, idx + m[0].length + 2) : "";
        if (/^\s*p/i.test(tail)) continue; // 1080p, 720p ...

        const n = parseInt(m[1], 10);
        if (isNaN(n) || n <= 0 || n >= 3000) continue;
        if (TARGET_WIDTHS.indexOf(n) >= 0) continue;
        if (n >= 1900 && n <= 2100 && /\./.test(tail) === false && i === EP_PATTERNS.length - 1 && base.length - idx < 6) continue;
        return n;
    }
    return -1;
}

function resolutionOf(name: string): string {
    const m = name.match(/(\d{3,4})[pP]\b/);
    if (m) return m[1] + "p";
    if (/2160|4k/i.test(name)) return "2160p";
    return "";
}

interface EpisodeFile {
    name: string;
    path: string;
    size: number;
    number: number;
    resolution: string;
}

// Recursively collect candidate video files, applying the extension and
// minimum-size filters (ass / jpg / torrent / samples ... are dropped here).
async function collectVideos(dirPath: string, depth: number, maxDepth: number, acc: EpisodeFile[], seen: { [k: string]: boolean }) {
    if (depth > maxDepth) return;
    let entries: OLObject[] = [];
    try {
        entries = await listDir(dirPath);
    } catch (e) {
        dbg("cannot list " + dirPath + ": " + e);
        return;
    }

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const p = joinPath(dirPath, e.name);
        if (e.is_dir) {
            await collectVideos(p, depth + 1, maxDepth, acc, seen);
            continue;
        }
        if (!isVideo(e.name)) continue;
        if (isExtraneous(e.name)) {
            dbg("skip (extraneous): " + e.name);
            continue;
        }
        if (typeof e.size === "number" && e.size < minSizeBytes()) {
            dbg("skip (too small): " + e.name + " (" + e.size + " bytes)");
            continue;
        }
        if (seen[p]) continue;
        seen[p] = true;
        acc.push({
            name: e.name,
            path: p,
            size: typeof e.size === "number" ? e.size : 0,
            number: parseEpisodeNumber(e.name),
            resolution: resolutionOf(e.name),
        });
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class Provider {
    getSettings(): Settings {
        return {
            episodeServers: ["openlist"],
            supportsDub: false,
        };
    }

    private queries(opts: SearchOptions): string[] {
        const out: string[] = [];
        const push = (v: any) => {
            if (typeof v === "string" && v.trim().length > 0 && out.indexOf(v) < 0) out.push(v.trim());
        };
        push(opts && opts.query);
        const media: any = (opts && opts.media) || {};
        push(media.romajiTitle);
        push(media.englishTitle);
        if (media.synonyms && media.synonyms.length) {
            for (let i = 0; i < media.synonyms.length; i++) push(media.synonyms[i]);
        }
        dbg("search queries: " + JSON.stringify(out));
        return out;
    }

    // Search the OpenList root directory for folders matching the anime.
    async search(opts: SearchOptions): Promise<SearchResult[]> {
        DEBUG = cfgBool("debug", false);
        const root = cfg("rootDir", DEFAULTS.rootDir);
        const queries = this.queries(opts);
        if (queries.length === 0) return [];

        const entries = await listDir(root);
        const dirs: OLObject[] = [];
        const files: OLObject[] = [];
        for (let i = 0; i < entries.length; i++) (entries[i].is_dir ? dirs : files).push(entries[i]);

        const ranked: { name: string; score: number }[] = [];
        for (let i = 0; i < dirs.length; i++) {
            const s = bestScore(dirs[i].name, queries);
            if (s > 0) ranked.push({ name: dirs[i].name, score: s });
        }
        ranked.sort((a, b) => b.score - a.score);
        dbg("candidates: " + JSON.stringify(ranked.slice(0, 10)));

        const threshold = cfgInt("matchThreshold", 30);
        let picked = ranked.filter((r) => r.score >= threshold);
        // Relaxed fallback: only accept a single candidate that is close to the
        // threshold, so that a nonsense query never plays the wrong show.
        const relaxed = Math.max(20, threshold - 10);
        if (picked.length === 0 && ranked.length > 0 && ranked[0].score >= relaxed) picked = [ranked[0]];

        // The root directory itself may hold the episodes directly.
        if (picked.length === 0) {
            const videoFiles = files.filter((f) => isVideo(f.name));
            if (videoFiles.length > 0) {
                const s = bestScore("", queries); // 0, keep root as a last resort
                picked = [{ name: "", score: s }];
            }
        }

        const results: SearchResult[] = [];
        for (let i = 0; i < picked.length && i < 8; i++) {
            const dirName = picked[i].name;
            const path = dirName === "" ? root : joinPath(root, dirName);
            results.push({
                id: path,
                title: dirName === "" ? root : dirName,
                url: apiBase() + "/#/main?path=" + encodeURIComponent(path),
                subOrDub: "both",
            });
        }
        dbg("search results: " + JSON.stringify(results));
        return results;
    }

    // List the video files of a folder as episodes.
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        DEBUG = cfgBool("debug", false);
        const maxDepth = cfgInt("maxDepth", 3);
        const acc: EpisodeFile[] = [];
        await collectVideos(id, 0, maxDepth, acc, {});

        if (acc.length === 0) throw new Error("No video file found in " + id);

        // Sort by name (natural-ish) so that numbering by position is stable.
        acc.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

        const numbered: { [n: string]: EpisodeFile } = {};
        const unnumbered: EpisodeFile[] = [];
        for (let i = 0; i < acc.length; i++) {
            const f = acc[i];
            if (f.number > 0) {
                const key = "" + f.number;
                // Same episode, several files -> keep the biggest one.
                if (!numbered[key] || numbered[key].size < f.size) numbered[key] = f;
            } else {
                unnumbered.push(f);
            }
        }

        const nums = Object.keys(numbered).map((k) => parseInt(k, 10));
        nums.sort((a, b) => a - b);

        const episodes: EpisodeDetails[] = [];
        if (nums.length === 0) {
            // Nothing parsed: fall back to positional numbering.
            for (let i = 0; i < acc.length; i++) {
                episodes.push(this.episode(acc[i], i + 1));
            }
        } else {
            for (let i = 0; i < nums.length; i++) {
                episodes.push(this.episode(numbered["" + nums[i]], nums[i]));
            }
            // Unnumbered leftovers: append after the last parsed episode.
            let n = nums[nums.length - 1] + 1;
            for (let i = 0; i < unnumbered.length; i++) {
                episodes.push(this.episode(unnumbered[i], n));
                n++;
            }
        }
        dbg("episodes: " + episodes.map((e) => e.id).join(", "));
        return episodes;
    }

    private episode(f: EpisodeFile, number: number): EpisodeDetails {
        return {
            id: "" + number + "||" + f.path,
            number: number,
            url: apiBase() + "/#/main?path=" + encodeURIComponent(f.path),
            // Keep the original OpenList file name so full-width / special
            // characters are displayed as-is.
            title: f.name,
        };
    }

    private parseId(id: string): string {
        const i = ("" + id).indexOf("||");
        return i >= 0 ? id.substring(i + 2) : id;
    }

    // Resolve a playable URL for the episode.
    // -> <openlist>/d/<path>?sign=...   (OpenList replies with a 302 redirect)
    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        DEBUG = cfgBool("debug", false);
        const path = this.parseId(episode && episode.id ? episode.id : "");

        const data = await olApi("/api/fs/get", { path: path });
        const name = (data && data.name) || path.substring(path.lastIndexOf("/") + 1);
        const sign = (data && data.sign) || "";
        const rawUrl = (data && data.raw_url) || "";
        const size = data && typeof data.size === "number" ? data.size : 0;

        const signQuery = sign ? "?sign=" + sign : "";
        const redirectUrl = apiBase() + "/d" + encodePath(path) + signQuery;
        dbg("redirect url: " + redirectUrl);
        dbg("raw url: " + rawUrl);

        const headers: { [k: string]: string } = {};
        const headerStr = (data && data.header) || "";
        if (headerStr) {
            const lines = ("" + headerStr).split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const m = lines[i].match(/^\s*([A-Za-z0-9-]+)\s*:\s*(.+?)\s*$/);
                if (m) headers[m[1]] = m[2];
            }
        }

        const quality = resolutionOf(name);
        const type: VideoSourceType = extOf(name) === "mp4" ? "mp4" : "unknown";

        const subtitleList: VideoSubtitle[] = [];
        if (cfgBool("includeSubtitles", true)) {
            try {
                const parent = path.substring(0, path.lastIndexOf("/")) || "/";
                const siblings = await listDir(parent);
                const base = name.replace(/\.[a-z0-9]{2,5}$/i, "");
                for (let i = 0; i < siblings.length && subtitleList.length < 8; i++) {
                    const s = siblings[i];
                    if (s.is_dir || !isSubtitle(s.name)) continue;
                    const sBase = s.name.replace(/\.[a-z0-9]{2,5}$/i, "");
                    const related =
                        sBase.indexOf(base) === 0 ||
                        base.indexOf(sBase) === 0 ||
                        (episode.number > 0 && new RegExp("(^|[^0-9])0*" + episode.number + "([^0-9]|$)").test(sBase));
                    if (!related) continue;
                    subtitleList.push({
                        id: "" + subtitleList.length,
                        url: apiBase() + "/d" + encodePath(joinPath(parent, s.name)) + (s.sign ? "?sign=" + s.sign : ""),
                        language: /chs|sc|简/i.test(s.name) ? "zh-Hans" : /cht|tc|繁/i.test(s.name) ? "zh-Hant" : /jp|jap|日/i.test(s.name) ? "ja" : "und",
                        isDefault: subtitleList.length === 0,
                    });
                }
            } catch (e) {
                dbg("subtitle lookup failed: " + e);
            }
        }

        const sources: VideoSource[] = [
            {
                url: redirectUrl,
                type: type,
                quality: quality ? quality : "OpenList",
                label: "302",
                subtitles: subtitleList,
            },
        ];

        // Optional: hand over the raw storage/CDN link instead of the OpenList
        // redirect endpoint.
        if (cfgBool("preferDirectLink", false) && rawUrl) {
            sources.push({
                url: rawUrl,
                type: type,
                quality: (quality ? quality : "OpenList") + " - direct",
                label: "direct",
                subtitles: subtitleList,
            });
        }
        dbg("video sources: " + JSON.stringify(sources));

        // Keep `size` referenced for debugging purposes only.
        if (size > 0) dbg("file size: " + size);

        return {
            server: "openlist",
            headers: headers,
            videoSources: sources,
        };
    }
}
