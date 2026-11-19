"""Write the extension's entities as ThingWorx JSON source, and build the extension zip from them.

Self-contained (standard library only), so the extension builds without any other repository. Copied from twxlab 0.3.0
(twx-knowledge: `twxlab/entities.py`, `twxlab/extension.py` and the Project and Mashup skeletons of `twxlab/_skeletons.py`),
keeping only what Solution Explorer uses. Behaviour is unchanged; if twxlab fixes any of it, port the fix here.

The source form is the platform's own JSON source-control export (ExportSourceControlledEntities, exportFormat "json"): one
folder per entity under Entities/<Type>/<name>/ holding <name>.json, and a mashup's content as MashupContent/<name>.mp.json.
An extension import does not merge the split files, so `build_extension_zip` folds each entity folder into one document.
"""
import copy, io, json, os, re, zipfile
from collections import namedtuple

VERSION_PATTERN = re.compile(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?")
PACKAGE_TAG = re.compile(r"<ExtensionPackage\b[^>]*>")
UNIVERSAL = "multiPartSourceControl;password;sourceControl"

# Skeletons from the JSON source-control export of a minimal entity of each kind on ThingWorx 10.2.1 b148.
SKELETONS = json.loads(r'''
{
 "Projects": {
  "entity": {
   "artifactId": "",
   "aspects": {
    "projectType": "Component"
   },
   "avatar": "",
   "configurationTableDefinitions": {},
   "configurationTables": {},
   "dependsOn": "{\"extensions\":\"\",\"projects\":\"\"}",
   "description": "",
   "designTimePermissions": {
    "Create": [],
    "Delete": [],
    "Metadata": [],
    "Read": [],
    "Update": []
   },
   "documentationContent": "",
   "groupId": "",
   "homeMashup": "",
   "minPlatformVersion": "",
   "name": "",
   "packageVersion": "0.0.0",
   "projectName": "",
   "publishResult": "",
   "runTimePermissions": {
    "permissions": [
     {
      "EventInvoke": [],
      "EventSubscribe": [],
      "PropertyRead": [],
      "PropertyWrite": [],
      "ServiceInvoke": [],
      "resourceName": "*"
     }
    ]
   },
   "state": "DRAFT",
   "tags": [],
   "visibilityPermissions": {
    "Visibility": []
   }
  },
  "entry": "Project",
  "root": "Projects",
  "universal": "multiPartSourceControl;password;sourceControl"
 },
 "Mashups": {
  "entity": {
   "aspects": {
    "isFlex": "true",
    "isResponsive": true,
    "mashupType": "mashup"
   },
   "avatar": "",
   "columns": 0.0,
   "configurationTableDefinitions": {},
   "configurationTables": {
    "MobileSettings": {
     "aspects": {},
     "dataShape": {
      "fieldDefinitions": {
       "disableZoom": {
        "aspects": {
         "defaultValue": false,
         "friendlyName": "Disable Zoom"
        },
        "baseType": "BOOLEAN",
        "description": "Disables zooming in and out within the mashup",
        "name": "disableZoom",
        "ordinal": 0
       },
       "fullScreenMode": {
        "aspects": {
         "defaultValue": true,
         "friendlyName": "Full Screen Mode"
        },
        "baseType": "BOOLEAN",
        "description": "Open the mashup in full screen mode",
        "name": "fullScreenMode",
        "ordinal": 0
       },
       "height": {
        "aspects": {
         "friendlyName": "Height"
        },
        "baseType": "STRING",
        "description": "The height of the mashup page",
        "name": "height",
        "ordinal": 0
       },
       "heightType": {
        "aspects": {
         "defaultValue": "device-height",
         "friendlyName": "Height Type"
        },
        "baseType": "STRING",
        "description": "Use the height of the device display, or a custom height (in px)",
        "name": "heightType",
        "ordinal": 0
       },
       "initialScale": {
        "aspects": {
         "defaultValue": 1.0,
         "friendlyName": "Initial Scale"
        },
        "baseType": "NUMBER",
        "description": "The initial zoom scale when the mashup is loaded for the first time",
        "name": "initialScale",
        "ordinal": 0
       },
       "iosShortcutIconTitle": {
        "aspects": {
         "friendlyName": "Shortcut Icon Title"
        },
        "baseType": "STRING",
        "description": "A title for the mashup shortcut on the iOS home screen",
        "name": "iosShortcutIconTitle",
        "ordinal": 0
       },
       "iosStatusBarAppearance": {
        "aspects": {
         "defaultValue": "black-translucent",
         "friendlyName": "Status Bar Appearance"
        },
        "baseType": "STRING",
        "description": "The style of the iOS status bar",
        "name": "iosStatusBarAppearance",
        "ordinal": 0
       },
       "maximumScale": {
        "aspects": {
         "defaultValue": 10.0,
         "friendlyName": "Maximum Scale"
        },
        "baseType": "NUMBER",
        "description": "The maximum scale that users can zoom out to",
        "name": "maximumScale",
        "ordinal": 0
       },
       "minimumScale": {
        "aspects": {
         "defaultValue": 0.1,
         "friendlyName": "Minimum Scale"
        },
        "baseType": "NUMBER",
        "description": "The minimum scale that users can zoom out to",
        "name": "minimumScale",
        "ordinal": 0
       },
       "width": {
        "aspects": {
         "friendlyName": "Width"
        },
        "baseType": "STRING",
        "description": "The width of the mashup page",
        "name": "width",
        "ordinal": 0
       },
       "widthType": {
        "aspects": {
         "defaultValue": "device-width",
         "friendlyName": "Width Type"
        },
        "baseType": "STRING",
        "description": "Use the width of the device display, or a custom width (in px)",
        "name": "widthType",
        "ordinal": 0
       }
      }
     },
     "dataShapeName": "",
     "description": "Mashup Mobile Settings",
     "isHidden": true,
     "isMultiRow": false,
     "name": "MobileSettings",
     "ordinal": 0,
     "rows": [
      {
       "disableZoom": false,
       "fullScreenMode": true,
       "height": "",
       "heightType": "device-height",
       "initialScale": 1.0,
       "iosShortcutIconTitle": "",
       "iosStatusBarAppearance": "black-translucent",
       "maximumScale": 10.0,
       "minimumScale": 0.1,
       "width": "",
       "widthType": "device-width"
      }
     ]
    }
   },
   "description": "",
   "designTimePermissions": {
    "Create": [],
    "Delete": [],
    "Metadata": [],
    "Read": [],
    "Update": []
   },
   "documentationContent": "",
   "homeMashup": "",
   "name": "",
   "parameterDefinitions": {},
   "preview": "",
   "projectName": "",
   "rows": 0.0,
   "runTimePermissions": {
    "permissions": [
     {
      "EventInvoke": [],
      "EventSubscribe": [],
      "PropertyRead": [],
      "PropertyWrite": [],
      "ServiceInvoke": [],
      "resourceName": "*"
     }
    ]
   },
   "tags": [],
   "thingShapes": [],
   "thingTemplates": [],
   "things": [],
   "visibilityPermissions": {
    "Visibility": []
   }
  },
  "entry": "Mashup",
  "root": "Mashups",
  "universal": "multiPartSourceControl;password;sourceControl"
 }
}
''')

# services and subscriptions: {name: (definition, script text)}, Things only; mashup_content: dict, Mashups only
Entity = namedtuple("Entity", "kind name document services subscriptions mashup_content", defaults=({}, None))


class MergeError(ValueError):
    """An entity folder holds files that the merge does not handle yet."""


# ---------------------------------------------------------------------------------------------------------------- entities

def _document(kind, name, description, project_name, **fields):
    skeleton = SKELETONS[kind]
    entity = copy.deepcopy(skeleton["entity"])
    entity.update(name=name, description=description, projectName=project_name, **fields)
    return {skeleton["root"]: {skeleton["entry"]: [entity]}, "universal": skeleton["universal"] or UNIVERSAL}


def entity_of(document):
    """The one entity dictionary inside a source-control document."""
    root_key = next(key for key in document if key != "universal")
    return next(iter(document[root_key].values()))[0]


def project(name, package_version, description="", depends_on=""):
    """A project. Its JSON must carry packageVersion: without it the first import works and a bumped re-import fails with
    'this._entityVersion is null', leaving a corrupt package."""
    return Entity("Projects", name, _document("Projects", name, description, name, packageVersion=package_version,
                                              **({"dependsOn": depends_on} if depends_on else {})), {})


def mashup(name, content, description="", project_name="", parameters=None):
    """A mashup. content: the mashup's content as a dict (what Composer stores, {"Widgets": {...}, ...}); it is kept out of the
    entity JSON, as the export does, and written to MashupContent/<name>.mp.json. parameters: {name: base type}."""
    document = _document("Mashups", name, description, project_name)
    entity_of(document)["parameterDefinitions"] = {key: {"aspects": {"bindingDirection": "IN", "isMandatory": False}, "baseType": base_type,
                                                         "description": "", "name": key, "ordinal": ordinal}
                                                   for ordinal, (key, base_type) in enumerate((parameters or {}).items())}
    return Entity("Mashups", name, document, {}, {}, content)


def write_entity(source_dir, entity):
    """Write the entity in the committed layout under <source_dir>/Entities/<Type>/<name>/. Returns the entity folder."""
    folder = os.path.join(source_dir, "Entities", entity.kind, entity.name)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, entity.name + ".json"), "w", encoding="utf-8") as handle:
        json.dump(entity.document, handle, indent=2, ensure_ascii=False)
    for sub_folder, scripted in (("Services", entity.services), ("Subscriptions", entity.subscriptions)):
        if not scripted:
            continue
        os.makedirs(os.path.join(folder, sub_folder), exist_ok=True)
        for script_name, (definition, script) in scripted.items():
            with open(os.path.join(folder, sub_folder, script_name + ".mp.json"), "w", encoding="utf-8") as handle:
                json.dump(definition, handle, indent=2, ensure_ascii=False)
            with open(os.path.join(folder, sub_folder, script_name + ".mp.js"), "w", encoding="utf-8") as handle:
                handle.write(script)
    if entity.mashup_content is not None:
        content_folder = os.path.join(folder, "MashupContent")
        os.makedirs(content_folder, exist_ok=True)
        with open(os.path.join(content_folder, entity.name + ".mp.json"), "w", encoding="utf-8") as handle:
            json.dump(entity.mashup_content, handle, indent=2, ensure_ascii=False)
        open(os.path.join(content_folder, entity.name + ".mp.css"), "w").close()
    return folder


