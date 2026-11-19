#!/usr/bin/env python3
"""Generate and install a large, deterministic ThingWorx environment for measuring Solution Explorer.

Everything is named with the prefix `Lab.Perf.` (packages `LabPerf...`, which cannot hold dots) and is built with the twxlab
builders. Run it only against the throwaway twx-test platform (tools/perf/platform.py), never twx-dev: it refuses any base URL
that is not port 18080 on localhost.

  python tools/perf/generate_environment.py build                     write sources and zips into the work folder
  python tools/perf/generate_environment.py install                   create the 40 projects, import the loader and the 40 packages
  python tools/perf/generate_environment.py trial                     time 1,000 Things by batch service and by source-control import
  python tools/perf/generate_environment.py things --count 100000 --method batch
  python tools/perf/generate_environment.py summary                   counts per project, package and template on the platform

What it makes (seed 20261118 by default):
  * 40 extension packages LabPerfE00..E39 in 5 layers of 8. A package's dependsOn names 1 to 3 packages of the layer below and
    sometimes one further down, so the packages form a layered DAG.
  * Per package: 2 data shapes, 2 Thing shapes, 3 templates, 4 service Things, 2 mashups. The `Device` template of a package
    derives from the `Device` template of one of its dependencies, so inheritance chains cross packages and are up to 5 deep;
    `Controller` derives from the package's own `Sensor` and implements a dependency's shape.
  * Service Things call services of Things in dependency packages: static names, string constants, local helper functions,
    `me`, and some names built at run time.
  * 40 projects Lab.Perf.P00..P39, created at run time (a shipped project is locked). Package Exx's entities name project Pxx.
  * The Things: Lab.Perf.Pxx.T000000.., spread over the projects with a skewed (Zipf-like) weight, so one project is much bigger
    than the rest. `--hub-share` of them (default all) are on Lab.Perf.E00.TT.Device, the base of every inheritance chain, so that
    template has that many incoming dependencies (GetIncomingDependencies lists direct instances only); the rest are spread over
    every package's templates, mostly in another project's package (cross-project references).
"""
import argparse, json, os, random, shutil, subprocess, sys, time, urllib.parse
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def find_knowledge_root():
    if os.environ.get("TWX_KNOWLEDGE"):
        return Path(os.environ["TWX_KNOWLEDGE"])
    for folder in REPOSITORY_ROOT.parents:
        if (folder / "twx-knowledge" / "twxlab").is_dir():
            return folder / "twx-knowledge"
    raise SystemExit("twx-knowledge not found: set TWX_KNOWLEDGE")


sys.path.insert(0, str(find_knowledge_root()))
from twxlab import entities                  # noqa: E402
from twxlab.client import connect            # noqa: E402
from twxlab.extension import _version_tuple, build_extension_zip, import_extension, installed_packages   # noqa: E402

DEFAULT_SEED = 20261118
LAYER_COUNT = 5
PACKAGES_PER_LAYER = 8
PACKAGE_COUNT = LAYER_COUNT * PACKAGES_PER_LAYER
PROJECT_COUNT = 40
SERVICE_THINGS_PER_PACKAGE = 4
SERVICE_NAMES = ("Run", "Compute", "Validate", "Publish")
PACKAGE_VERSION = "1.0.2"
LOADER_PACKAGE = "LabPerfLoader"
LOADER_THING = "Lab.Perf.Loader"
HUB_TEMPLATE = "Lab.Perf.E00.TT.Device"
SOURCE_CONTROL_REPOSITORY = "SystemRepository"
PLATFORM_CONTAINER = "twx-test-platform-1"
WORK_FOLDER = Path(os.environ.get("TWX_PERF_WORK_SOURCE") or REPOSITORY_ROOT / "tools" / "perf" / ".work")


# ---------------------------------------------------------------- naming

def package_name(index):
    return f"LabPerfE{index:02d}"


def prefix_of(index):
    return f"Lab.Perf.E{index:02d}."


