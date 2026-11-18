#!/usr/bin/env python3
"""Build SolutionExplorer-<version>.zip from extension/ and the Angular bundle in ui/.

  python extension/build.py [--no-ui-build] [--out DIR] [--version X.Y.Z]

--version replaces packageVersion in the zip's metadata.xml only (every import to a platform needs a higher version).
The zip holds metadata.xml, Entities/<Type>/<name>.json (split files merged by twxlab), ui/<widget>/*.js and
ui/se-common/se-elements.js (the Angular bundle, from ui/dist/explorer/main.js).
"""
import argparse, os, subprocess, sys
from twxlab.extension import build_extension_zip

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, "..", "ui")
BUNDLE = os.path.join(UI, "dist", "explorer", "main.js")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-ui-build", action="store_true", help="use the bundle already in ui/dist")
    parser.add_argument("--out", default=os.path.join(HERE, "..", "build"))
    parser.add_argument("--version", default=None)
    options = parser.parse_args()
    if not options.no_ui_build:
        subprocess.run(["npm", "run", "build"], cwd=UI, check=True)
    if not os.path.isfile(BUNDLE):
        sys.exit(f"{BUNDLE} is missing: build the UI first")
    path = build_extension_zip(HERE, options.out, version=options.version, extra_files={"ui/se-common/se-elements.js": BUNDLE})
    print(path)


if __name__ == "__main__":
    main()
