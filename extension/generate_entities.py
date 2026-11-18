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
PACKAGE_VERSION = "0.2.1"


def explorer_mashup():
    """A responsive mashup: one responsive container that fills the window, and the widget filling that container
    (the shape Composer writes for an auto-resize widget, as in the platform's DashboardViewer)."""
    container = {
        "Area": "UI", "DisplayName": "container-2", "EnableExpandCollapse": False, "ExpandCollapseTabLocation": "inside", "Expanded": True,
        "Id": "flexcontainer-2", "LastContainer": True, "Overlay": False, "ResponsiveLayout": True, "ShowDataLoading": True,
        "ShowExpandCollapseTab": False, "SourceURL": "", "Style": "DefaultContainerStyle", "StyleProperties": {}, "Type": "flexcontainer",
        "UseTheme": True, "Visible": True, "Z-index": 10, "align-content": "flex-start", "align-items": "flex-start", "flex-basis": "auto",
        "flex-direction": "row", "flex-grow": 1, "flex-max-height": "", "flex-max-width": "", "flex-min-height": "", "flex-min-width": "",
        "flex-shrink": 1, "flex-size": "default", "flex-wrap": "nowrap", "justify-content": "flex-start", "positioning": "responsive",
        "userCannotRemove": True,
    }
    widget = {
        "Area": "UI", "DisplayName": "se-explorer-1", "Height": 780, "Id": "se-explorer-1", "LastContainer": False, "Left": 0, "Top": 0,
        "ResponsiveLayout": True, "Type": "se-explorer", "Visible": True, "Width": 1180, "Z-index": 10,
        "StartTab": "extensions", "EntityCollection": "Things", "View": "graph", "ContainerKind": "Project",
    }
    content = {
        "Bindings": [], "CustomCSS": "", "Data": {}, "Events": [],
        "UI": {
            "Properties": {"Area": "Mashup", "Height": 800, "Id": "mashup-root", "Left": 0, "ResponsiveLayout": True, "Style": "DefaultMashupStyle",
                           "Title": "SE.Explorer", "Top": 0, "Type": "mashup", "Visible": True, "Width": 1200, "Z-index": 10, "supportsAutoResize": True},
            "Widgets": [{"Properties": container, "Widgets": [{"Properties": widget, "Widgets": []}]}],
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