def project_name(index):
    return f"Lab.Perf.P{index:02d}"


def service_thing_name(package_index, thing_index):
    return f"{prefix_of(package_index)}Svc.{thing_index}"


def layer_of(package_index):
    return package_index // PACKAGES_PER_LAYER


# ---------------------------------------------------------------- the plan

def dependency_plan(seed):
    """{package index: sorted dependency indexes}: 1 to 3 from the layer below, sometimes one more from further down."""
    generator = random.Random(f"{seed}:dependencies")
    plan = {}
    for package_index in range(PACKAGE_COUNT):
        layer = layer_of(package_index)
        if layer == 0:
            plan[package_index] = []
            continue
        below = list(range((layer - 1) * PACKAGES_PER_LAYER, layer * PACKAGES_PER_LAYER))
        chosen = set(generator.sample(below, generator.randint(1, 3)))
        if layer >= 2 and generator.random() < 0.4:
            chosen.add(generator.randrange(0, (layer - 1) * PACKAGES_PER_LAYER))
        plan[package_index] = sorted(chosen)
    return plan


def closest_dependency(dependencies):
    """The dependency in the highest layer: following it gives the longest template chain."""
    return max(dependencies, key=lambda index: (layer_of(index), -index))


def project_weights():
    return [1.0 / (rank + 1) ** 0.8 for rank in range(PROJECT_COUNT)]


def thing_plan(seed, count, hub_share):
    """[(Thing name, template, project)] for Things 0..count-1, the same for a given seed whatever the count."""
    generator = random.Random(f"{seed}:things")
    weights = project_weights()
    templates_by_package = [[f"{prefix_of(index)}TT.{kind}" for kind in ("Device", "Sensor", "Controller")] for index in range(PACKAGE_COUNT)]
    rows = []
    for thing_index in range(count):
        project_index = generator.choices(range(PROJECT_COUNT), weights)[0]
        on_hub = generator.random() < hub_share
        if on_hub:
            template = HUB_TEMPLATE
        else:
            package_index = project_index if generator.random() < 0.3 else generator.randrange(PACKAGE_COUNT)
            template = generator.choice(templates_by_package[package_index])
        rows.append((f"{project_name(project_index)}.T{thing_index:06d}", template, project_name(project_index)))
    return rows


# ---------------------------------------------------------------- scripts

def service_script(generator, package_index, thing_index, service_index, dependencies):
    """A script that calls services in this package and in dependency packages, in the styles the analyser follows."""
    own_service = SERVICE_NAMES[service_index]
    lines = [f"// {service_thing_name(package_index, thing_index)}.{own_service} (generated)", "var total = input || 0;"]
    targets = [service_thing_name(dependency, generator.randrange(SERVICE_THINGS_PER_PACKAGE)) for dependency in dependencies]
    if service_index + 1 < len(SERVICE_NAMES):
        lines.append(f"total += me.{SERVICE_NAMES[service_index + 1]}({{input: total}});")
    style = (package_index + thing_index + service_index) % 4
    if targets:
        first_target = targets[0]
        called_service = SERVICE_NAMES[(service_index + thing_index) % len(SERVICE_NAMES)]
        if style == 0:
            lines.append(f'total += Things["{first_target}"].{called_service}({{input: total}});')
        elif style == 1:
            lines.insert(1, f'var UPSTREAM_THING = "{first_target}";')
            lines.append(f"total += Things[UPSTREAM_THING].{called_service}({{input: total}});")
        elif style == 2:
            lines.insert(1, "function forward(thingName, value) {\n    return Things[thingName]." + called_service + "({input: value});\n}")
            lines.append(f'total += forward("{first_target}", total);')
        else:
            dependency = dependencies[0]
            lines.append(f'total += Things["{prefix_of(dependency)}Svc." + (total % {SERVICE_THINGS_PER_PACKAGE})].{called_service}({{input: total}});')
        for extra_target in targets[1:2]:
            lines.append("if (total > 10) {")
            lines.append(f'    total += Things["{extra_target}"].{SERVICE_NAMES[0]}({{input: total}});')
            lines.append("} else {")
            lines.append(f'    try {{ total -= Things["{extra_target}"].{SERVICE_NAMES[-1]}({{input: total}}); }} catch (error) {{ logger.warn(error); }}')
            lines.append("}")
    if service_index == len(SERVICE_NAMES) - 1 and thing_index + 1 < SERVICE_THINGS_PER_PACKAGE:
        lines.append("for (var step = 0; step < 2; step++) {")
        lines.append(f'    total += Things["{service_thing_name(package_index, thing_index + 1)}"].{SERVICE_NAMES[0]}({{input: step}});')
        lines.append("}")
    lines.append("var result = total;")
    return "\n".join(lines) + "\n"


