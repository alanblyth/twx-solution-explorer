#!/usr/bin/env python3
"""Replay Solution Explorer's REST patterns against twx-test and time each scenario (standard library only).

  eval "$(python tools/perf/platform.py env)"
  python tools/perf/measure.py                         every scenario
  python tools/perf/measure.py --scenarios list,open   a selection: list, open, open_uncapped, open_sequence, open_sequence_shared,
                                                       extensions, project, project_incoming, project_from_body,
                                                       project_incoming_from_body, trace, layout

Each scenario issues the requests the app issues, in the same order and at the same concurrency (`mapWithLimit` limits of
4, 6 and 8 from the components; Promise.all where the app uses it). A browser on HTTP/1.1 keeps at most 6 connections per
host, so the harness also caps its connections at 6: a limit of 8 in the app behaves like 6. Authentication is Basic once,
then the session cookie, as in the browser. The trace and layout scenarios run the app's own TypeScript in node
(tools/perf/node_bench.ts), so they measure the real resolver and dagre.

Recorded per scenario: wall time, request count, bytes received, latency percentiles per request kind, HTTP failures,
platform and database CPU and memory (`docker stats`, sampled), JVM heap in use (PlatformSubsystem.GetPlatformStats) and new
ERROR lines in the platform's ApplicationLog.log and ErrorLog.log. Results go to tools/perf/.work/results-<time>.json.
Not replayed: the browser-side work on the replies (script analysis, graph building, layout, rendering): see the in-browser
timings (the app's `?perf=1` flag).
"""
import argparse, base64, http.client, json, os, queue, statistics, subprocess, sys, threading, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
WORK_FOLDER = REPOSITORY_ROOT / "tools" / "perf" / ".work"
PLATFORM_CONTAINER = "twx-test-platform-1"
POSTGRES_CONTAINER = "twx-test-postgresql-1"
BROWSER_CONNECTIONS_PER_HOST = 6
LIST_COLLECTIONS = ("Things", "ThingTemplates", "ThingShapes", "DataShapes", "Mashups", "Projects")
SCRIPT_HOLDER_TYPES = {"Thing", "ThingTemplate", "ThingShape"}
HUB_TEMPLATE = "Lab.Perf.E00.TT.Device"
TRACE_ROOT = ("Things", "Lab.Perf.E32.Svc.0", "Run")


def collection_of_type(entity_type):
    special = {"Resource": "Resources", "Directory": "Directories", "Dashboard": "Dashboards"}
    return special.get(entity_type) or (entity_type if entity_type.endswith("s") else entity_type + "s")