def merge_entity(entity_dir, name):
    """The entity's JSON as one document, with its service definitions and scripts, or its mashup content, merged in.
    Raises MergeError for a non-empty custom CSS, which is not merged yet."""
    with open(os.path.join(entity_dir, name + ".json"), encoding="utf-8") as handle:
        document = json.load(handle)
    entity = entity_of(document)
    shape = entity.get("thingShape", entity)   # a Thing or template holds its shape in "thingShape"; a Thing Shape is the shape
    services_folder = os.path.join(entity_dir, "Services")
    if os.path.isdir(services_folder):
        for file_name in sorted(os.listdir(services_folder)):
            if not file_name.endswith(".mp.json"):
                continue
            service_name = file_name[: -len(".mp.json")]
            with open(os.path.join(services_folder, file_name), encoding="utf-8") as handle:
                definition = json.load(handle)
            with open(os.path.join(services_folder, service_name + ".mp.js"), encoding="utf-8") as handle:
                script = handle.read()
            implementation = shape.get("serviceImplementations", {}).get(service_name)
            if implementation is None:
                raise MergeError(f"{name}: service {service_name} has files but no serviceImplementations entry in {name}.json")
            if not shape.get("serviceDefinitions"):
                shape["serviceDefinitions"] = {}
            shape["serviceDefinitions"][service_name] = definition
            implementation["configurationTables"]["Script"]["rows"][0] = {"code": script}
    subscriptions_folder = os.path.join(entity_dir, "Subscriptions")
    if os.path.isdir(subscriptions_folder):
        subscriptions = shape.setdefault("subscriptions", {})
        for file_name in sorted(os.listdir(subscriptions_folder)):
            if not file_name.endswith(".mp.json"):
                continue
            subscription_name = file_name[: -len(".mp.json")]
            with open(os.path.join(subscriptions_folder, file_name), encoding="utf-8") as handle:
                definition = json.load(handle)
            with open(os.path.join(subscriptions_folder, subscription_name + ".mp.js"), encoding="utf-8") as handle:
                script = handle.read()
            entry = subscriptions.get(subscription_name)
            if entry is None:
                raise MergeError(f"{name}: subscription {subscription_name} has files but no subscriptions entry in {name}.json")
            implementation = entry["serviceImplementation"]
            implementation["configurationTables"]["Script"]["rows"][0] = {"code": script}
            subscriptions[subscription_name] = {**definition, "serviceImplementation": implementation}
    content_folder = os.path.join(entity_dir, "MashupContent")
    if os.path.isdir(content_folder):
        with open(os.path.join(content_folder, name + ".mp.json"), encoding="utf-8") as handle:
            entity["mashupContent"] = handle.read()
        css_path = os.path.join(content_folder, name + ".mp.css")
        if os.path.isfile(css_path) and os.path.getsize(css_path):
            raise MergeError(f"{name}: a non-empty .mp.css is not merged yet")
    return json.dumps(document, indent=2, ensure_ascii=False).encode("utf-8")


