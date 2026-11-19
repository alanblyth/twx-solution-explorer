# Solution Explorer at scale: performance report

Measured 18 and 19 November 2026 on a throwaway ThingWorx 10.2.1 platform (`twx-test`) holding 100,000 Things, 40 extension packages and 40 projects. Nothing was imported to twx-dev; the platform was reset afterwards.

## Summary

| # | Finding | Effect | Fix | Effort |
|-|-|-|-|-|
| 1 | `GetIncomingDependencies` and `GetOutgoingDependencies` return at most **500 rows** unless `maxItems` is passed; the app passes `{}` | The base template with 100,000 Things shows 500 users and no warning. Every scan undercounts above 500 | Pass `maxItems`, say "showing N of M", page the lists | 0.5–1 day |
| 2 | The Entities search lists `?maxItems=20000` | 80,188 of 100,188 Things can never be found | Read the whole collection (100k rows: 15.5 MB, 0.3–0.5 s) and warn at the cap; `nameMask` only for prefixes | 0.5 day |
| 3 | A project scan reads every member's full JSON for script analysis; 99% of each body is `effectiveShape` (233 built-in service definitions) and Tomcat does not compress | Biggest project (16,455 entities): **45 s, 32,952 requests, 3.6 GB** in the harness; 67.5 s in the browser | Skip the body when calls are off or the member cannot hold scripts of its own; turn on gzip (10x smaller); cache bodies across tabs | 1–2 days, plus 1 hour of platform configuration |
| 4 | dagre runs on the main thread, and compound (grouped) layout grows steeply | 16,456 nodes: **114 s** frozen page. A synthetic 2,000 nodes in 80 groups: **54 minutes** | Web worker with cancel; node cap with a summary view above it | 2–3 days |
| 5 | The project scan with "Show what uses it" drove the platform container to 4.3 GB; in one of three runs the JVM was killed and the platform restarted | Platform outage on a small host (Docker VM 7.75 GB, twx-dev also running) | Fewer, smaller requests (findings 3 and 6); size the platform for 100k Things | see 3 |
| 6 | Per-entity dependency calls are cheap on the server (p50 1.5–1.8 ms) but there are 16,455 of each | Most of a big scan's time is client-side overhead and transfer, not platform work | Batching through a read-only service is possible but runs on System's rights; prefer findings 3 and 1 first | 2–4 days if done |
| 7 | The app scans all extensions on every load, whatever `StartTab` says | 525 extra requests (0.2–1.9 s) when the page opens on the Entities or Projects tab | Start the tab signal from `StartTab` | **done**: no extension request when the page opens on another tab |
| 8 | Basic authentication costs the platform **199 ms per request**; the session cookie 1.6 ms | `tools/dev_server.py` sent Basic on every call: an extension scan took 35 s instead of 0.5 s | Fixed here: the dev proxy reuses the session cookie | done |

What scales well: the Extensions scan (610 requests, 0.15–0.21 s), the service trace (depth 8: 2,721 tree nodes from 52 requests in 0.5–0.9 s), listing collections, and opening an entity (0.10–0.13 s, 475 ms in the browser).

## Environment