class Platform:
    """Keep-alive HTTP connections (one per worker thread, at most 6) with request counters."""

    def __init__(self, base, password):
        location = urllib.parse.urlparse(base)
        if location.hostname not in ("localhost", "127.0.0.1") or location.port != 18080:
            raise SystemExit(f"refusing {base}: twx-test on localhost:18080 only")
        self.host, self.port, self.prefix = location.hostname, location.port, location.path.rstrip("/")
        self.authorization = "Basic " + base64.b64encode(f"Administrator:{password}".encode()).decode()
        self.cookie = None
        self.local = threading.local()
        self.lock = threading.Lock()
        self.connection_slots = threading.BoundedSemaphore(BROWSER_CONNECTIONS_PER_HOST)
        self.reset_counters()

    def reset_counters(self):
        with self.lock:
            self.requests, self.bytes_received, self.failures = 0, 0, {}
            self.latencies = {}

    def _connection(self):
        connection = getattr(self.local, "connection", None)
        if connection is None:
            connection = http.client.HTTPConnection(self.host, self.port, timeout=600)
            self.local.connection = connection
        return connection

    def request(self, method, path, body=None, kind="other"):
        """(status, parsed JSON or None, bytes). Counts the request under `kind`."""
        headers = {"Accept": "application/json", "X-XSRF-TOKEN": "TWX-XSRF-TOKEN-VALUE"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.cookie:
            headers["Cookie"] = self.cookie
        else:
            headers["Authorization"] = self.authorization
        payload = json.dumps(body).encode() if body is not None else None
        with self.connection_slots:
            started = time.perf_counter()
            for attempt in (1, 2):
                connection = self._connection()
                try:
                    connection.request(method, self.prefix + "/" + path, body=payload, headers=headers)
                    response = connection.getresponse()
                    data = response.read()
                    break
                except (http.client.HTTPException, ConnectionError, OSError):
                    connection.close()
                    self.local.connection = None
                    if attempt == 2:
                        raise
            elapsed = time.perf_counter() - started
        session = response.getheader("Set-Cookie") or ""
        if "JSESSIONID=" in session and not self.cookie:
            self.cookie = session.split(";", 1)[0]
        with self.lock:
            self.requests += 1
            self.bytes_received += len(data)
            self.latencies.setdefault(kind, []).append(elapsed)
            if response.status >= 400:
                key = f"{kind} {response.status}"
                self.failures[key] = self.failures.get(key, 0) + 1
        parsed = None
        if data.strip():
            try:
                parsed = json.loads(data)
            except ValueError:
                parsed = data[:300].decode(errors="replace")
        return response.status, parsed, len(data)

    def service(self, entity_path, name, body=None, kind=None):
        return self.request("POST", f"{entity_path}/Services/{name}", body or {}, kind or name)

    def counters(self):
        with self.lock:
            kinds = {}
            for kind, values in self.latencies.items():
                ordered = sorted(values)
                kinds[kind] = {"count": len(ordered), "p50_ms": round(ordered[len(ordered) // 2] * 1000, 1),
                               "p95_ms": round(ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))] * 1000, 1),
                               "max_ms": round(ordered[-1] * 1000, 1), "total_s": round(sum(ordered), 1)}
            return {"requests": self.requests, "bytes": self.bytes_received, "failures": dict(self.failures), "by_kind": kinds}


def map_with_limit(items, limit, work):
    """The app's mapWithLimit: at most `limit` in flight, results in order."""
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=min(limit, len(items))) as pool:
        return list(pool.map(work, items))


class Sampler(threading.Thread):
    """Samples docker stats and the JVM heap every `interval` seconds until stopped."""

    def __init__(self, platform, interval=2.0):
        super().__init__(daemon=True)
        self.platform, self.interval = platform, interval
        self.samples = []
        self.stopping = threading.Event()

    @staticmethod
    def docker_stats():
        output = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}",
                                 PLATFORM_CONTAINER, POSTGRES_CONTAINER], capture_output=True, text=True, timeout=30).stdout
        found = {}
        for line in output.splitlines():
            name, cpu, memory = line.split("\t")
            used = memory.split("/")[0].strip()
            number = float(used[:-3]) if used[-3:] in ("GiB", "MiB", "KiB") else 0.0
            scale = {"GiB": 1024, "MiB": 1, "KiB": 1 / 1024}.get(used[-3:], 1)
            found["platform" if "platform" in name else "postgres"] = {"cpu_percent": float(cpu.rstrip("%")), "memory_mb": round(number * scale)}
        return found

    def heap(self):
        connection = http.client.HTTPConnection(self.platform.host, self.platform.port, timeout=30)
        try:
            connection.request("POST", self.platform.prefix + "/Subsystems/PlatformSubsystem/Services/GetPlatformStats", body=b"{}",
                               headers={"Accept": "application/json", "Content-Type": "application/json", "Authorization": self.platform.authorization})
            row = json.loads(connection.getresponse().read())["rows"][0]
            return round(row["memoryInUse"] / 1048576), round(row["totalMemoryAllocated"] / 1048576)
        except Exception:
            return None, None
        finally:
            connection.close()

    def run(self):
        while not self.stopping.is_set():
            sample = {"time": time.time(), **self.docker_stats()}
            sample["heap_in_use_mb"], sample["heap_allocated_mb"] = self.heap()
            self.samples.append(sample)
            self.stopping.wait(self.interval)

    def summary(self):
        def peak(path):
            values = [sample[path[0]][path[1]] if len(path) == 2 else sample[path[0]] for sample in self.samples
                      if (path[0] in sample and (len(path) == 1 or path[1] in sample[path[0]]))]
            values = [value for value in values if value is not None]
            return (max(values), round(statistics.mean(values), 1)) if values else (None, None)
        platform_cpu_peak, platform_cpu_mean = peak(("platform", "cpu_percent"))
        postgres_cpu_peak, postgres_cpu_mean = peak(("postgres", "cpu_percent"))
        heap_peak, heap_mean = peak(("heap_in_use_mb",))
        memory_peak, _ = peak(("platform", "memory_mb"))
        return {"samples": len(self.samples), "platform_cpu_peak_percent": platform_cpu_peak, "platform_cpu_mean_percent": platform_cpu_mean,
                "postgres_cpu_peak_percent": postgres_cpu_peak, "postgres_cpu_mean_percent": postgres_cpu_mean,
                "heap_in_use_peak_mb": heap_peak, "heap_in_use_mean_mb": heap_mean, "platform_container_memory_peak_mb": memory_peak}


