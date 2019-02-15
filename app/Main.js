/*
  Copyright 2017 Esri

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.​
*/

define([
  "calcite",
  "noUiSlider",
  "dojo/_base/declare",
  "ApplicationBase/ApplicationBase",
  "dojo/i18n!./nls/resources",
  "ApplicationBase/support/itemUtils",
  "ApplicationBase/support/domHelper",
  "dojo/_base/Color",
  "dojo/colors",
  "dojo/on",
  "dojo/number",
  "dojo/date/locale",
  "dojo/dom",
  "dojo/dom-style",
  "dojo/dom-class",
  "dojo/dom-construct",
  "dojo/query",
  "esri/config",
  "esri/core/Evented",
  "esri/core/urlUtils",
  "esri/core/watchUtils",
  "esri/Graphic",
  "esri/views/MapView",
  "esri/layers/GraphicsLayer",
  "esri/layers/CSVLayer",
  "esri/tasks/support/StatisticDefinition",
  "esri/widgets/Sketch/SketchViewModel",
  "esri/widgets/Legend",
  "esri/widgets/Home"
], function (calcite, noUiSlider, declare, ApplicationBase, i18n, itemUtils, domHelper,
             Color, colors, on, number, locale, dom, domStyle, domClass, domConstruct, query,
             esriConfig, Evented, urlUtils, watchUtils,
             Graphic, MapView, GraphicsLayer, CSVLayer, StatisticDefinition,
             SketchViewModel, Legend, Home) {

  return declare([Evented], {

    /**
     *
     */
    constructor: function () {

      calcite.init();

      this.CSS = { loading: "configurable-application--loading" };
      this.base = null;
    },

    /**
     *
     * @param base
     */
    init: function (base) {
      if(!base) {
        console.error("ApplicationBase is not defined");
        return;
      }
      domHelper.setPageLocale(base.locale);
      domHelper.setPageDirection(base.direction);

      this.base = base;
      const config = base.config;
      const results = base.results;
      const find = config.find;
      const marker = config.marker;

      const allMapItems = results.webMapItems.concat(results.webSceneItems);
      const validMapItems = allMapItems.map(function (response) {
        return response.value;
      });

      const firstItem = validMapItems[0];
      if(!firstItem) {
        console.error("Could not load an item to display");
        return;
      }
      config.title = (config.title || itemUtils.getItemTitle(firstItem));
      domHelper.setPageTitle(config.title);

      const viewProperties = itemUtils.getConfigViewProperties(config);
      viewProperties.container = "view-container";
      viewProperties.center = [-150.0, 15.0];
      viewProperties.zoom = 2;

      const portalItem = this.base.results.applicationItem.value;
      const appProxies = (portalItem && portalItem.appProxies) ? portalItem.appProxies : null;

      itemUtils.createMapFromItem({ item: firstItem, appProxies: appProxies }).then((map) => {
        viewProperties.map = map;
        return itemUtils.createView(viewProperties).then((view) => {
          domClass.remove(document.body, this.CSS.loading);
          this.viewReady(config, firstItem, view);
        });
      });


    },

    /**
     *
     * @param config
     * @param item
     * @param view
     */
    viewReady: function (config, item, view) {

      // TITLE PANEL //
      dom.byId("title-label").innerHTML = this.base.config.title;
      view.ui.add("title-panel", { position: "top-left", index: 0 });

      // HOME //
      const home = new Home({ view: view });
      view.ui.add(home, { position: "top-left", index: 1 });

      // const legend = new Legend({ view: view });
      // view.ui.add(legend, { position: "bottom-left", index: 1 });

      // QUAKES LAYER //
      this.initializeQuakesLayer(view);

      // ZOOM WINDOW //
      this.initializeZoomWindow(view);

    },

    /**
     *
     * @param view
     */
    initializeQuakesLayer: function (view) {

      //
      // USGS EARTHQUAKES - ONE MONTH //
      //
      const usgs_quakes_url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.csv";
      esriConfig.request.corsEnabledServers.push(usgs_quakes_url);

      // DOWNLOAD DATA LINK //
      on(dom.byId("download-data"), "click", () => {
        window.open(usgs_quakes_url);
      });

      // QUAKES LAYER //
      const quakes_layer = new CSVLayer({
        url: usgs_quakes_url,
        title: "USGS Earthquakes",
        copyright: "USGS",
        popupTemplate: {
          title: "Earthquake Info",
          content: "Magnitude {mag} {type} hit {place} on {time}."
        }
      });
      quakes_layer.load().then(() => {
        // console.info(quakes_layer.fields.map(field => {
        //   return field.toJSON();
        // }));

        // TIME FIELD //
        const time_field = "time";

        // TIME RANGE //
        const one_hour = (1000 * 60 * 60);
        const time_range = (one_hour * 12);

        // TIME RENDERER //
        this.initializeTimeRenderer(quakes_layer, time_field, time_range);

        // ADD QUAKES LAYER TO MAP //
        view.map.add(quakes_layer);

        // LAYER VIEW //
        view.whenLayerView(quakes_layer).then((quakes_layerView) => {
          // FIRST TIME FINISHED UPDATING //
          watchUtils.whenFalseOnce(quakes_layerView, "updating", () => {

            // AOI SKETCH //
            this.initializeAOISketch(view);

            // UPDATE STATS //
            this.initializeTimeStats(view, quakes_layerView, time_field, time_range);

            // TIME EXTENT QUERY //
            const time_query = quakes_layer.createQuery();
            time_query.orderByFields = [time_field];
            quakes_layerView.queryFeatures(time_query).then((quakes_featureSet) => {
              const quake_features = quakes_featureSet.features;

              // TIME EXTENT //
              const time_extent = {
                min: new Date(quake_features[0].getAttribute(time_field)),
                max: new Date(quake_features[quake_features.length - 1].getAttribute(time_field))
              };

              // TIME FILTER //
              this.initializeTimeFilter(view, time_extent);

            }, console.error);
          });

        });
      });

    },

    /**
     *
     * @param view
     * @param timeExtent
     */
    initializeTimeFilter: function (view, timeExtent) {

      // TIME PANEL //
      view.ui.add("time-panel", { position: "top-right", index: 0 });
      domClass.remove("time-panel", "hide");

      // TIME INTERVALS //
      const one_minute = (1000 * 60);
      const one_hour = (one_minute * 60);
      const one_day = (one_hour * 24);
      const time_step = (one_hour);
      const animation_time_step = (one_minute * 30);

      const current_time_info = {
        min: timeExtent.min,
        max: timeExtent.max
      };

      const format_date = (date_time) => {
        return locale.format(date_time, { datePattern: "MMMM d", timePattern: "h:mm a" });
      };

      dom.byId("current-time-node").innerHTML = format_date(current_time_info.min);

      const time_input = dom.byId("time-input");
      time_input.min = current_time_info.min.valueOf();
      time_input.max = current_time_info.max.valueOf();
      time_input.valueAsNumber = time_input.min;

      on(time_input, "input", () => {
        update_time_filter();
      });
      on(time_input, "change", () => {
        update_time_filter();
      });

      const set_time = (date_time) => {
        time_input.valueAsNumber = date_time;
        update_time_filter();
      };

      const update_time_filter = () => {
        dom.byId("current-time-node").innerHTML = format_date(new Date(time_input.valueAsNumber));
        this.emit("time-change", { dateTimeValue: time_input.valueAsNumber })
      };
      update_time_filter();


      //
      // ANIMATION STUFF //
      //
      let fps = dom.byId("fps-input").valueAsNumber;
      on(dom.byId("fps-input"), "input", () => {
        fps = dom.byId("fps-input").valueAsNumber;
      });

      let animation;

      function startAnimation() {
        stopAnimation();
        domClass.add(time_input, "btn-disabled");
        animation = animate(time_input.valueAsNumber);
      }

      function stopAnimation() {
        if(!animation) {
          return;
        }
        animation.remove();
        animation = null;
        domClass.remove(time_input, "btn-disabled");
      }

      function animate(startValue) {
        let animating = true;
        let value = startValue;

        const frame = function () {
          if(!animating) {
            return;
          }
          value += animation_time_step;
          if(value > current_time_info.max.valueOf()) {
            value = current_time_info.min.valueOf()
          }
          set_time(value);
          setTimeout(() => {
            requestAnimationFrame(frame);
          }, 1000 / fps);
        };

        frame();

        return {
          remove: function () {
            animating = false;
          }
        };
      }


      // PLAY / PAUSE //
      const play_pause_btn = dom.byId("play-pause-btn");
      on(play_pause_btn, "click", () => {
        domClass.toggle(play_pause_btn, "icon-ui-play icon-ui-pause icon-ui-green icon-ui-red");
        if(domClass.contains(play_pause_btn, "icon-ui-play")) {
          stopAnimation();
        } else {
          startAnimation();
        }
      });
      // PREV //
      const prev_btn = dom.byId("prev-btn");
      on(prev_btn, "click", () => {
        time_input.stepDown(time_step);
        set_time(time_input.valueAsNumber);
      });
      // NEXT //
      const next_btn = dom.byId("next-btn");
      on(next_btn, "click", () => {
        time_input.stepUp(time_step);
        set_time(time_input.valueAsNumber);
      });

    },


    /**
     *
     * @param layer
     * @param time_field
     * @param time_range
     * @returns {function(*=)}
     */
    initializeTimeRenderer: function (layer, time_field, time_range) {

      const update_time_renderer = (date_time_value) => {

        layer.renderer = {
          type: "simple",
          symbol: {
            type: "picture-marker",
            url: "./assets/FireflyC16.png",
            width: "9px",
            height: "9px"
          },
          visualVariables: [
            {
              type: "size",
              field: "mag",
              minDataValue: 1.0,
              maxDataValue: 7.0,
              minSize: "5px",
              maxSize: "72px"
            },
            {
              type: "opacity",
              field: time_field,
              stops: [
                {
                  label: "one month",
                  opacity: 0.0,
                  value: 0
                },
                {
                  label: "",
                  opacity: 0.2,
                  value: date_time_value - (time_range * 0.5)
                },
                {
                  label: "today",
                  opacity: 1.0,
                  value: date_time_value
                },
                {
                  label: "",
                  opacity: 0.0,
                  value: date_time_value + (time_range * 0.5)
                }
              ],
              legendOptions: {
                showLegend: true
              }
            }
          ]
        };

      };

      this.on("time-change", evt => {
        update_time_renderer(evt.dateTimeValue);
      });
      update_time_renderer((new Date()).valueOf());

    },

    /**
     *
     * @param view
     * @param layerView
     * @param time_field
     * @param time_range
     * @returns {function(*)}
     */
    initializeTimeStats: function (view, layerView, time_field, time_range) {

      // DISPLAY COUNTS AND STATS PANEL //
      view.ui.add("counts-panel", { position: "top-right", index: 1 });
      domClass.remove("counts-panel", "hide");
      view.ui.add("stats-panel", { position: "bottom-left", index: 0 });
      domClass.remove("stats-panel", "hide");

      //
      // TOTAL //
      //
      const total_count_label = dom.byId("counts-total-label");
      const total_query = layerView.layer.createQuery();
      total_query.where = `1=1`;
      layerView.queryFeatureCount(total_query).then((feature_count) => {
        total_count_label.innerHTML = number.format(feature_count);
      });

      //
      // RECENT COUNTS //
      //
      const recent_count_label = dom.byId("counts-recent-label");
      let time_query_handle;
      const update_time_count = (date_time_value) => {
        const time_query = layerView.layer.createQuery();
        time_query.where = `(${time_field} > ${date_time_value - (time_range * 0.5)}) AND (${time_field} < ${date_time_value + (time_range * 0.5)})`;
        time_query_handle && !time_query_handle.isFulfilled() && time_query_handle.cancel();
        time_query_handle = layerView.queryFeatureCount(time_query).then((feature_count) => {
          recent_count_label.innerHTML = number.format(feature_count);
        });
      };

      //
      // EXTENT COUNTS //
      //
      const extent_count_label = dom.byId("counts-extent-label");
      let extent_query_handle;
      const update_extent_count = (extent) => {
        const extent_query = layerView.layer.createQuery();
        extent_query.geometry = extent;
        extent_query_handle && !extent_query_handle.isFulfilled() && extent_query_handle.cancel();
        extent_query_handle = layerView.queryFeatureCount(extent_query).then((feature_count) => {
          extent_count_label.innerHTML = number.format(feature_count);
        });
      };
      update_extent_count(view.extent);

      //
      // EXTENT RECENT COUNTS //
      //
      const recent_extent_count_label = dom.byId("counts-extent-recent-label");
      let time_extent_query_handle;
      const update_time_extent_count = (extent, date_time_value) => {
        const time_extent_query = layerView.layer.createQuery();
        time_extent_query.where = `(${time_field} > ${date_time_value - (time_range * 0.5)}) AND (${time_field} < ${date_time_value + (time_range * 0.5)})`;
        time_extent_query.geometry = extent;
        time_extent_query_handle && !time_extent_query_handle.isFulfilled() && time_extent_query_handle.cancel();
        time_extent_query_handle = layerView.queryFeatureCount(time_extent_query).then((feature_count) => {
          recent_extent_count_label.innerHTML = number.format(feature_count);
        });
      };

      //
      // MAG STATS //
      //
      const mag_min_label = dom.byId("mag-min-label");
      const mag_avg_label = dom.byId("mag-avg-label");
      const mag_max_label = dom.byId("mag-max-label");
      let mag_query_handle;
      const update_mag_stats = (extent, date_time_value) => {
        const mag_query = layerView.layer.createQuery();
        mag_query.where = `(${time_field} > ${date_time_value - (time_range * 0.5)}) AND (${time_field} < ${date_time_value + (time_range * 0.5)})`;
        mag_query.geometry = extent;
        mag_query.outStatistics = [
          { statisticType: "min", onStatisticField: "mag", outStatisticFieldName: "mag_min" },
          { statisticType: "avg", onStatisticField: "mag", outStatisticFieldName: "mag_avg" },
          { statisticType: "max", onStatisticField: "mag", outStatisticFieldName: "mag_max" }
        ];
        mag_query_handle && !mag_query_handle.isFulfilled() && mag_query_handle.cancel();
        mag_query_handle = layerView.queryFeatures(mag_query).then((mag_featureSet) => {
          const mag_stats = mag_featureSet.features["0"].attributes;
          mag_min_label.innerHTML = mag_stats.mag_min.toFixed(1);
          mag_avg_label.innerHTML = mag_stats.mag_avg.toFixed(1);
          mag_max_label.innerHTML = mag_stats.mag_max.toFixed(1);
        });
      };

      //
      // DEPTH STATS //
      //
      const depth_min_label = dom.byId("depth-min-label");
      const depth_avg_label = dom.byId("depth-avg-label");
      const depth_max_label = dom.byId("depth-max-label");
      let depth_query_handle;
      const update_depth_stats = (extent, date_time_value) => {
        const depth_query = layerView.layer.createQuery();
        depth_query.where = `(${time_field} > ${date_time_value - (time_range * 0.5)}) AND (${time_field} < ${date_time_value + (time_range * 0.5)})`;
        depth_query.geometry = extent;
        depth_query.outStatistics = [
          { statisticType: "min", onStatisticField: "depth", outStatisticFieldName: "depth_min" },
          { statisticType: "avg", onStatisticField: "depth", outStatisticFieldName: "depth_avg" },
          { statisticType: "max", onStatisticField: "depth", outStatisticFieldName: "depth_max" }
        ];
        depth_query_handle && !depth_query_handle.isFulfilled() && depth_query_handle.cancel();
        depth_query_handle = layerView.queryFeatures(depth_query).then((depth_featureSet) => {
          const depth_stats = depth_featureSet.features["0"].attributes;
          depth_min_label.innerHTML = depth_stats.depth_min.toFixed(2);
          depth_avg_label.innerHTML = depth_stats.depth_avg.toFixed(2);
          depth_max_label.innerHTML = depth_stats.depth_max.toFixed(2);
        });
      };

      //
      // EXTENT CHANGE //
      //
      view.watch("extent", extent => {
        update_extent_count(extent);
        if(_date_time_value) {
          update_time_extent_count(extent, _date_time_value);
          update_mag_stats(extent, _date_time_value);
          update_depth_stats(extent, _date_time_value);
        }
      });

      //
      // AREA OF INTEREST //
      //
      const aoi_counts_label = dom.byId("counts-aoi-label");
      let aoi_query_handle;
      const update_aoi_count = (aoi) => {
        const aoi_query = layerView.layer.createQuery();
        aoi_query.geometry = aoi;
        aoi_query_handle && !aoi_query_handle.isFulfilled() && aoi_query_handle.cancel();
        aoi_query_handle = layerView.queryFeatureCount(aoi_query).then((feature_count) => {
          aoi_counts_label.innerHTML = number.format(feature_count);
        });
      };
      const aoi_counts_recent_label = dom.byId("counts-aoi-recent-label");
      let time_aoi_query_handle;
      const update_time_aoi_stats = (aoi, date_time_value) => {
        const time_aoi_query = layerView.layer.createQuery();
        time_aoi_query.where = `(${time_field} > ${date_time_value - (time_range * 0.5)}) AND (${time_field} < ${date_time_value + (time_range * 0.5)})`;
        time_aoi_query.geometry = aoi;
        time_aoi_query_handle && !time_aoi_query_handle.isFulfilled() && time_aoi_query_handle.cancel();
        time_aoi_query_handle = layerView.queryFeatureCount(time_aoi_query).then((feature_count) => {
          aoi_counts_recent_label.innerHTML = number.format(feature_count);
        });
      };
      //
      // AOI CHANGE //
      //
      let _aoi_polygon;
      this.on("aoi-changed", evt => {
        _aoi_polygon = evt.aoi;
        if(!_aoi_polygon) {
          aoi_counts_label.innerHTML = "-";
          aoi_counts_recent_label.innerHTML = "-";
        } else {
          update_aoi_count(_aoi_polygon);
          if(_date_time_value) {
            update_time_aoi_stats(_aoi_polygon, _date_time_value);
          }
        }
      });


      //
      // TIME CHANGE //
      //
      let _date_time_value;
      this.on("time-change", evt => {
        _date_time_value = evt.dateTimeValue;
        update_time_count(_date_time_value);
        update_time_extent_count(view.extent, _date_time_value);
        update_mag_stats(view.extent, _date_time_value);
        update_depth_stats(view.extent, _date_time_value);
        if(_aoi_polygon) {
          update_time_aoi_stats(_aoi_polygon, _date_time_value)
        }
      });

    },

    /**
     *
     * @param view
     * @param quakes_layer
     */
    initializeRendererOptions: function (view, quakes_layer) {

      // ADD RENDERER PANEL TO VIEW //
      view.ui.add("renderer-panel", "top-right");
      domClass.remove("renderer-panel", "hide");


      //
      // FIREFLY //
      //
      const firefly_data_slider = noUiSlider.create(dom.byId("firefly-data-slider"), {
        range: { "min": 1.0, "max": 10.0 }, start: [1, 7], connect: [false, true, false], behaviour: 'drag'
      });
      const firefly_size_slider = noUiSlider.create(dom.byId("firefly-size-slider"), {
        range: { "min": 1.0, "max": 100.0 }, start: [3, 72], connect: [false, true, false], behaviour: 'drag'
      });
      const updateFireflyRenderer = () => {
        const data_values = firefly_data_slider.get();
        const size_values = firefly_size_slider.get();
        quakes_layer.renderer = {
          type: "simple",
          symbol: {
            type: "picture-marker",
            url: "./assets/FireflyC16.png",
            width: "9px",
            height: "9px"
          },
          visualVariables: [
            {
              type: "size",
              field: "mag",
              minDataValue: +data_values[0],
              maxDataValue: +data_values[1],
              minSize: `${+size_values[0]}px`,
              maxSize: `${+size_values[1]}px`
            }
          ]
        }
      };
      firefly_data_slider.on("update", updateFireflyRenderer);
      firefly_size_slider.on("update", updateFireflyRenderer);

      //
      // HEATMAP //
      //
      const heatmap_blur_slider = noUiSlider.create(dom.byId("heatmap-blur-slider"), {
        range: { "min": 1.0, "max": 25.0 }, start: 7, connect: [true, false]
      });
      const heatmap_intensity_slider = noUiSlider.create(dom.byId("heatmap-intensity-slider"), {
        range: { "min": 1.0, "max": 250.0 }, start: [6, 60], connect: [false, true, false], behaviour: 'drag'
      });


      const color_stops = [
        { color: "rgba(0, 255, 255, 0.0)", ratio: 0.00 },
        { color: "rgba(0, 255, 255, 0.1)", ratio: 0.10 },
        { color: "rgba(255, 255, 0, 1)", ratio: 0.50 },
        { color: "rgba(255, 255, 0, 1)", ratio: 0.99 },
        { color: "rgba(255, 215, 0, 1)", ratio: 1.00 }
      ];

      const handles = color_stops.map((color_stop, color_stop_index) => {
        return color_stop.ratio;
      });

      const heatmap_color_stops_slider = noUiSlider.create(dom.byId("heatmap-color-stops-slider"), {
        range: { "min": 0.00, "max": 1.00 }, start: handles, step: 0.01
      });

      //color_stops.forEach((color_stop, color_stop_index) => {
      //   query(`.noUI-handle[data-handle="${color_stop_index}"]`)[0].style.background = color_stop.color;
      // });


      const updateHeatmapRenderer = () => {
        const blur_value = heatmap_blur_slider.get();
        const intensity_values = heatmap_intensity_slider.get();
        quakes_layer.renderer = {
          type: "heatmap",
          field: "mag",
          blurRadius: +blur_value,
          minPixelIntensity: +intensity_values[0],
          maxPixelIntensity: +intensity_values[1],
          colorStops: color_stops
        }
      };
      heatmap_blur_slider.on("update", updateHeatmapRenderer);
      heatmap_intensity_slider.on("update", updateHeatmapRenderer);
      heatmap_color_stops_slider.on("update", (values, handle, unencoded, tap, positions) => {
        console.info(values, handle, unencoded, tap, positions);

        if(tap) {


        } else {
          query(`.noUi-handle[data-handle="${handle}"]`, "heatmap-color-stops-slider")[0].style.background = color_stops[handle].color;
          color_stops[handle].ratio = +values[handle];
        }

        updateHeatmapRenderer();
      });


      // SET INITIAL RENDERER //
      updateHeatmapRenderer();


    },


    /**
     *
     * @param view
     */
    initializeZoomWindow: function (view) {

      // ZOOM WINDOW ENABLED //
      let zoom_window_enabled = false;

      // ZOOM WINDOW BUTTON //
      const zoom_window_btn = domConstruct.create("div", { className: "esri-widget--button icon-ui-zoom-in-magnifying-glass icon-ui-flush", title: "Zoom Window" });
      view.ui.add(zoom_window_btn, { position: "top-left", index: 3 });

      on(zoom_window_btn, "click", () => {
        domClass.toggle(zoom_window_btn, "selected");
        zoom_window_enabled = domClass.contains(zoom_window_btn, "selected");
        view.container.style.cursor = zoom_window_enabled ? "all-scroll" : "default";
      });

      // CALC WINDOW POSITION //
      const window_offset = 12;
      const zoom_window_position = (pos_evt) => {
        const top_offset = (pos_evt.y < (view.height - 200)) ? window_offset : -150 - window_offset;
        const left_offset = (pos_evt.x < (view.width - 200)) ? window_offset : -150 - window_offset;
        return {
          top: (pos_evt.y + top_offset) + "px",
          left: (pos_evt.x + left_offset) + "px"
        };
      };

      // CONTAINER //
      const zoom_container = domConstruct.create("div", { className: "zoom-view-node panel panel-dark-blue hide" }, view.root, "first");
      const display_zoom_window = (position_evt) => {
        domConstruct.place(zoom_container, view.root, position_evt ? "last" : "first");
        domClass.toggle(zoom_container, "hide", !position_evt);
        if(position_evt) {
          domStyle.set(zoom_container, zoom_window_position(position_evt));
        }
      };

      // MAP VIEW //
      const zoom_view = new MapView({
        container: zoom_container,
        ui: { components: [] },
        map: view.map
      });

      // IS WITHIN VIEW //
      const is_within_view = (evt) => {
        return (evt.x > 0) && (evt.x < view.width) && (evt.y > 0) && (evt.y < view.height);
      };

      // ZOOM LEVEL OFFSET //
      const zoom_level_offset = 4;
      // LAST EVENT //
      let last_evt = null;

      // UPDATE ZOOM WINDOW //
      const update_zoom_window = (view_evt) => {
        if(is_within_view(view_evt)) {
          const map_point = view.toMap(view_evt);
          if(map_point) {
            last_evt = view_evt;

            // DISPLAY ZOOM WINDOW //
            display_zoom_window(view_evt);

            // UPDATE ZOOM WINDOW //
            zoom_view.goTo({ target: map_point, zoom: (view.zoom + zoom_level_offset) }, { animate: false });

          } else {
            // IN 3D IF NOT ON GLOBE //
            display_zoom_window();
            last_evt = null;
          }
        } else {
          // NOT WITHIN VIEW //
          display_zoom_window();
          last_evt = null;
        }
      };

      // POINTER DOWN //
      view.on("pointer-down", (pointer_down_evt) => {
        if(zoom_window_enabled) {
          pointer_down_evt.stopPropagation();
          if(pointer_down_evt.button === 0) {
            update_zoom_window(pointer_down_evt);
          }
        }
      });

      // DRAG //
      view.on("drag", (drag_evt) => {
        if(zoom_window_enabled) {
          drag_evt.stopPropagation();
          switch (drag_evt.action) {
            case "update":
              update_zoom_window(drag_evt);
              break;
            default:
              last_evt = null;
          }
        }
      });

      // POINTER UP //
      view.on("pointer-up", () => {
        if(zoom_window_enabled) {
          display_zoom_window();
          last_evt = null;
        }
      });
      // POINTER LEAVE //
      view.on("pointer-leave", () => {
        if(zoom_window_enabled) {
          display_zoom_window();
          last_evt = null;
        }
      });

    },

    /**
     *
     * @param view
     */
    initializeAOISketch: function (view) {

      const sketch_aoi_btn = dom.byId("sketch-aoi-btn");

      const sketch_symbol = {
        type: "simple-fill",
        color: Color.named.transparent,
        style: "solid",
        outline: {
          style: "dot",
          color: Color.named.red,
          width: 1.5
        }
      };

      const aoi_graphic = new Graphic({ symbol: sketch_symbol });
      const graphics_layer = new GraphicsLayer({ graphics: [aoi_graphic] });
      view.map.add(graphics_layer);

      const sketchViewModel = new SketchViewModel({ view: view, layer: graphics_layer, polygonSymbol: sketch_symbol });

      on(sketch_aoi_btn, "click", () => {
        domClass.add(sketch_aoi_btn, "btn-disabled");
        aoi_graphic.geometry = null;
        sketchViewModel.create("rectangle");
      });

      sketchViewModel.on("create-cancel", (evt) => {
        domClass.remove(sketch_aoi_btn, "btn-disabled");
      });

      sketchViewModel.on("create", (evt) => {
        this.emit("aoi-changed", { aoi: evt.geometry });
      });

      sketchViewModel.on("create-complete", (evt) => {
        domClass.remove(sketch_aoi_btn, "btn-disabled");
        aoi_graphic.geometry = evt.geometry;
      });

      aoi_graphic.watch("geometry", polygon => {
        this.emit("aoi-changed", { aoi: polygon });
      });

    }

  });
});