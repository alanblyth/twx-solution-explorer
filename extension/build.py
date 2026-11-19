#!/usr/bin/env python3
"""Build SolutionExplorer-<version>_json.zip and SolutionExplorer-<version>_xml.zip from extension/ and the Angular bundle in ui/.

  python extension/build.py [--no-ui-build] [--out DIR] [--version X.Y.Z]

--version replaces packageVersion in the zip's metadata.xml only (every import to a platform needs a higher version).
Both zips hold the same package; they differ only in the entity files. The _json zip has Entities/<Type>/<name>.json
(split files merged by thingworx_package.py), the _xml zip the same entities as Entities/<Type>/<name>.xml, for platforms
that do not import JSON entities. Each holds metadata.xml, ui/<widget>/*.js,
ui/se-common/se-elements.js (the Angular bundle, from ui/dist/explorer/main.js) and THIRD-PARTY-NOTICES.txt.

The licence notices of the third-party code in the bundle travel twice: at the top of se-elements.js as a /*! */ comment,
and as THIRD-PARTY-NOTICES.txt at the root of the zip. They come from Angular's extracted 3rdpartylicenses.txt, plus the
LICENSE file of any runtime dependency it leaves out (it misses @dagrejs/graphlib, which dagre pulls in).
"""
import argparse, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from thingworx_package import ENTITY_FORMATS, build_extension_zip   # noqa: E402

UI = os.path.join(HERE, "..", "ui")
DIST = os.path.join(UI, "dist", "explorer")
BUNDLE = os.path.join(DIST, "main.js")
EXTRACTED_LICENCES = os.path.join(DIST, "3rdpartylicenses.txt")
NODE_MODULES = os.path.join(UI, "node_modules")
LICENCE_FILE_NAMES = ("LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "license", "license.md")


def read_package_manifest(package_name):
    with open(os.path.join(NODE_MODULES, package_name, "package.json"), encoding="utf-8") as handle:
        return json.load(handle)


def runtime_packages():
    """Every package the app depends on at run time: ui/package.json's dependencies and theirs, without dev dependencies."""
    with open(os.path.join(UI, "package.json"), encoding="utf-8") as handle:
        pending = list(json.load(handle).get("dependencies", {}))
    found = []
    while pending:
        package_name = pending.pop(0)
        if package_name in found or not os.path.isdir(os.path.join(NODE_MODULES, package_name)):
            continue
        found.append(package_name)
        pending.extend(read_package_manifest(package_name).get("dependencies", {}))
    return sorted(found)


def licence_text(package_name):
    folder = os.path.join(NODE_MODULES, package_name)
    for file_name in LICENCE_FILE_NAMES:
        path = os.path.join(folder, file_name)
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as handle:
                return handle.read().strip()
    return None


def third_party_notices():
    """Angular's extracted notices, completed with any runtime package they leave out. Fails if a licence cannot be found."""
    if not os.path.isfile(EXTRACTED_LICENCES):
        sys.exit(f"{EXTRACTED_LICENCES} is missing: the production build must run with extractLicenses on")
    with open(EXTRACTED_LICENCES, encoding="utf-8") as handle:
        notices = handle.read().strip()
    listed = {line.split(":", 1)[1].strip() for line in notices.splitlines() if line.startswith("Package:")}
    missing_licences = []
    for package_name in runtime_packages():
        if package_name in listed:
            continue
        text = licence_text(package_name)
        if text is None:
            missing_licences.append(package_name)
            continue
        licence_name = read_package_manifest(package_name).get("license", "see text")
        notices += f"\n\n" + "-" * 80 + f"\n\nPackage: {package_name}\nLicense: \"{licence_name}\"\n\n{text}"
    if missing_licences:
        sys.exit("no licence file found for: " + ", ".join(missing_licences))
    header = "Solution Explorer includes the following third-party software, under the licences below.\n\n"
    return header + notices + "\n"


def bundle_with_notices(notices, output_dir):
    """The bundle with the notices as a leading /*! */ comment, which minifiers and tools keep."""
    with open(BUNDLE, encoding="utf-8") as handle:
        bundle = handle.read()
    comment = "/*!\n" + notices.replace("*/", "* /") + "*/\n"
    path = os.path.join(output_dir, "se-elements.js")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(comment + bundle)
    return path


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
    os.makedirs(options.out, exist_ok=True)
    notices = third_party_notices()
    bundle_path = bundle_with_notices(notices, options.out)
    for entity_format in ENTITY_FORMATS:   # the same package twice: JSON entities, and XML for platforms without JSON import
        path = build_extension_zip(HERE, options.out, version=options.version, entity_format=entity_format, extra_files={
            "ui/se-common/se-elements.js": bundle_path,
            "THIRD-PARTY-NOTICES.txt": notices.encode("utf-8"),
        })
        print(path)


if __name__ == "__main__":
    main()