def mashup_content(package_index, mashup_index):
    thing_name = service_thing_name(package_index, mashup_index)
    data_name = f"Things_{thing_name}"
    title = f"{prefix_of(package_index)}MU.{mashup_index}"
    return {
        "Bindings": [], "CustomCSS": "", "Events": [],
        "Data": {data_name: {"DataName": data_name, "EntityName": thing_name, "EntityType": "Things", "Id": data_name, "RemoteDataSource": False,
                             "Services": [{"APIMethod": "post", "Characteristic": "Services", "Id": f"svc-{mashup_index}", "Name": "Run",
                                           "Parameters": {}, "RefreshInterval": 0, "Target": "Run"}]}},
        "UI": {"Properties": {"Area": "UI", "Height": 600, "Id": "mashup-root", "ResponsiveLayout": False, "Title": title, "Type": "mashup",
                              "Visible": True, "Width": 800, "Z-index": 10}, "Widgets": []},
    }


# ---------------------------------------------------------------- package sources

def chain_shapes(dependency_map):
    """{package index: the shapes its Device template's chain implements, itself included}. A chain must not implement one
    shape twice: the platform accepts the templates but refuses a Thing of the template with a name conflict."""
    found = {}
    for package_index in range(PACKAGE_COUNT):
        dependencies = dependency_map[package_index]
        inherited = set(found[closest_dependency(dependencies)]) if dependencies else set()
        own = [f"{prefix_of(package_index)}TS.Metrics"]
        control = next((f"{prefix_of(dependency)}TS.Control" for dependency in dependencies
                        if f"{prefix_of(dependency)}TS.Control" not in inherited), None)
        if control:
            own.append(control)
        found[package_index] = sorted(inherited | set(own))
        found[("own", package_index)] = own
    return found