def merged_entity_files(source_dir):
    """(archive name, bytes) for every entity under <source_dir>/Entities: one merged JSON file per entity folder, and flat
    .json files as they are."""
    base = os.path.join(source_dir, "Entities")
    if not os.path.isdir(base):
        return
    for kind in sorted(os.listdir(base)):
        for entry in sorted(os.listdir(os.path.join(base, kind))):
            path = os.path.join(base, kind, entry)
            if os.path.isdir(path):
                yield f"Entities/{kind}/{entry}.json", merge_entity(path, entry)
            elif os.path.isfile(path):
                with open(path, "rb") as handle:
                    yield f"Entities/{kind}/{entry}", handle.read()


# ------------------------------------------------------------------------------------------------------------- package zip

def _attribute(tag, name):
    found = re.search(rf'\b{name}="([^"]*)"', tag)
    return found.group(1) if found else None


def read_metadata(package):
    """(name, version) from a package given as a path or as bytes."""
    with zipfile.ZipFile(io.BytesIO(package) if isinstance(package, bytes) else package) as archive:
        tag = PACKAGE_TAG.search(archive.read("metadata.xml").decode("utf-8")).group(0)
    return _attribute(tag, "name"), _attribute(tag, "packageVersion")


def build_extension_zip(source_dir, output_dir, version=None, extra_files=None, folders=("Entities", "ui"), merge=True):
    """Zip `source_dir` into <name>-<version>.zip in `output_dir` and return its path.

    The zip holds metadata.xml, the files under each folder in `folders`, and `extra_files` ({archive name: bytes or path}),
    for example a built UI bundle. `version` replaces packageVersion in the zip only; the file on disk is not changed. With
    `merge` (the default) each entity folder under Entities/ is merged into one JSON file, because an extension import does
    not merge the split files.
    """
    with open(os.path.join(source_dir, "metadata.xml"), encoding="utf-8") as handle:
        metadata = handle.read()
    tag = PACKAGE_TAG.search(metadata).group(0)
    name, version_on_disk = _attribute(tag, "name"), _attribute(tag, "packageVersion")
    if version:
        if not VERSION_PATTERN.fullmatch(version):
            raise ValueError(f"version must look like 1.2.3 or 1.2.3-rc1, got {version!r}")
        metadata = metadata.replace(tag, re.sub(r'packageVersion="[^"]*"', f'packageVersion="{version}"', tag), 1)
    final_version = version or version_on_disk
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"{name}-{final_version}.zip")
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("metadata.xml", metadata)
        for folder in folders:
            if merge and folder == "Entities":
                for archive_name, content in merged_entity_files(source_dir):
                    archive.writestr(archive_name, content)
                continue
            for directory, _, file_names in os.walk(os.path.join(source_dir, folder)):
                for file_name in sorted(file_names):
                    path = os.path.join(directory, file_name)
                    archive.write(path, os.path.relpath(path, source_dir).replace(os.sep, "/"))
        for archive_name, content in (extra_files or {}).items():
            if isinstance(content, bytes):
                archive.writestr(archive_name, content)
            else:
                archive.write(content, archive_name)
    return output_path