def log_line_counts():
    output = subprocess.run(["docker", "exec", PLATFORM_CONTAINER, "sh", "-c",
                             "wc -l < /ThingworxStorage/logs/ApplicationLog.log; wc -l < /ThingworxStorage/logs/ErrorLog.log"],
                            capture_output=True, text=True).stdout.split()
    return [int(value) for value in output] if len(output) == 2 else [0, 0]


def new_error_lines(before):
    found = []
    for log_name, start in zip(("ApplicationLog.log", "ErrorLog.log"), before):
        output = subprocess.run(["docker", "exec", PLATFORM_CONTAINER, "sh", "-c", f"tail -n +{start + 1} /ThingworxStorage/logs/{log_name} | grep -E ' (ERROR|WARN) '"],
                                capture_output=True, text=True).stdout.splitlines()
        found += [f"{log_name}: {line[:260]}" for line in output]
    return found


def run_scenario(platform, name, work):
    """Time `work(platform)` with counters, sampling and the log check. Returns the record."""
    platform.reset_counters()
    logs_before = log_line_counts()
    sampler = Sampler(platform)
    sampler.start()
    started = time.perf_counter()
    error = None
    try:
        details = work(platform)
    except Exception as failure:   # a scenario that breaks is a result too
        details, error = {}, f"{type(failure).__name__}: {failure}"
    seconds = time.perf_counter() - started
    sampler.stopping.set()
    sampler.join()
    errors = new_error_lines(logs_before)
    counters = platform.counters()
    if isinstance(details, dict) and "requests" in details and not counters["requests"]:   # node made the requests itself
        counters.update(requests=details["requests"], bytes=details["bytes"])
    record = {"scenario": name, "seconds": round(seconds, 2), **counters, "resources": sampler.summary(),
              "log_errors": len([line for line in errors if " ERROR " in line]), "log_warnings": len([line for line in errors if " WARN " in line]),
              "log_samples": errors[:6], "details": details}
    if error:
        record["error"] = error
    print(f"{name}: {record['seconds']} s, {record['requests']} requests, {record['bytes'] / 1e6:.1f} MB"
          f"{', ERROR ' + error if error else ''}", flush=True)
    return record


# ---------------------------------------------------------------- scenarios

def scenario_list(platform):
    """The Entities tab's search: GET /<collection>?maxItems=20000 once per collection, then filtered in the browser."""
    found = {}
    for collection in LIST_COLLECTIONS:
        started = time.perf_counter()
        status, body, size = platform.request("GET", f"{collection}?maxItems=20000", kind=f"list {collection}")
        rows = len(body["rows"]) if status == 200 else 0
        found[collection] = {"status": status, "rows": rows, "bytes": size, "seconds": round(time.perf_counter() - started, 2),
                             "capped": rows == 20000}
    started = time.perf_counter()
    status, body, size = platform.request("GET", "Things?maxItems=200000", kind="list Things uncapped")
    found["Things (maxItems=200000)"] = {"status": status, "rows": len(body["rows"]) if status == 200 else 0, "bytes": size,
                                         "seconds": round(time.perf_counter() - started, 2)}
    for mask in ("Lab.Perf.P05.T*", "Lab.Perf.P00.T00001*"):
        started = time.perf_counter()
        status, body, size = platform.request("GET", f"Things?nameMask={urllib.parse.quote(mask)}&maxItems=500", kind="list nameMask")
        found[f"Things nameMask={mask}"] = {"status": status, "rows": len(body["rows"]) if status == 200 else 0, "bytes": size,
                                            "seconds": round(time.perf_counter() - started, 2)}
    return found