def package_entities(seed, package_index, dependencies, device_shapes):
    generator = random.Random(f"{seed}:package:{package_index}")
    prefix = prefix_of(package_index)
    project = project_name(package_index % PROJECT_COUNT)
    made = [
        entities.data_shape(f"{prefix}DS.Reading", {"timestamp": "DATETIME", "value": "NUMBER", "quality": "STRING"}, project_name=project),
        entities.data_shape(f"{prefix}DS.Summary", {"name": ("STRING", "", True), "count": "INTEGER", "mean": "NUMBER"}, project_name=project),
        # property names carry the package number: a template chain that met the same name twice would fail with a name
        # conflict as soon as a Thing of the template exists (notes section 7)
        entities.thing_shape(f"{prefix}TS.Metrics", {f"e{package_index:02d}Temperature": "NUMBER", f"e{package_index:02d}Pressure": "NUMBER"}, project_name=project),
        entities.thing_shape(f"{prefix}TS.Control", {f"e{package_index:02d}Setpoint": "NUMBER", f"e{package_index:02d}Mode": "STRING"}, project_name=project),
    ]
    device_base = f"{prefix_of(closest_dependency(dependencies))}TT.Device" if dependencies else "GenericThing"
    made.append(entities.thing_template(f"{prefix}TT.Device", base=device_base, shapes=device_shapes,
                                        properties={f"e{package_index:02d}Serial": "STRING"}, project_name=project))
    sensor = entities.thing_template(f"{prefix}TT.Sensor", shapes=[f"{prefix}TS.Metrics"], properties={f"e{package_index:02d}LastReadings": "INFOTABLE"}, project_name=project)
    sensor_property = entities.entity_of(sensor.document)["thingShape"]["propertyDefinitions"][f"e{package_index:02d}LastReadings"]
    reading_shape = f"{prefix_of(generator.choice(dependencies))}DS.Reading" if dependencies else f"{prefix}DS.Reading"
    sensor_property["aspects"] = {"dataShape": reading_shape}
    made.append(sensor)
    controller_shapes = [f"{prefix_of(generator.choice(dependencies))}TS.Control"] if dependencies else [f"{prefix}TS.Control"]
    made.append(entities.thing_template(f"{prefix}TT.Controller", base=f"{prefix}TT.Sensor", shapes=controller_shapes, project_name=project))
    for thing_index in range(SERVICE_THINGS_PER_PACKAGE):
        services = {service: {"code": service_script(generator, package_index, thing_index, service_index, dependencies),
                              "parameters": {"input": "NUMBER"}, "result": "NUMBER"}
                    for service_index, service in enumerate(SERVICE_NAMES)}
        made.append(entities.thing(service_thing_name(package_index, thing_index), "GenericThing", services=services, project_name=project))
    for mashup_index in range(2):
        made.append(entities.mashup(f"{prefix}MU.{mashup_index}", mashup_content(package_index, mashup_index), project_name=project))
    return made


def metadata_xml(name, depends_on=""):
    depends_attribute = f' dependsOn="{depends_on}"' if depends_on else ""
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n<Entities>\n  <ExtensionPackages>\n'
            f'    <ExtensionPackage name="{name}" vendor="Lab" description="Solution Explorer performance environment" '
            f'packageVersion="{PACKAGE_VERSION}" minimumThingWorxVersion="10.2.0" buildNumber="0"{depends_attribute}/>\n'
            f'  </ExtensionPackages>\n</Entities>\n')


LOADER_CREATE = """// Creates the Things in `batch.rows` ([{name, template, project}]): create, enable, restart, nothing in between.
var rows = batch.rows;
var created = 0;
var failures = [];
for (var index = 0; index < rows.length; index++) {
    var row = rows[index];
    if (Things[row.name]) continue;   // already there (a resumed run): never touch it
    try {
        Resources["EntityServices"].CreateThing({name: row.name, description: "", thingTemplateName: row.template, projectName: row.project, tags: undefined});
        Things[row.name].EnableThing();
        Things[row.name].RestartThing();
        created++;
    } catch (error) {
        failures.push(row.name + ": " + error);
        try { Resources["EntityServices"].DeleteThing({name: row.name}); } catch (ignored) {}
    }
}
if (failures.length) logger.error("Lab.Perf.Loader.CreateThings: " + failures.length + " failed, first: " + failures[0]);
var result = created;
"""

LOADER_DELETE = """// Deletes the Things named in `batch.names`.
var names = batch.names;
var deleted = 0;
for (var index = 0; index < names.length; index++) {
    try { Resources["EntityServices"].DeleteThing({name: names[index]}); deleted++; } catch (error) { logger.warn(error); }
}
var result = deleted;
"""


