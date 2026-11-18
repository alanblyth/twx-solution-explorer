TW.IDE.Widgets["se-explorer"] = function () {
    this.widgetProperties = function () {
        return {
            name: "Solution Explorer",
            description: "Explore dependencies between extensions, projects and entities, and the services a service can call (Angular element)",
            category: ["Common"],
            supportsAutoResize: true,
            properties: {
                StartTab: { description: "Tab shown first: extensions, containers (Projects & Extensions) or entities", baseType: "STRING", isBindingTarget: true, isEditable: true, defaultValue: "extensions", isLocalizable: false },
                Entity: { description: "Entity to open on the Entities tab", baseType: "STRING", isBindingTarget: true, isEditable: true, defaultValue: "", isLocalizable: false },
                EntityCollection: { description: "Collection of that entity: Things, ThingTemplates, ThingShapes, DataShapes, Mashups or Projects", baseType: "STRING", isBindingTarget: true, isEditable: true, defaultValue: "Things", isLocalizable: false },
                Container: { description: "Project or extension to open on the Projects & Extensions tab", baseType: "STRING", isBindingTarget: true, isEditable: true, defaultValue: "", isLocalizable: false },
                ContainerKind: { description: "What Container names: Project or Extension", baseType: "STRING", isBindingTarget: true, isEditable: true, defaultValue: "Project", isLocalizable: false },
                Service: { description: "Service of that entity to trace", baseType: "STRING", isBindingTarget: true, isEditable: true, defaultValue: "", isLocalizable: false },
                View: { description: "How to show a traced service: graph or sequence", baseType: "STRING", isBindingTarget: true, isEditable: true, defaultValue: "graph", isLocalizable: false },
                SelectedEntity: { description: "Entity last opened", baseType: "STRING", isBindingSource: true, isEditable: false, defaultValue: "" },
                SelectedService: { description: "Service last traced", baseType: "STRING", isBindingSource: true, isEditable: false, defaultValue: "" },
                SelectedExtension: { description: "Extension last clicked", baseType: "STRING", isBindingSource: true, isEditable: false, defaultValue: "" },
                SelectedContainer: { description: "Project or extension last scanned on the Projects & Extensions tab", baseType: "STRING", isBindingSource: true, isEditable: false, defaultValue: "" },
                Width: { defaultValue: 1100 },
                Height: { defaultValue: 700 }
            },
            events: {
                entitySelected: { description: "An entity was opened" },
                serviceSelected: { description: "A service was traced" },
                extensionSelected: { description: "An extension was clicked" },
                containerSelected: { description: "A project or extension was scanned" }
            }
        };
    };
    this.afterLoad = function () {};
    this.renderHtml = function () {
        return '<div class="widget-content widget-se-explorer">Solution Explorer</div>';
    };
    this.afterRender = function () {};
    this.beforeDestroy = function () {};
};
