"""Run the throwaway `twx-test` platform for the performance measurements, never twx-dev.

It uses twxlab.env's private builder config (its own Compose project, port 18080, its own secrets) and sets the JVM heap.

  python tools/perf/platform.py up [--heap "-Xms2g -Xmx4g"]   start it, check the licence, print the base URL
  python tools/perf/platform.py status | stats | logs
  python tools/perf/platform.py reset                         stop it and delete its data volumes
  python tools/perf/platform.py env                           print the export lines for TWX_BASE and TWX_ADMIN_PASSWORD_FILE

The Administrator password stays in the work folder's file and is never printed.
"""
import argparse, json, os, shlex, subprocess, sys, tempfile
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
def find_knowledge_root():
    """twx-knowledge: TWX_KNOWLEDGE, else the first sibling folder of this checkout or of a parent (worktrees sit deeper)."""
    if os.environ.get("TWX_KNOWLEDGE"):
        return Path(os.environ["TWX_KNOWLEDGE"])
    for folder in REPOSITORY_ROOT.parents:
        if (folder / "twx-knowledge" / "twxlab").is_dir():
            return folder / "twx-knowledge"
    raise SystemExit("twx-knowledge not found: set TWX_KNOWLEDGE")


KNOWLEDGE_ROOT = find_knowledge_root()
sys.path.insert(0, str(KNOWLEDGE_ROOT))
from twxlab import env as twx_env   # noqa: E402

PROJECT_NAME = "twx-test"
HTTP_PORT = 18080
WORK_FOLDER = Path(os.environ.get("TWX_PERF_WORK") or Path(tempfile.gettempdir()) / "twx-solution-explorer-perf")
BASE_URL = f"http://localhost:{HTTP_PORT}/Thingworx"
PLATFORM_CONTAINER = f"{PROJECT_NAME}-platform-1"
POSTGRES_CONTAINER = f"{PROJECT_NAME}-postgresql-1"


def prepare(heap_options):
    """Write the builder config for twx-test with the given JVM options; refuses any other project or port."""
    builder_dir = twx_env._builder()
    python_exe = twx_env._python(builder_dir)
    WORK_FOLDER.mkdir(parents=True, exist_ok=True)
    config_path = twx_env._write_config(builder_dir, python_exe, WORK_FOLDER, PROJECT_NAME, HTTP_PORT)
    if heap_options:
        code = ("import sys, yaml; path, options = sys.argv[1:3]; config = yaml.safe_load(open(path)); "
                "config['deploy']['catalinaOpts'] = options; yaml.safe_dump(config, open(path, 'w'), sort_keys=False)")
        subprocess.run([python_exe, "-c", code, str(config_path), heap_options], check=True)
    check = ("import sys, yaml; deploy = yaml.safe_load(open(sys.argv[1]))['deploy']; "
             "print(deploy['project'], deploy['httpPort'], deploy['catalinaOpts'])")
    project, port, options = subprocess.run([python_exe, "-c", check, str(config_path)], check=True, capture_output=True,
                                            text=True).stdout.split(" ", 2)
    if project != PROJECT_NAME or int(port) != HTTP_PORT:
        raise SystemExit(f"refusing: config names {project}:{port}, not {PROJECT_NAME}:{HTTP_PORT}")
    twx_env._state.update(builder=builder_dir, python=python_exe, config=config_path, project=PROJECT_NAME, base=BASE_URL)
    return options.strip()


def password_file():
    secrets = WORK_FOLDER / "builder" / "deploy" / "secrets.env"
    values = dict(line.split("=", 1) for line in secrets.read_text().splitlines() if "=" in line and not line.startswith("#"))
    target = WORK_FOLDER / "admin-password"
    target.write_text(values["THINGWORX_INITIAL_ADMIN_PASSWORD"].strip())
    os.chmod(target, 0o600)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("up", "status", "stats", "logs", "reset", "env"))
    parser.add_argument("--heap", default="-Xms2g -Xmx4g", help="CATALINA_OPTS for the platform JVM")
    arguments = parser.parse_args()
    if arguments.command == "env":
        # Quoted, with forward slashes: an eval in Git Bash on Windows would otherwise drop the backslashes of the path.
        print(f"export TWX_BASE={shlex.quote(BASE_URL)}\nexport TWX_ADMIN_PASSWORD_FILE={shlex.quote(password_file().as_posix())}")
        return
    if arguments.command == "stats":
        subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}} {{.MemUsage}}",
                        PLATFORM_CONTAINER, POSTGRES_CONTAINER])
        return
    options = prepare(arguments.heap)
    if arguments.command == "up":
        print(f"[perf] starting {PROJECT_NAME} on {HTTP_PORT} with CATALINA_OPTS {options}", file=sys.stderr)
        result = twx_env._deploy("up", timeout=3600)
        if result.returncode:
            raise SystemExit(f"deploy.py up failed ({result.returncode})")
        twx_env._check_licence(BASE_URL, password_file().read_text())
        print(BASE_URL)
    else:
        sys.exit(twx_env._deploy(arguments.command, timeout=900).returncode)


if __name__ == "__main__":
    main()
