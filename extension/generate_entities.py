#!/usr/bin/env python3
"""Write the extension's entities as JSON source (Entities/), using the twxlab builders.

  python extension/generate_entities.py

Run it after changing the mashup or the project. The output is committed; build.py merges the split files into the zip.
"""
import os, shutil, sys
from twxlab import entities

HERE = os.path.dirname(os.path.abspath(__file__))
ENTITIES = os.path.join(HERE, "Entities")
PROJECT = "SolutionExplorer"
PACKAGE_VERSION = "0.2.0"


def explorer_mashup():
    content = {
        "Bindings": [], "CustomCSS": "", "Data": {}, "Events": [],
        "UI": {
            "Properties": {"Area": "UI", "Height": 800, "Id": "mashup-root", "ResponsiveLayout": False, "Title": "SE.Explorer", "Type": "mashup", "Visible": True, "Width": 1200, "Z-index": 10},
            "Widgets": [{
                "Properties": {"Area": "UI", "DisplayName": "se-explorer-1", "Height": 780, "Id": "se-explorer-1", "Left": 10, "Top": 10, "Type": "se-explorer",
                               "Visible": True, "Width": 1180, "Z-index": 10, "StartTab": "extensions", "EntityCollection": "Things", "View": "graph"},
                "Widgets": [],
            }],
        },
    }
    return entities.mashup("SE.Explorer", content, "Explore extension and entity dependencies and service call chains", PROJECT)


def main():
    if os.path.isdir(ENTITIES):
        shutil.rmtree(ENTITIES)
    for entity in (entities.project(PROJECT, PACKAGE_VERSION, "Solution Explorer extension"), explorer_mashup()):
        entities.write_entity(HERE, entity)
    print("wrote", ENTITIES)


if __name__ == "__main__":
    sys.exit(main())
