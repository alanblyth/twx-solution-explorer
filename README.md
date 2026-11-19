# twx-solution-explorer

A ThingWorx 10.2 extension (`SolutionExplorer`) with a mashup, `SE.Explorer`, that serves an Angular application through one widget, `se-explorer`. It explores what depends on what in a running platform.

| Tab | What it shows |
|---|---|
| **Extensions** | Every installed extension as a node. An edge A → B means A declares B in `dependsOn`, or an entity shipped by A uses an entity shipped by B (the label counts those entity links; click an edge to list them). Extensions that depend on nothing sit on the left; those that build on them spread out to the right. Circular dependencies are flagged. **Show contents** opens a selected extension on the Projects & Extensions tab. |
| **Projects & Extensions** | Pick a project or an extension (filterable list) and scan it. The graph shows its entities inside a frame, the links among them, and their links to entities outside, grouped by the project or extension that holds them (or shown one by one). Links come from the dependency services and, optionally, from calls in the scripts of its Things, templates and shapes; "Show what uses it" adds incoming links. The side panel counts internal, outgoing and incoming links per outside owner and lists the links of a clicked node or edge; open an entity in the Entities tab from there. Disabled Things are read from their definition. |
| **Entities** | Pick a Thing, template, shape, data shape, mashup or project, filtered by name and, optionally, by the project or extension that holds it. **Dependencies**: what it uses and what uses it, as a graph and grouped lists (click to navigate). **Services**: pick a service (own, inherited or built-in) to see every service it can call, down to a chosen depth, as a **call graph** and as a **sequence diagram** generated from the JavaScript (calls in source order, with `alt`/`opt`/`loop`/`try` frames). Copy the diagram as Mermaid, or save either view as SVG. |
| **Permission Issues** | Search a project, an extension or every Thing, template and shape for services with either issue below (built-in services optional); click a result to open it in the Entities tab. |
| **Security** | Organisations with their unit trees, user groups, users, roles and permission groups, and how they link. With nothing picked, an overview draws every role with what it holds, every organisation's units and nested permission groups. Pick one (or click a node) to draw what holds it and what it holds, to a chosen number of levels; the side panel lists direct and indirect links, what reaches it through roles (a user's permission groups, or a permission group's users and groups) and a permission group's grants, which open in the Entities tab. Needs an administrator to read the security entities. |

The Projects & Extensions and Entities tabs have a collapsible **Permissions** bar at the bottom for the selected entity: per service, whether System may invoke it, who else may (through roles, permission groups, groups and organisations), the services that call it and the mashups or widget scripts that call it. It flags two issues:

- **System lacks access**: another service calls it, but System holds no visibility or no ServiceInvoke on it, so the call only works on the caller's own permissions (notes section 1), which a lower-level service should not need to grant.
- **Users granted, no UI calls it**: a principal other than System may invoke it, yet no mashup data source or extension widget JavaScript calls it, so the grant should not be needed.

Grants come from the entity, its template chain and shapes (`instanceRunTimePermissions`) and the collection (`CollectionFunctions`); who holds them needs read access to roles, permission groups, groups and organisations (an administrator has it; otherwise System access shows as unknown). Callers come from the scripts of every Thing, template and shape, read once until Re-read. UI calls are matched by name in widget JavaScript, because an Angular bundle builds its URLs at run time; callers outside the platform (edge devices, REST clients) are not seen, so a service only they call is flagged as granted with no UI.

Java entities and Java-implemented services are out of scope: they appear as leaves.

## How it works

Everything runs in the browser as the signed-in user, over the platform's REST API. There is no backend Thing, so nothing runs as System (see notes section 1 in `twx-knowledge`).

- Extension membership: `PlatformSubsystem.GetExtensionPackageDetails`; declared dependencies: the package's `dependsOn`; entity dependencies: `GetOutgoingDependencies` on each entity.
- Service code: the entity JSON (`GET /Thingworx/<collection>/<name>`); inherited services are read from the template or shape named in `effectiveShape`.
- The script is parsed with acorn. The analyser follows `Things["X"]`, `Things.X`, `Resources[...]`, `me`, string constants, entity variables, and local helper functions (arguments are bound to parameters, so `findRows("CM.Registry", ...)` resolves). A name built at run time shows as a dynamic target; a script that does not parse falls back to a pattern match and says so.
- It is static analysis: calls through `eval`-like indirection, a service name held in a variable, or event subscriptions are not followed.