def open_entity(platform, collection, name, incoming_limit=None, shared_bodies=None):
    """The Entities tab's choose(): dependencies both ways, services, the body and the inheritance chain, all at once.
    shared_bodies: the 0.2.x pattern when None (bodies cached per choice, and the resolver reads the body again); a dict kept
    across calls replays the shared entity cache (each body read once, whichever view asks)."""
    entity_type = collection[:-1]
    bodies = shared_bodies if shared_bodies is not None else {}
    bodies_lock = threading.Lock()

    def read(read_collection, read_name):
        key = f"{read_collection}/{read_name}"
        with bodies_lock:
            if key in bodies:
                return bodies[key]
        status, body, _ = platform.request("GET", f"{read_collection}/{urllib.parse.quote(read_name)}", kind="entity GET")
        with bodies_lock:
            bodies[key] = body if status == 200 else None
        return bodies[key]

    def inheritance():
        body = read(collection, name)
        levels = 1
        base = (body or {}).get("thingTemplate" if collection == "Things" else "baseThingTemplate")
        while base:
            template = read("ThingTemplates", base)
            levels += 1
            base = (template or {}).get("baseThingTemplate")
        return levels

    tasks = {
        "outgoing": lambda: platform.service(f"{collection}/{urllib.parse.quote(name)}", "GetOutgoingDependencies"),
        # the app sends {}: the service then returns at most 500 rows (its maxItems default)
        "incoming": lambda: platform.service(f"{collection}/{urllib.parse.quote(name)}", "GetIncomingDependencies",
                                             {"maxItems": incoming_limit} if incoming_limit else {}),
        # 0.2.x: the resolver keeps its own cache, so listServices reads the body a second time
        "services": (lambda: read(collection, name)) if shared_bodies is not None else
                    (lambda: platform.request("GET", f"{collection}/{urllib.parse.quote(name)}", kind="entity GET")),
        "inheritance": inheritance,
        "data things": lambda: [platform.service(f"ThingTemplates/{template}", "GetImplementingThings") for template in ("DataTable", "Stream", "ValueStream")],
    }
    started = {}
    finished = {}
    with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
        def timed(item):
            label, work = item
            started[label] = time.perf_counter()
            result = work()
            finished[label] = time.perf_counter()
            return label, result
        results = dict(pool.map(timed, tasks.items()))
    status, body, size = results["incoming"]
    return {"entity": f"{collection}/{name}", "incoming_rows": len(body["rows"]) if status == 200 else status, "incoming_bytes": size,
            "incoming_seconds": round(finished["incoming"] - started["incoming"], 2),
            "outgoing_rows": len(results["outgoing"][1]["rows"]) if results["outgoing"][0] == 200 else results["outgoing"][0],
            "inheritance_levels": results["inheritance"]}


def scenario_open(platform):
    return {"hub template": open_entity(platform, "ThingTemplates", HUB_TEMPLATE),
            "a Thing (baseline)": open_entity(platform, "Things", "Lab.Perf.P03.T000000"),
            "a chained template (baseline)": open_entity(platform, "ThingTemplates", "Lab.Perf.E32.TT.Device")}


OPEN_SEQUENCE = (("ThingTemplates", HUB_TEMPLATE), ("Things", "Lab.Perf.P03.T000000"), ("Things", "Lab.Perf.P02.T000001"),
                 ("Things", "Lab.Perf.P05.T000002"), ("ThingTemplates", "Lab.Perf.E32.TT.Device"), ("ThingTemplates", "Lab.Perf.E33.TT.Device"))


def scenario_open_sequence(platform, shared):
    """A user browsing: the hub, three of its Things, then two chained templates, one after another."""
    shared_bodies = {} if shared else None
    for collection, name in OPEN_SEQUENCE:
        open_entity(platform, collection, name, shared_bodies=shared_bodies)
    return {"opened": len(OPEN_SEQUENCE), "shared_cache": shared}


def package_list(platform):
    status, body, _ = platform.request("GET", "ExtensionPackages", kind="ExtensionPackages")
    names = [row["name"] for row in body["rows"]]
    map_with_limit(names, 6, lambda name: platform.request("GET", f"ExtensionPackages/{urllib.parse.quote(name)}", kind="ExtensionPackage GET"))
    return names