| Item | Value |
|-|-|
| Platform | ThingWorx 10.2.1-b148, PostgreSQL 17.9, Tomcat 11.0.27, Corretto 21, `linux/amd64` under emulation on Apple silicon (10 cores) |
| JVM | `-Xms2g -Xmx4g` (the builder's default; heap in use never passed 1.93 GB) |
| Host | Docker VM with 7.75 GB, shared with the running twx-dev stack (about 2 GB) |
| Browser | The desktop app's built-in Chromium pane (hidden during the runs), against `tools/dev_server.py` |
| Data | `tools/perf/generate_environment.py`, seed 20261118 |

The emulated platform is slower per request than a native one, so treat absolute server times as an upper bound; the request counts, bytes and browser-side times do not depend on it.

### What was generated

- **40 extension packages** `LabPerfE00`…`E39` in 5 layers of 8. `dependsOn` names 1–3 packages of the layer below, sometimes one further down (75 links in the extension graph). 520 entities: per package 2 data shapes, 2 Thing shapes, 3 templates, 4 service Things (4 scripted services each) and 2 mashups.
- **Inheritance across packages:** each package's `Device` template derives from a dependency's `Device`, so chains are up to 5 templates deep (for example `E33 → E30 → E23 → E09 → E00 → GenericThing`); `Controller` derives from the package's own `Sensor` and implements a dependency's shape.
- **Scripts** call other packages' services by static name, string constant, local helper function, `me`, and names built at run time, inside `if`, `try` and `for`.
- **40 projects** `Lab.Perf.P00`…`P39`, created at run time (a shipped project is locked, notes section 7). Package Exx's entities name project Pxx.
- **100,000 Things** spread over the projects with a Zipf-like weight: P00 holds 16,456 entities, then 9,493, 6,858 … down to 865. All are on `Lab.Perf.E00.TT.Device`, the root of every chain, because `GetIncomingDependencies` lists direct instances only (a probe: template A ← template B ← Thing T: A lists B, not T). That gives one entity with 100,000 incoming dependencies, and every project except P00 references a template in another project. `--hub-share` spreads them over all 120 templates instead (every template was checked to accept Things).

Two generator bugs that the platform reports only once a Thing exists, both fixed and now in the notes' pattern: a template chain that meets the same property name twice (two shapes with `temperature`), and a chain that implements the same shape twice, each fail with "A Name Conflict Has Been Detected" on the first Thing, while the templates import with a 200.

### Creating 100,000 Things

| Method (1,000-Thing trial) | Time | Rate |
|-|-|-|
| Batch service `Lab.Perf.Loader.CreateThings`, 250 per call (create, enable, restart) | 3.2 s, 0.9 s per call | 312 Things/s |
| `ImportSourceControlledEntities` (JSON written into `SystemRepository` with `docker cp`) | 3.0 s | 337 Things/s |

Import was faster, so the 100,000 were imported in 20 calls of 5,000: **200 s** in all, 6.5–8.0 s per call (no 30-second limit applies: it is not a script). Imported Things arrive enabled, in the named project, on the named template. `docker cp` of a folder into an existing folder merges the contents and takes over the folder's owner, so the generator creates the target first and copies `<folder>/.` into it.

## Results per scenario

Harness: `tools/perf/measure.py`, which replays the app's requests at its concurrency (limits 4, 6 and 8, capped at the browser's 6 connections per host) over keep-alive connections with the session cookie. Runs 2 and 3 complete, run 1 for the scenarios before its layout step, run 4 after the restart. Browser: the app's own `se:*` measures (see "In-browser timings").

### Listing collections (Entities tab search)

| Request | Rows | Bytes | Time |
|-|-|-|-|
| `Things?maxItems=20000` (what the app sends) | **20,000 (capped)** | 3.1 MB | 57–147 ms |
| `Things?maxItems=200000` | 100,188 | 15.5 MB | 270–500 ms |
| `Things?nameMask=Lab.Perf.P05.T*` | 500 (its default `maxItems`) | 78 kB | 31–40 ms |
| `Things?nameMask=` a mask that matches nothing | 0 | 0.7 kB | 80–150 ms (scans all names) |
| Templates, shapes, data shapes, mashups, projects | 42–484 | 8–91 kB | 1–5 ms each |

### Opening an entity

| Entity | Requests | Bytes | Harness | Browser |
|-|-|-|-|-|
| The hub template (100,000 incoming) as the app asks | 14 | about 1 MB | 0.10–0.13 s | 475 ms, **shows 500** |
| The hub with `maxItems: 200000` | 8 | 14.9 MB | 0.17–0.20 s (incoming alone 112–144 ms, 100,001 rows, 14.2 MB) | not run |
| A Thing, a 6-level chained template | 7 each | 0.7–1 MB | under 0.05 s | 154 ms (service Thing `E32.Svc.0`) |

