// Once-only loader for the Angular bundle. ThingWorx rejects "../" in FileResource paths, so the bundle ships as a file of
// the carrier widget se-common and this loader adds the script tag. The name is unique to this extension: two extensions
// that use the same global loader name would preempt each other.
(function () {
    if (window.__seLoadElements) { return; }
    var promise = null;
    window.__seLoadElements = function () {
        if (promise) { return promise; }
        promise = new Promise(function (resolve, reject) {
            if (window.__seElementsVersion) { resolve(); return; }
            var script = document.createElement("script");
            script.id = "se-elements-bundle";
            script.src = "/Thingworx/Common/extensions/SolutionExplorer/ui/se-common/se-elements.js";
            script.onload = resolve;
            script.onerror = function () { promise = null; reject(new Error("se-elements.js failed to load")); };
            document.head.appendChild(script);
        });
        return promise;
    };
})();

// Thin wrapper: renders <se-explorer>, passes the bound properties in and re-raises the element's events as widget events.
// No logic lives here.
TW.Runtime.Widgets["se-explorer"] = function () {
    var thisWidget = this;
    var element = null;

    // widget property -> element attribute
    var ATTRIBUTES = { StartTab: "start-tab", Entity: "entity", EntityCollection: "entity-collection", Service: "service", View: "view" };

    this.renderHtml = function () {
        return '<div class="widget-content widget-se-explorer" style="width:100%;height:100%"></div>';
    };

    this.afterRender = function () {
        element = document.createElement("se-explorer");
        element.style.display = "block";
        element.style.height = "100%";
        element.style.width = "100%";
        Object.keys(ATTRIBUTES).forEach(function (property) {
            var value = thisWidget.getProperty(property);
            if (value) { element.setAttribute(ATTRIBUTES[property], value); }
        });
        element.setAttribute("base-url", "/Thingworx");
        function raise(domEvent, property, eventName) {
            thisWidget.setProperty(property, String(domEvent.detail));
            thisWidget.jqElement.triggerHandler(eventName);
        }
        element.addEventListener("entitySelected", function (e) { raise(e, "SelectedEntity", "entitySelected"); });
        element.addEventListener("serviceSelected", function (e) { raise(e, "SelectedService", "serviceSelected"); });
        element.addEventListener("extensionSelected", function (e) { raise(e, "SelectedExtension", "extensionSelected"); });
        thisWidget.jqElement[0].appendChild(element);
        window.__seLoadElements().catch(function (error) { console.error(error); });
    };

    this.updateProperty = function (updatePropertyInfo) {
        var property = updatePropertyInfo.TargetProperty;
        if (ATTRIBUTES[property]) {
            thisWidget.setProperty(property, updatePropertyInfo.SinglePropertyValue);
            if (element) { element.setAttribute(ATTRIBUTES[property], updatePropertyInfo.SinglePropertyValue || ""); }
        }
    };

    this.beforeDestroy = function () {
        if (element && element.parentNode) { element.parentNode.removeChild(element); }
        element = null;
    };
};