def scenario_extensions(platform):
    """The Extensions tab's scan."""
    phase = {}
    started = time.perf_counter()
    names = package_list(platform)
    phase["read extensions_s"] = round(time.perf_counter() - started, 2)
    started = time.perf_counter()
    member_lists = map_with_limit(names, 4, lambda name: platform.service("Subsystems/PlatformSubsystem", "GetExtensionPackageDetails", {"packageName": name})[1]["rows"])
    members = [(row["type"], row["name"]) for rows in member_lists for row in rows]
    phase["list entities_s"] = round(time.perf_counter() - started, 2)
    started = time.perf_counter()
    statuses = {}

    def dependency(member):
        entity_type, name = member
        status, body, _ = platform.service(f"{collection_of_type(entity_type)}/{urllib.parse.quote(name)}", "GetOutgoingDependencies")
        if status == 503:
            platform.request("GET", f"{collection_of_type(entity_type)}/{urllib.parse.quote(name)}", kind="entity GET (disabled)")
        statuses[status] = statuses.get(status, 0) + 1
    map_with_limit(members, 8, dependency)
    phase["read dependencies_s"] = round(time.perf_counter() - started, 2)
    return {"packages": len(names), "members": len(members), "statuses": statuses, "phases": phase,
            "member_types": {entity_type: sum(1 for member in members if member[0] == entity_type) for entity_type in sorted({member[0] for member in members})}}


def scenario_open_uncapped(platform):
    """What opening the hub costs once the app asks for every incoming row (maxItems 200000)."""
    return {"hub template, maxItems 200000": open_entity(platform, "ThingTemplates", HUB_TEMPLATE, incoming_limit=200000)}


def biggest_project(platform):
    status, body, _ = platform.request("GET", "Projects?maxItems=20000", kind="untimed")
    names = [row["name"] for row in body["rows"] if row["name"].startswith("Lab.Perf.P")]
    sizes = map_with_limit(names, 6, lambda name: (len(platform.service(f"Projects/{name}", "GetEntities", kind="untimed")[1]["rows"]), name))
    return max(sizes)


def scan_project(platform, name, read_incoming, read_calls, things_from_body=False):
    """The Projects & Extensions tab's scan of one project. things_from_body: a Thing whose body is read for its scripts
    takes its outgoing dependencies from that body instead of calling GetOutgoingDependencies."""
    phase = {}
    started = time.perf_counter()
    listed = platform.service(f"Projects/{urllib.parse.quote(name)}", "GetEntities", kind="GetEntities (own)")[1]["rows"]
    members = {(row["type"], row["name"]) for row in listed if not (row["type"] == "Project" and row["name"] == name)}
    members = sorted(members)
    status, body, _ = platform.request("GET", "Projects?maxItems=20000", kind="list Projects")
    others = [row["name"] for row in body["rows"] if row["name"] != name]
    phase["list entities_s"] = round(time.perf_counter() - started, 2)
    started = time.perf_counter()
    owned_rows = map_with_limit(others, 6, lambda other: len((platform.service(f"Projects/{urllib.parse.quote(other)}", "GetEntities", kind="GetEntities (others)")[1] or {}).get("rows", [])))
    phase["read other projects_s"] = round(time.perf_counter() - started, 2)
    started = time.perf_counter()

    def member_work(member):
        entity_type, member_name = member
        path = f"{collection_of_type(entity_type)}/{urllib.parse.quote(member_name)}"
        if things_from_body and read_calls and entity_type == "Thing":
            platform.request("GET", path, kind="entity GET")
            if read_incoming:
                platform.service(path, "GetIncomingDependencies")
            return
        status, _, _ = platform.service(path, "GetOutgoingDependencies")
        if status == 503:
            platform.request("GET", path, kind="entity GET")
        if read_incoming:
            platform.service(path, "GetIncomingDependencies")
        if read_calls and entity_type in SCRIPT_HOLDER_TYPES and status not in (403, 404):
            if status != 503:
                platform.request("GET", path, kind="entity GET")
    map_with_limit(members, 8, member_work)
    phase["read dependencies_s"] = round(time.perf_counter() - started, 2)
    started = time.perf_counter()
    for template in ("DataTable", "Stream", "ValueStream"):
        platform.service(f"ThingTemplates/{template}", "GetImplementingThings")
    phase["data things_s"] = round(time.perf_counter() - started, 2)
    return {"project": name, "members": len(members), "other_projects": len(others), "rows_in_other_projects": sum(owned_rows),
            "read_incoming": read_incoming, "read_calls": read_calls, "things_from_body": things_from_body, "phases": phase}