The app reads the entity body twice when opening it (the resolver keeps its own cache apart from the tab's), at about 230 kB a time.

### Scanning all extensions

610 requests (1 list, 42 package reads, 42 `GetExtensionPackageDetails`, 525 `GetOutgoingDependencies`), 0.6 MB, **0.15–0.21 s** in the harness; `GetOutgoingDependencies` p50 0.8–1.0 ms. In the browser 0.55–1.9 s, with layout of the 42-node graph 11–57 ms and render 4 ms. The scan does not depend on the 100,000 Things: extension members are only the 520 shipped entities.

### Scanning the biggest project (P00, 16,455 entities)

| | Harness, calls on (default) | Harness, calls on + "Show what uses it" | Browser, default |
|-|-|-|-|
| Time | **44.1–46.2 s** (run 1: 45.5 s) | 47.0–48.7 s; **run 3: platform killed at 40.8 s** | scan 67.5 s, graph build 0.23 s, **layout 114 s**, render 1.2 s |
| Requests | 32,952 | 49,407 | same pattern |
| Bytes received | **3.6 GB** | 3.6 GB | same pattern |
| Entity GET (body for script analysis) | p50 7.5–8.1 ms, p95 13.5–16 ms | same | |
| `GetOutgoingDependencies` / `GetIncomingDependencies` | p50 1.6–1.8 ms, p95 3.2–3.7 ms | p50 1.5 ms | |
| Platform CPU (of 1,000%) | mean 243–256%, peak 270–321% | mean 246–276%, peak 329% | |
| PostgreSQL CPU | peak 84% | peak 67–69% | |
| JVM heap in use | peak 1.45–1.90 GB | peak 1.91–1.93 GB | |
| Platform container memory | peak 3.8–4.3 GB | peak 3.6–4.3 GB | |

Reading the other 39 projects' members (84,108 rows in 41 `GetEntities` calls) took 0.03–0.10 s. Script analysis in the browser took 3 ms in all, because the 16,451 Things have no scripts of their own: every one of the 3.6 GB was read for nothing.

The run-3 failure: the platform container was restarted by Docker at 00:18:57 (restart count 1). No `hs_err` file, no log line and Docker's `OOMKilled` false (the container has no memory limit), with 0.9–1.3 GB left in the VM afterwards: most likely the VM's kernel OOM killer stopping the JVM. Restarting with 100,000 Things took about 45 s; nothing was lost. The application log otherwise held no ERROR lines from any scenario (one scheduled audit-export error at midnight is unrelated).

Smaller projects in the browser:

| Project | Members | Scan | Graph nodes | Layout | Render |
|-|-|-|-|-|-|
| P38 | 864 | 3.8 s | 869 (1 group) | 175 ms | 43 ms |
| P12 | 2,099 | 8.7 s | 2,104 (1 group) | 5.7 s | 0.5 s |
| P00 | 16,455 | 67.5 s | 16,456 (1 group) | 114 s | 1.2 s |

The browser scans run through the dev proxy (a new upstream connection per request), which explains most of the gap to the harness's 45 s.

### Tracing a service (`Lab.Perf.E32.Svc.0.Run`)

| Depth | Requests | Bytes | Tree | Harness (node, the app's resolver) | Browser |
|-|-|-|-|-|-|
| 4 | 37 | 8.3 MB | 158 nodes, 1 level of `limit` leaves | 0.5–0.9 s | 712 ms; call graph 73 nodes, layout 65 ms, render 47 ms |
| 8 | 52 | 11.7 MB | 2,721 nodes (1.4 MB as JSON) | 0.55–0.74 s | 306 ms after depth 4 (cached bodies); call graph 124 nodes, layout 168 ms, render 40 ms |

The resolver's cache keeps requests nearly flat as the tree grows 17-fold. Each body is about 230 kB, so bytes, not requests, set the cost. The script is re-parsed for every tree node (1,410 parses at depth 8 in under 0.1 s), which is cheap at this size. One harness trace in run 3 hit the restarting platform (36 s); it is left out of the ranges.

### Layout (dagre)

| Graph | Browser | Node 26 |
|-|-|-|
| 500 nodes, no groups | 386 ms | 197 ms |
| 500 nodes in 20 groups (synthetic, cross-group links) | **7.3 s** | 6.6 s |
| 2,000 nodes, no groups | 13.1 s | |
| 2,000 nodes in 80 groups | **3,219,582 ms (54 min)** | did not finish 3 runs in 60 min |
| Real container graphs (1 group) | 869 nodes 175 ms; 2,104 nodes 5.7 s; 16,456 nodes 114 s | |

The synthetic graph (`perf-graph.ts`) groups 25 nodes per owner with links across groups, like a container scan with "Group by owner" off. The page is frozen for the whole layout: `javascript_tool` calls to the page timed out while dagre ran.

## Shared entity cache and Thing dependencies from the body (19 November 2026)

Fix 3's second option, built on `feature/shared-entity-cache`: `TwxApi.entity` keeps one least-recently-used cache of 300 bodies for every view (Reload on the Entities tab clears it), and a project scan with "Include script calls" on takes each Thing's outgoing dependencies from the body it reads for scripts instead of calling `GetOutgoingDependencies`. Scans read fresh: a fresh read refreshes a body the cache holds but adds none, so a scan of thousands of members neither keeps their bodies nor pushes out what the Entities tab shows, and the Extensions tab's Rescan sees an upgraded package's new version and `dependsOn`.

Measured on a second host: Windows Server 2022, Docker Desktop (WSL 2, 4 CPUs, 31 GB), the same generator and seed, native `linux/amd64` (no emulation), JVM `-Xms2g -Xmx4g`. Two harness runs each; the ranges are both runs.

| P00 scan (16,456 entities) | Before | Dependencies from the body |
|-|-|-|
| Script calls on | 73.4–74.6 s, 32,951 requests | **62.6–62.9 s, 16,505 requests** |
| Script calls and "Show what uses it" | 84.1–86.8 s, 49,406 requests | **72.8–74.5 s, 32,960 requests** |

Requests halve but time falls only 15%: the scan still reads 3.6 GB of bodies, and the body GET (p50 16 ms, p95 36–39 ms, platform CPU 180–190% of 4 cores) sets the pace, not the dependency call (p50 5 ms). The rest of fix 3 (reading fewer bodies, and gzip) is what moves this further.

| Browsing (harness) | Before | Shared cache |
|-|-|-|
| The hub, three of its Things, two chained templates, in turn | 59 requests, 6.5 MB, 0.26–0.29 s | 50 requests, 4.5 MB, 0.23–0.24 s |

In the app (through `tools/dev_server.py`, `?se-perf=1`): opening `Lab.Perf.P03.T000000` read three bodies (the Thing, its template, `GenericThing`), each once; before, the Thing's body was read twice. Opening its template from the "Uses" list then read no body at all. The P38 scan (864 members, calls on) gave 869 nodes and 887 links in 9.6 s, layout 411 ms.

Other scenarios on this host: Extensions scan 0.28–0.34 s (604 requests), opening the hub 0.15–0.16 s, the hub's 100,000 incoming rows 0.35–0.39 s, every collection listed 0.8–1.0 s.

### POSTs from Windows to a platform in Docker took 44 ms

The first runs on this host gave 44 ms for every service call (POST) and 6 ms for a GET, from the harness and through the dev proxy alike; from a container on the platform's Docker network the same POST took 1–3 ms. Python's `http.client` writes a request's headers and its body separately, and through Docker Desktop's port forwarding the second write waited for the delayed acknowledgement of the first (setting `TCP_NODELAY` on the client socket changed nothing). Sending both in one write, as a browser does for a small body, brought the POST to 1.1–1.4 ms. `tools/single_write_http.py` now does this for `measure.py` and `dev_server.py`; with plain `http.client` the P00 scan took 152–157 s and the Extensions scan 4.4–4.6 s here. Results measured from Windows before this change overstate every POST by about 40 ms; the macOS figures above were not affected to this degree.

## Limits hit

1. **500-row dependency lists** (`GetIncomingDependencies`, `GetOutgoingDependencies`, default `maxItems`). `GetImplementingThings` also stops at 500 and ignores `maxItems`, so `dataThings()` would miss data Things beyond 500 of a kind.
2. **20,000-row collection listing**; `nameMask` defaults to 500 rows too and matches prefixes and `*` only (notes section 5).
3. **Bytes per entity body:** 226–243 kB uncompressed for any Thing or template, 22 kB gzipped. Tomcat answers `Accept-Encoding: gzip` with no compression. No REST sub-path returns the scripts alone: `/ServiceDefinitions` (23 kB) lists names and descriptions without `sourceType` or code; `/Metadata` is larger than the body; `ServiceImplementations` and `ThingShape` answer 405.
4. **Main-thread layout:** 2 s per 1,000 nodes for one group, and far steeper with many groups.
5. **Platform memory on a small host:** 100,000 Things put the platform container at 2.9–3.4 GB idle; a full project scan with incoming lists pushed it to 4.3 GB and once over the VM's limit.
6. **Basic authentication:** 199 ms of platform time per request. The browser app uses the session; any tool or proxy must too.

## Recommended fixes

In order of value for effort.

1. **Ask for every dependency row, and say when a list is cut** (0.5–1 day). Pass `{ maxItems: N }` on both dependency services (100,000 costs 0.15 s and 14 MB for the hub; make N a setting) and show "500 of 100,001" when the count equals the limit. The Entities tab's grouped lists then need paging or a "show more" (the graphs already cap at 60 and 20 nodes). Check `dataThings()` against the 500 cap of `GetImplementingThings`.

   **Decided instead (19 Nov 2026), for the Entities tab:** keep the 500-row list and show at most 10 of it. "Used by" reads "500+" when the list reaches the cap, and a Search… button opens a modal that always shows at most 10 matches. For a template or shape at the cap the modal searches the platform with `QueryImplementingThings` (`maxItems` 11, `nameMask` `*text*`), which honours `maxItems` (all 100,000 for the hub with `maxItems` 200,000) and matches a substring when the mask is `*text*` (plain text matched nothing). It found `Lab.Perf.P39.T099988`, which is not among the 500 listed. Otherwise it filters the loaded list. `QueryImplementingThings` on the derived `Lab.Perf.E33.TT.Device` returned no Things, so it lists direct instances only, like `GetIncomingDependencies`. Scans still undercount above 500.
2. **Read whole collections for search** (0.5 day). `?maxItems=200000` costs 0.3–0.5 s and 15.5 MB once per collection and keeps substring search. Warn when the row count reaches the requested limit. Server-side `nameMask` search only helps prefix queries, so keep it as a fallback for platforms past a few hundred thousand entities.
3. **Stop reading bodies that cannot hold calls** (1–2 days). Today the project scan reads all 16,451 Thing bodies (3.6 GB) to find 3 ms of scripts. Options, cheapest first:
   - read a body only when "Include calls" is on, and offer it off by default above a member count (for example 1,000);
   - share one body cache between the tabs and the resolver (opening an entity reads the body twice; tracing reads it again). **Done** on `feature/shared-entity-cache`, with Thing dependencies read from the body during a scan: see "Shared entity cache and Thing dependencies from the body";
   - group Things by template and read a sample to learn whether instances carry their own services. A heuristic: say so in the UI.
   - Platform side, ask the administrator to enable Tomcat compression for `application/json` (about 1 hour): every body shrinks about 10x, which helps the whole of ThingWorx, not only this app.
4. **Lay out off the main thread, and cap what is laid out** (2–3 days). Move `layoutGraph` into a Web Worker (the bundle ships as one file through `se-common`, so build the worker inline as a Blob) with a Cancel that terminates it. Above about 1,500 nodes, show the grouped summary (one node per owner, which is already the default for outside entities) and a table of members instead of one node per member; and never compound-layout more than a few groups with cross links.
5. **Do not scan extensions on load unless that tab is shown** (1 hour). `ExplorerComponent.tab` starts at `extensions` and the start tab is applied in a microtask, so the effect opens the Extensions tab first and its scan runs on every page load. **Done:** `tab` is a `linkedSignal` of `StartTab` (`start-tab.ts`); opening on the Entities tab made no extension request, and with no `StartTab` the Extensions tab still opens and scans.
6. **Batching the per-entity calls** (2–4 days, only after 3). The server work is small (p50 1.6 ms per call); the scan's time goes to bodies and round trips. A read-only service that runs `GetOutgoingDependencies` for a list of names would cut 16,455 requests to about 30, but notes section 1 applies: inside a service, visibility is the caller's while other rights can come from System, and CLAUDE.md rules out a backend that runs as System. If it is built, it must hold no rights of its own beyond invoking the dependency services, and a test must show a user in another organisational unit gets nothing back. Caching dependency results per scan session gives most of the benefit for repeated scans with no server code.
7. **Platform sizing guidance** (documentation). For 100,000 Things plan 4 GB of heap and 5 GB or more for the container; on a shared development VM, run Solution Explorer's large scans with nothing else heavy beside it.

## In-browser timings

The app records User Timing measures named `se:<area>:<phase>` when the page URL has `se-perf=1` or `localStorage['se.perf']` is `'1'`; otherwise every call returns at once. `ui/apps/explorer/src/app/perf.ts` holds the helpers; the measures are:

| Measure | Where |
|-|-|
| `extensions:scan`, `extensions:read extensions`, `extensions:list entities`, `extensions:read dependencies`, `extensions:build graph` | Extensions tab |
| `containers:scan`, `containers:list entities`, `containers:read other containers`, `containers:read dependencies` (with `analysisMilliseconds`), `containers:build graph` | Projects & Extensions tab |
| `entities:open`, `entities:trace` (with the number of distinct services), `entities:build call graph` | Entities tab |
| `layout` (nodes, edges, groups) | every `layoutGraph` call |
| `render` (nodes, edges) | graph view: from a new graph to the browser's style and layout after the DOM update. Paint is left out: animation frames do not run while the page is hidden |

With the flag on, `window.__sePerf.entries()` returns them, `clear()` removes them, and `layout(count, grouped)` times dagre on the synthetic graph in the page.

## Reproducing

```bash
python3 tools/perf/platform.py up --heap "-Xms2g -Xmx4g"     # twx-test on port 18080, never twx-dev
eval "$(python3 tools/perf/platform.py env)"
python3 tools/perf/generate_environment.py build
python3 tools/perf/generate_environment.py install
python3 tools/perf/generate_environment.py trial
python3 tools/perf/generate_environment.py things --count 100000 --method import
python3 tools/perf/measure.py --label "my run"            # writes tools/perf/.work/results-<time>.json
python3 tools/perf/platform.py reset                     # deletes the containers and data volumes
```

For the browser: build the UI (`npm run build` in `ui/`), run `tools/dev_server.py` with the same environment, and open `http://localhost:4300/?se-perf=1&tab=containers&container=Lab.Perf.P38&container-kind=Project` (or `tab=entities&entity=Lab.Perf.E00.TT.Device&collection=ThingTemplates`). The scripts refuse any platform other than localhost:18080.

On Windows, run the same commands in Git Bash with the builder's interpreter, `../twx-container-builder/.venv/Scripts/python.exe`, in place of `python3`; the perf tools also need `PYTHONPATH` set to `../twx-knowledge` for `twxlab` (the build and `dev_server.py` do not). Without Node on the host, the scenarios `trace` and `layout` (which run `node`) are left out, and the UI tests and build run in a container: `docker run --rm -v "$(pwd -W)/ui:/work" -v se-ui-node-modules:/work/node_modules -w /work node:24-bookworm sh -c "npm ci && npm test && npm run build"` (with `MSYS_NO_PATHCONV=1`).
