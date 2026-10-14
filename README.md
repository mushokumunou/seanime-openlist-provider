# OpenList provider for Seanime

An **online-streaming provider** extension that turns an [OpenList](https://github.com/OpenListTeam/OpenList)
instance (115 / Aliyun Drive / Baidu / Quark / local …) into a Seanime video source.

Seanime searches your OpenList directory tree for the show it wants, this extension lists the
video files of the matching folder as episodes and hands Seanime a playable URL per episode:

```
<OpenList>/d/<path>?sign=…
```

OpenList answers that URL with an **HTTP 302** pointing at the real storage/CDN link (115 CDN,
Aliyun OSS, …), so the media bytes go straight from the storage to your player — the Seanime
server is never used as a relay.

```
Seanime (goja VM)                OpenList                       storage
  search(query)     --POST /api/fs/list-->  directory listing
  findEpisodes(id)  --POST /api/fs/list-->  files -> episodes
  findEpisodeServer --POST /api/fs/get ---> file + sign
        |
        v
  videoSource url = <OpenList>/d/<path>?sign=…     (handed to Seanime's player)
        client  --GET /d/…-->  OpenList  --302-->  115 CDN  ---> client player
```

---

## Files

| File | Purpose |
| --- | --- |
| `openlist-provider.json` | Extension manifest (type `onlinestream-provider`) + user settings + permissions |
| `openlist-provider.ts` | The provider implementation (single self-contained file, class must be `Provider`) |
| `harness.mjs` | Local test harness (runs the provider against a real OpenList, no Seanime required) |

Requires Seanime **3.x** with online-streaming extensions support (developed and verified against
3.10.3).

---

## Install

### Option A — local files (what you asked for)

1. Copy `openlist-provider.json` and `openlist-provider.ts` to a folder you keep, e.g.
   `/opt/seanime-extensions/openlist-provider/`.
2. Put **only the manifest** inside Seanime's extensions directory
   (`<data-dir>/extensions/`, e.g. `/opt/seanime/extensions/`):
   ```bash
   cp openlist-provider.json /path/to/seanime-data/extensions/
   ```
3. Open `openlist-provider.json` and set `payloadURI` to the **absolute path** of the `.ts` file:
   ```json
   "payloadURI": "/opt/seanime-extensions/openlist-provider/openlist-provider.ts",
   "isDevelopment": true
   ```
   `isDevelopment: true` + an absolute `payloadURI` makes Seanime read the code from disk, which is
   what you want while iterating (edit the file, then *Reload extensions*).
4. Restart Seanime (or use **Reload extensions** in the UI). The server log should show:
   ```
   extensions > Loaded payload from file id=openlist-provider
   extensions > Loaded external extension id=openlist-provider
   ```

### Option B — install from GitHub (recommended)

Nothing to copy by hand. In Seanime open **Extensions → Install** and paste the manifest URL:

```
https://raw.githubusercontent.com/mushokumunou/seanime-openlist-provider/main/openlist-provider.json
```

Seanime downloads the manifest, fetches the payload from `payloadURI` and registers the provider.
Updates are picked up by re-installing / reloading the extension.

(The same works for any static host: keep `payloadURI` pointing at the hosted `.ts` and leave out
`"isDevelopment": true`.)

---

## Configure

Extensions → **OpenList** → configure (values are stored per extension, and are also visible to
the provider at runtime):

| Setting | Default | Notes |
| --- | --- | --- |
| `OpenList URL` | *(your instance)* | e.g. `https://openlist.example.com`, no trailing slash |
| `OpenList API token` | *(empty)* | Optional. OpenList → Profile → API token. Sent as the `Authorization` header. Leave empty if your instance allows guest access |
| `Root directory` | `/` | The directory that contains your show folders, e.g. `/115/anime` |
| `Scan depth` | `3` | How many folder levels to walk inside a show folder (`Season 1/…`) |
| `Min video size (MB)` | `5` | Filters samples, previews and stray small files |
| `Video extensions` | `mkv,mp4,avi,ts,m2ts,webm,mov,wmv,flv,vob,iso,rmvb` | `ass/srt/jpg/png/torrent/nfo/…` are always ignored |
| `Expose raw link too` | off | Adds the raw storage/CDN URL as a second video source (bypasses OpenList) |
| `Attach sidecar subtitles` | on | `.ass/.ssa/.srt` files next to the video are exposed as subtitle tracks |
| `Match strictness` | `30` | 0–100. Lower it if a show is not found, raise it if the wrong folder matches |
| `User-Agent` | Chrome UA | Some instances (Cloudflare) reject requests without a User-Agent (error 1010) |
| `Extra patterns` | `NCED,NCOP,Preview,PV,CM,Menu,Scan,Sample,Trailer,OP,ED,SP,Extra,Picture,Drama,特典,预告,菜单` | Word-boundary patterns that mark a file as "not an episode" (OP/ED, menus, samples, picture dramas …). Empty = disable |
| `Debug logging` | off | Provider traces in the server console (`[openlist-provider] …`) |

**Playback:** pick the provider on the entry page → *Online streaming*, or set it as the default
provider in *Settings → Playback → Default episode source*.

---

## Directory / naming rules

* **Layout:** `<RootDirectory>/<Show folder>/…video files`. Any nesting below that is walked up to
  `Scan depth` (so `Show/Season 2/Show - 13.mkv` works).
* **Filtering:** only configured video extensions, and only files ≥ `Min video size`.
  `.ass`, `.jpg`, `.torrent`, `nfo`, samples and other junk never show up as episodes, and
  extras (`OP`/`ED`/`NCED`/`Preview`/`Menu`/`Picture Drama`/…) are dropped by the
  `Extra patterns` list.
* **Episode numbers** are parsed from the file name, in this order: `E01`/`EP01`, `第01话`,
  `[01]`, ` - 01`, `Episode 01`, then a bare number. `1080p`, `720p` and year numbers are rejected.
  `02v2` → episode 2. When one episode has several files (different qualities), the biggest file
  wins. If nothing can be parsed, files are numbered 1…N in name order.
* **Names are kept verbatim** — half-width and full-width characters, CJK, `【】`, `　`, `.`,
  `&`, `+`, brackets, etc. are shown exactly as they are on OpenList (JSON is UTF-8 all the way,
  and paths are percent-encoded only when building the URL). Episode *titles* come from Seanime's
  own metadata (AniZip/TheTVDB) — that is Seanime's normal behaviour for providers.
* **Search matching** is Unicode-tolerant: full-width text is folded to half-width, release tags
  (`1080p`, `BDRip`, `HEVC`, `v2`, `简繁`, …), brackets and punctuation are ignored, season markers
  are compared separately (a `Season 2` query will not match a `Season 1` folder), and a
  bigram-overlap score is used for everything that is not an exact/substring match.

---

## True 302: OpenList side

The extension can only be as "direct" as your OpenList setup. For real 302 streaming:

* Keep **Web Proxy / use proxy URL OFF** for the storage (`WebDAV policy = 302_redirect`,
  `Web Proxy = false`). With web proxy on, OpenList streams the file itself (`/p/…`) — that is a
  normal relay, not a 302. (Some drivers, e.g. `Local`, *must* proxy by design — that is expected.)
* Leave **Sign / SignAll** on (default): the extension reads the per-file `sign` value from
  `/api/fs/get` and puts it in the URL, so signed-link instances work out of the box.
* Drives that hand out IP/UA-bound links (sometimes 115) are OpenList's business: it re-requests a
  fresh link on every `/d/` hit, which is why the extension plays through `/d/…` and not through a
  pre-fetched raw link. If a driver still refuses to 302, enable *Expose raw link too* and switch
  video source in the player, or turn on web proxy for that storage.

---

## Verify it yourself

```bash
# 1. provider is registered (no login required)
curl -s http://<seanime>:43211/api/v1/extensions/list/onlinestream-provider

# 2. search inside Seanime
curl -s -X POST http://<seanime>:43211/api/v1/onlinestream/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Sousou no Frieren","provider":"openlist-provider","dub":false}'

# 3. playable URL for episode 1 of AniList media 154587
curl -s -X POST http://<seanime>:43211/api/v1/onlinestream/episode-source \
  -H 'Content-Type: application/json' \
  -d '{"mediaId":154587,"episodeNumber":1,"provider":"openlist-provider","dubbed":false}'

# 4. the URL above must answer 302 (or 206 for a range request) — check with:
curl -sI "<the /d/ url from step 3>"
```

Without Seanime (offline logic test against a live OpenList):

```bash
# create a test OpenList storage first, then:
OL_BASE=http://127.0.0.1:5244 node harness.mjs
```

The harness runs the source through the *same* esbuild transform Seanime uses
(`LoaderTS`, `target: es2018`), instantiates `Provider` the same way
(`new Provider()`), and asserts search / episode parsing / filtering / URL building.

---

## Verified

Tested against **Seanime 3.10.3** (official Linux release) + **OpenList v4.2.6** with a real
**115 Cloud** storage:

| Step | Result |
| --- | --- |
| Extension load | `extensions > Loaded payload from file/external extension id=openlist-provider` |
| Provider registered in Seanime's goja VM | `GET /api/v1/extensions/list/onlinestream-provider` → `episodeServers: ["openlist"]` |
| `search` (inside Seanime) | returned the real show folders of the OpenList instance |
| `findEpisodes` (inside Seanime) | a 21-episode BDRip season → episodes 1…21 with the original file names, `OP`/`ED`/menu PNGs excluded |
| `findEpisodeServer` | `https://<openlist>/d/%5BReinForce%5D … S3 01 (…).mkv?sign=…` |
| Playback URL | `HTTP/2 302` → `Location: https://cdnfhnfile.115cdn.net/…` → `206 Partial Content` (range/seek OK) |

In other words: Seanime asks, this extension answers with an OpenList URL, OpenList redirects to the
115 CDN, and the player pulls the bytes straight from the CDN — the Seanime server only exchanges a
few KB of JSON.

## Troubleshooting

* **"Failed to load user config"** in the log — normal until you save the settings once in the UI.
  The provider falls back to the defaults in the meantime.
* **No results** — check `Root directory`, raise `Scan depth`, lower `Match strictness`, and enable
  debug logging to see the scored candidates.
* **Browser playback fails but mpv works** — browsers block cross-origin media reads (CORS), and
  Seanime's player needs to read MKV headers. Set OpenList's CORS allowed origins to include the
  Seanime origin, or prefer a player that is not sandboxed by CORS (mpv / desktop app).
* **401 from OpenList** — paste a valid API token (or enable guest access on OpenList).
* **New files are invisible** — OpenList caches listings for `cache_expiration` seconds
  (default 30 s); refresh the directory in OpenList's UI.