### Who can see what

A signed-in user sees only what their visibility and permissions allow. An entity that cannot be read shows as "not found or not visible", and the extension scan reports how many entities it could not read. A non-administrator also needs visibility of `Subsystems/PlatformSubsystem` (the mashup runtime and the extension services call it) and run-time permission for `GetExtensionPackageDetails`, `GetOutgoingDependencies` and `GetIncomingDependencies`.

## Layout

| Path | Contents |
|---|---|
| `ui/` | Angular 22 app (zoneless, one custom element `se-explorer`, shadow DOM). `apps/explorer/src/app/`: `js-analyzer.ts`, `call-resolver.ts`, `extension-graph.ts`, `graph-layout.ts` (dagre), `sequence-layout.ts` hold the logic and have no Angular dependency; the `*.component.ts` files are the views |
| `extension/` | Extension source: `metadata.xml`, `ui/` widget wrappers, `Entities/` (JSON, written by `generate_entities.py`), `build.py`, and `thingworx_package.py` (the entity builders and zip build they share) |
| `tools/dev_server.py` | Dev page and proxy to a platform, with deep links such as `/?tab=entities&entity=CM.Provisioning&service=RegisterApplication&view=sequence` or `/?tab=containers&container=CM&container-kind=Project` |
| `tests/` | Python test of the zip layout |
| `tools/perf/` | Performance environment generator, REST replay harness and node benchmarks; results in [docs/performance.md](docs/performance.md) |
| `ui/tests/` | Node tests of the analyser, resolver, layouts and extension graph |

## Build, test, install

Needs Node 22+ and Python 3.9+. The build, the entity generator, the tests and the dev server use the Python standard library only.

```bash
(cd ui && npm install)
```

```bash
(cd ui && npm test)                                   # unit tests (node --test)
python3 extension/build.py                            # builds the bundle, build/SolutionExplorer-<version>_json.zip and _xml.zip
python3 -m unittest discover -s tests -t .            # zip layout test
```

Both zips hold the same extension: `_json` has its entities as JSON, `_xml` as XML for platforms that do not import JSON entities (the XML zip was checked on ThingWorx 10.2.1: install, upgrade, and a mashup identical to the JSON one). Import one of them in Composer (Import / Export, Extensions). Extension import must be enabled on the platform (notes section 7), and every import needs a higher `packageVersion` in `extension/metadata.xml` (or `build.py --version`). Open the mashup at `/Thingworx/Runtime/index.html#mashup=SE.Explorer`, or place the **Solution Explorer** widget on your own mashup. Its properties: `StartTab` (`extensions`, `containers`, `entities`, `permissions` or `security`), `Entity`, `EntityCollection`, `Service`, `View`, `Container`, `ContainerKind` (`Project` or `Extension`) (bindable in) and `SelectedEntity`, `SelectedService`, `SelectedExtension`, `SelectedContainer` (bindable out, with events).

Develop against a platform without re-importing:

```bash
(cd ui && npx ng build explorer --configuration development)
TWX_BASE=http://localhost:8080/Thingworx TWX_ADMIN_PASSWORD_FILE=<file> python3 tools/dev_server.py
                                            # http://localhost:4300, signed in as Administrator, dev platforms only
```

## Third-party software

The widget's bundle (`se-elements.js`) includes these runtime packages, pinned in `ui/package.json`:

| Package | Licence | Used for |
|---|---|---|
| `acorn` | MIT | Parsing service scripts: calls, frames, code colouring |
| `@dagrejs/dagre`, `@dagrejs/graphlib` | MIT | Graph layout |
| `@angular/*` | MIT | The app and its custom element |
| `rxjs` | Apache-2.0 | Required by Angular |
| `tslib` | 0BSD | TypeScript helpers |

The production build extracts their licence texts (`extractLicenses`), and `extension/build.py` adds any runtime package the extraction leaves out. The notices ship twice: as a `/*! */` comment at the top of `se-elements.js` and as `THIRD-PARTY-NOTICES.txt` at the root of the extension zip. The build stops if a runtime package has no licence file. When you add a dependency, check its licence before you ship.
