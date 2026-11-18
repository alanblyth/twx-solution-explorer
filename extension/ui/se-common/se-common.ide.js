// Carrier widget: exists so ThingWorx serves ui/se-common/se-elements.js (the Angular bundle).
// It is not meant to be placed on a mashup.
TW.IDE.Widgets["se-common"] = function () {
    this.widgetProperties = function () {
        return { name: "SE Common (bundle carrier)", description: "Do not use: carries the Solution Explorer Angular bundle", category: ["Common"], properties: {} };
    };
    this.renderHtml = function () { return '<div class="widget-content">se-common</div>'; };
};