def write_sources(seed, work_folder):
    source_root = work_folder / "source"
    zip_folder = work_folder / "zips"
    for folder in (source_root, zip_folder):
        if folder.is_dir():
            shutil.rmtree(folder)
    dependencies = dependency_plan(seed)
    shapes_of_chains = chain_shapes(dependencies)
    zips = []
    loader_dir = source_root / LOADER_PACKAGE
    loader_dir.mkdir(parents=True)
    (loader_dir / "metadata.xml").write_text(metadata_xml(LOADER_PACKAGE))
    entities.write_entity(str(loader_dir), entities.thing(LOADER_THING, "GenericThing", services={
        "CreateThings": {"code": LOADER_CREATE, "parameters": {"batch": "JSON"}, "result": "INTEGER"},
        "DeleteThings": {"code": LOADER_DELETE, "parameters": {"batch": "JSON"}, "result": "INTEGER"}}))
    zips.append(build_extension_zip(str(loader_dir), str(zip_folder)))
    entity_count = 0
    for package_index in range(PACKAGE_COUNT):
        package_dir = source_root / package_name(package_index)
        package_dir.mkdir(parents=True)
        depends_on = ",".join(f"{package_name(dependency)}:{PACKAGE_VERSION}" for dependency in dependencies[package_index])
        (package_dir / "metadata.xml").write_text(metadata_xml(package_name(package_index), depends_on))
        for entity in package_entities(seed, package_index, dependencies[package_index], shapes_of_chains[("own", package_index)]):
            entities.write_entity(str(package_dir), entity)
            entity_count += 1
        zips.append(build_extension_zip(str(package_dir), str(zip_folder)))
    plan = {"seed": seed, "packages": {package_name(index): [package_name(dependency) for dependency in found]
                                       for index, found in dependencies.items()},
            "entities_in_packages": entity_count, "zips": [os.path.basename(path) for path in zips]}
    (work_folder / "plan.json").write_text(json.dumps(plan, indent=2))
    return plan


# ---------------------------------------------------------------- platform side

def throwaway_client():
    client = connect()
    location = urllib.parse.urlparse(client.base)
    if location.hostname not in ("localhost", "127.0.0.1") or location.port != 18080:
        raise SystemExit(f"refusing to touch {client.base}: this tool runs only against twx-test on localhost:18080 "
                         "(eval \"$(python tools/perf/platform.py env)\")")
    return client


def create_projects(client):
    for index in range(PROJECT_COUNT):
        name = project_name(index)
        if client.exists(f"Projects/{name}"):
            continue
        client.call("Resources/EntityServices", "CreateProject", {"name": name, "description": "Solution Explorer performance environment"})


def install(client, work_folder):
    plan = json.loads((work_folder / "plan.json").read_text())
    create_projects(client)
    installed = installed_packages(client)
    timings = []
    for zip_name in plan["zips"]:
        package, version = zip_name[: -len(".zip")].rsplit("-", 1)
        if package in installed and _version_tuple(installed[package]["packageVersion"]) >= _version_tuple(version):
            continue
        started = time.monotonic()
        import_extension(client, str(work_folder / "zips" / zip_name))
        timings.append((package, round(time.monotonic() - started, 2)))
        print(f"imported {package} in {timings[-1][1]} s", flush=True)
    return timings


def existing_thing_names(client):
    status, body = client.req("GET", "Things?maxItems=200000", timeout=600)
    return {row["name"] for row in body["rows"] if row["name"].startswith("Lab.Perf.P")} if status == 200 else set()