def run_node(arguments, timeout=3600):
    output = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", str(REPOSITORY_ROOT / "tools" / "perf" / "node_bench.ts"), *arguments],
                            capture_output=True, text=True, timeout=timeout, env=os.environ)
    if output.returncode:
        raise RuntimeError(output.stderr[-600:])
    return json.loads(output.stdout.strip().splitlines()[-1])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scenarios", default="list,open,open_uncapped,extensions,project,project_incoming,trace,layout")
    parser.add_argument("--project", help="project to scan (default: the biggest Lab.Perf project)")
    parser.add_argument("--label", default="", help="label stored with the results")
    parser.add_argument("--layout-sizes", default="500,2000", help="node counts for the layout scenario")
    parser.add_argument("--layout-timeout", type=int, default=1800, help="seconds before a layout run is recorded as not finished")
    arguments = parser.parse_args()
    base = os.environ.get("TWX_BASE", "")
    password = Path(os.environ["TWX_ADMIN_PASSWORD_FILE"]).read_text().strip()
    platform = Platform(base, password)
    platform.request("GET", "Things/Lab.Perf.Loader", kind="sign-in")   # takes the session cookie
    chosen = arguments.scenarios.split(",")
    results = {"label": arguments.label, "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "base": base, "scenarios": []}
    project_name = arguments.project
    if any(name.startswith("project") for name in chosen) and not project_name:
        size, project_name = biggest_project(platform)
        print(f"biggest project: {project_name} ({size} entities)", flush=True)
    work = {
        "list": scenario_list,
        "open": scenario_open,
        "open_uncapped": scenario_open_uncapped,
        "extensions": scenario_extensions,
        "project": lambda client: scan_project(client, project_name, read_incoming=False, read_calls=True),
        "project_incoming": lambda client: scan_project(client, project_name, read_incoming=True, read_calls=True),
        "project_from_body": lambda client: scan_project(client, project_name, read_incoming=False, read_calls=True, things_from_body=True),
        "project_incoming_from_body": lambda client: scan_project(client, project_name, read_incoming=True, read_calls=True, things_from_body=True),
        "open_sequence": lambda client: scenario_open_sequence(client, shared=False),
        "open_sequence_shared": lambda client: scenario_open_sequence(client, shared=True),
    }
    WORK_FOLDER.mkdir(parents=True, exist_ok=True)
    output_path = WORK_FOLDER / f"results-{time.strftime('%Y%m%d-%H%M%S')}.json"

    def save():   # after every scenario, so a run that breaks later keeps what it measured
        output_path.write_text(json.dumps(results, indent=2))

    for name in chosen:
        if name in work:
            results["scenarios"].append(run_scenario(platform, name, work[name]))
        elif name == "trace":
            collection, entity, service = TRACE_ROOT
            for depth in (4, 8):
                results["scenarios"].append(run_scenario(platform, f"trace depth {depth}", lambda client, depth=depth: run_node(["trace", collection, entity, service, str(depth)])))
        elif name == "layout":
            for count in (int(size) for size in arguments.layout_sizes.split(",")):
                started = time.perf_counter()
                try:
                    record = run_node(["layout", str(count)], timeout=arguments.layout_timeout)
                except subprocess.TimeoutExpired:
                    record = {"scenario": "layout", "nodes": count, "not_finished_after_seconds": arguments.layout_timeout}
                record["seconds"] = round(time.perf_counter() - started, 2)
                results["scenarios"].append({**record, "scenario": f"layout {count} (node)"})
                print(f"layout {count}: {record}", flush=True)
        save()
    save()
    print(f"results: {output_path}")


if __name__ == "__main__":
    main()