def create_by_batch(client, rows, batch_size, log_every=10):
    """Create rows with Lab.Perf.Loader.CreateThings, batch_size per call. Returns (seconds, created, per-call seconds)."""
    started = time.monotonic()
    created = 0
    call_seconds = []
    for offset in range(0, len(rows), batch_size):
        batch = [{"name": name, "template": template, "project": project} for name, template, project in rows[offset:offset + batch_size]]
        call_started = time.monotonic()
        status, body = client.req("POST", f"Things/{LOADER_THING}/Services/CreateThings", {"batch": {"rows": batch}}, timeout=120)
        call_seconds.append(time.monotonic() - call_started)
        if status != 200:
            raise RuntimeError(f"CreateThings failed at {offset}: HTTP {status} {str(body)[:300]}")
        created += int(body["rows"][0]["result"])
        if (offset // batch_size) % log_every == 0:
            rate = created / (time.monotonic() - started)
            print(f"  {created}/{len(rows)} created, {call_seconds[-1]:.1f} s for the last call, {rate:.0f} Things/s", flush=True)
    return time.monotonic() - started, created, call_seconds


def create_by_import(client, rows, chunk_size=5000, folder_name="lab_perf_import"):
    """Write the Things as source-control JSON into the platform's SystemRepository (docker cp) and import them with
    SourceControlFunctions.ImportSourceControlledEntities, chunk_size per call. Returns (seconds, created, per-call seconds)."""
    started = time.monotonic()
    call_seconds = []
    staging_root = WORK_FOLDER / "import-staging"
    for offset in range(0, len(rows), chunk_size):
        if staging_root.is_dir():
            shutil.rmtree(staging_root)
        chunk_folder = staging_root / f"{folder_name}_{offset:06d}"
        for name, template, project in rows[offset:offset + chunk_size]:
            entity = entities.thing(name, template, project_name=project)
            entities.write_entity(str(chunk_folder / project), entity)
        repository_path = f"/ThingworxStorage/repository/{SOURCE_CONTROL_REPOSITORY}/"
        target = repository_path + chunk_folder.name
        subprocess.run(["docker", "exec", "-u", "0", PLATFORM_CONTAINER, "mkdir", "-p", target], check=True, capture_output=True)
        # "<folder>/." copies the folder's contents into the existing target; then hand it to the platform's user
        subprocess.run(["docker", "cp", f"{chunk_folder}/.", f"{PLATFORM_CONTAINER}:{target}"], check=True, capture_output=True)
        subprocess.run(["docker", "exec", "-u", "0", PLATFORM_CONTAINER, "chown", "-R", "twadmin:twadmin", target], check=True, capture_output=True)
        call_started = time.monotonic()
        status, body = client.req("POST", "Resources/SourceControlFunctions/Services/ImportSourceControlledEntities", {
            "repositoryName": SOURCE_CONTROL_REPOSITORY, "path": f"/{chunk_folder.name}", "useDefaultDataProvider": False,
            "withSubsystems": False, "importFormat": "json"}, timeout=1800)
        call_seconds.append(time.monotonic() - call_started)
        subprocess.run(["docker", "exec", "-u", "0", PLATFORM_CONTAINER, "rm", "-rf", repository_path + chunk_folder.name], capture_output=True)
        if status != 200:
            raise RuntimeError(f"ImportSourceControlledEntities failed at {offset}: HTTP {status} {str(body)[:300]}")
        print(f"  imported {min(offset + chunk_size, len(rows))}/{len(rows)} ({call_seconds[-1]:.1f} s for the last call)", flush=True)
    if staging_root.is_dir():
        shutil.rmtree(staging_root)
    return time.monotonic() - started, len(rows), call_seconds


def count_ready(client, names):
    """How many of `names` exist and are enabled (sampled when there are many)."""
    sample = names if len(names) <= 200 else names[:: max(1, len(names) // 200)]
    ready = 0
    for name in sample:
        status, body = client.get(f"Things/{urllib.parse.quote(name)}")
        if status == 200 and body.get("enabled") is not False:
            status, _ = client.svc(f"Things/{urllib.parse.quote(name)}", "GetOutgoingDependencies")
            ready += status == 200
    return ready, len(sample)


def delete_things(client, names, batch_size=500):
    for offset in range(0, len(names), batch_size):
        client.call(f"Things/{LOADER_THING}", "DeleteThings", {"batch": {"names": names[offset:offset + batch_size]}})


def trial(client, seed, size, batch_size, methods=("batch", "import")):
    rows = thing_plan(seed, size * 2, 1.0)
    batch_rows = [(name.replace(".T", ".Batch", 1), template, project) for name, template, project in rows[:size]]
    import_rows = [(name.replace(".T", ".Import", 1), template, project) for name, template, project in rows[size:]]
    results = {}
    if "batch" in methods:
        results["batch"] = trial_batch(client, batch_rows, batch_size)
    if "import" in methods:
        results["import"] = trial_import(client, import_rows, size)
    print(json.dumps(results, indent=2))
    delete_things(client, [row[0] for row in batch_rows + import_rows])
    return results


def trial_batch(client, batch_rows, batch_size):
    seconds, created, calls = create_by_batch(client, batch_rows, batch_size, log_every=5)
    return {"things": created, "seconds": round(seconds, 1), "things_per_second": round(created / seconds, 1),
                        "batch_size": batch_size, "slowest_call_seconds": round(max(calls), 1), "ready_sample": count_ready(client, [row[0] for row in batch_rows])}


def trial_import(client, import_rows, size):
    seconds, created, calls = create_by_import(client, import_rows, chunk_size=size)
    return {"things": created, "seconds": round(seconds, 1), "things_per_second": round(created / seconds, 1),
                         "slowest_call_seconds": round(max(calls), 1), "ready_sample": count_ready(client, [row[0] for row in import_rows])}


def summary(client):
    status, body = client.req("GET", "Things?maxItems=200000", timeout=600)
    things = [row["name"] for row in body["rows"] if row["name"].startswith("Lab.Perf.")]
    counts = {}
    for index in range(PROJECT_COUNT):
        status, body = client.svc(f"Projects/{project_name(index)}", "GetEntities")
        counts[project_name(index)] = len(body["rows"]) if status == 200 else None
    status, body = client.svc(f"ThingTemplates/{HUB_TEMPLATE}", "GetIncomingDependencies")
    return {"lab_things": len(things), "project_entities": counts, "hub_incoming": len(body["rows"]) if status == 200 else status,
            "packages": len([name for name in installed_packages(client) if name.startswith("LabPerf")])}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("build", "install", "trial", "things", "summary"))
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--count", type=int, default=100_000)
    parser.add_argument("--hub-share", type=float, default=1.0, help="share of the Things on the hub template")
    parser.add_argument("--method", choices=("batch", "import"), default="batch")
    parser.add_argument("--batch-size", type=int, default=250, help="Things per CreateThings call (keep each call under 30 s)")
    parser.add_argument("--chunk-size", type=int, default=5000, help="Things per ImportSourceControlledEntities call")
    parser.add_argument("--trial-size", type=int, default=1000)
    parser.add_argument("--trial-methods", default="batch,import", help="comma-separated: batch, import")
    arguments = parser.parse_args()
    WORK_FOLDER.mkdir(parents=True, exist_ok=True)
    if arguments.command == "build":
        plan = write_sources(arguments.seed, WORK_FOLDER)
        print(json.dumps({"packages": len(plan["packages"]), "entities_in_packages": plan["entities_in_packages"], "work": str(WORK_FOLDER)}))
        return
    client = throwaway_client()
    if arguments.command == "install":
        install(client, WORK_FOLDER)
    elif arguments.command == "trial":
        result = trial(client, arguments.seed, arguments.trial_size, arguments.batch_size, tuple(arguments.trial_methods.split(",")))
        (WORK_FOLDER / "trial.json").write_text(json.dumps(result, indent=2))
    elif arguments.command == "things":
        rows = thing_plan(arguments.seed, arguments.count, arguments.hub_share)
        existing = existing_thing_names(client)
        missing = [row for row in rows if row[0] not in existing]
        print(f"{len(rows)} planned, {len(existing)} present, {len(missing)} to create by {arguments.method}", flush=True)
        if arguments.method == "batch":
            seconds, created, calls = create_by_batch(client, missing, arguments.batch_size)
        else:
            seconds, created, calls = create_by_import(client, missing, arguments.chunk_size)
        record = {"method": arguments.method, "created": created, "seconds": round(seconds, 1), "slowest_call_seconds": round(max(calls or [0]), 1)}
        print(json.dumps(record))
        (WORK_FOLDER / f"things-{arguments.method}.json").write_text(json.dumps(record, indent=2))
    elif arguments.command == "summary":
        print(json.dumps(summary(client), indent=2))


if __name__ == "__main__":
    main()
