// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 Defani Arman (Alfitriansyah)
//
// Follows the behaviour of the QGIS "iNaturalist Extractor" plugin by Jules
// Grillot (GPL-2.0-or-later) and builds on the rinat R package's argument set.
// See README.md, "Credits, sources & references", for every source used.

// GeoLibre external plugin: iNaturalist Extractor
//
// Fetches iNaturalist observations (via the public iNaturalist API v1 -
// https://api.inaturalist.org/v1/observations), adds them to the map as a
// GeoJSON layer, and shows a small popup with the observation's details when
// a point is clicked - including a photo (or a small photo strip) when the
// observation actually has one attached.
//
// Feature set (merged from the rinat R package and the QGIS iNaturalist
// Extractor plugin):
//  - Only observations with real coordinates are ever extracted (geo=true
//    is always sent - an observation with no public location is useless on
//    a map, so this isn't a toggle, it's a baseline). A photo is shown
//    whenever an observation happens to have one, but it is never required.
//  - Area to search: either the current map view, or the extent of the
//    layer currently selected in the Layers panel ("active layer"),
//    matching the QGIS plugin's "use layer extent" option.
//  - Date filtering: off by default (all years), or a from/to date range
//    (rinat's year/month/day narrowed to a single year is just a one-year
//    range here; a single day is a range of one day).
//  - Species filter: a free-text taxon name (rinat's taxon_name). When left
//    empty, results can instead be narrowed by one or more iconic taxa
//    (Plantae, Aves, Insecta, ...), same idea as rinat's iconic taxa
//    filtering on the website.
//  - Quality grade: a dropdown (any / research / needs ID / casual /
//    verifiable) sent as quality_grade. It replaces the old "verifiable"
//    checkbox, which could only express one of these choices.
//  - Advanced filters (rinat): taxon ID, place ID, photo license, project and
//    annotation (term_id / term_value_id) - the get_inat_obs() arguments the
//    basic form doesn't cover - plus an opt-in "ignore the Area" switch so a
//    place or project isn't silently clipped to the current map view.
//
// This is a self-contained ES module: no bare `import`s, everything the
// plugin needs is written inline below (per the GeoLibre plugin contract,
// relative/bare imports inside the zip are not resolved by the loader).

const SVG_NS = "http://www.w3.org/2000/svg";

const PLUGIN_ID = "geolibre-inaturalist-extractor";
const PANEL_ID = `${PLUGIN_ID}-panel`;

// Marker written on every feature this plugin adds, so the map click handler
// can recognise "one of ours" regardless of which internal layer id
// app.addGeoJsonLayer() ends up using, and regardless of how many separate
// extraction layers the user has added over the session.
const MARKER_PROP = "__inatPlugin";

const API_BASE = "https://api.inaturalist.org/v1/observations";
const RECOMMENDED_PRACTICES_URL =
  "https://www.inaturalist.org/pages/api+recommended+practices";

const PER_PAGE_LIMIT = 200; // iNaturalist's own per-page ceiling
const DEFAULT_MAX_OBS = 200;
const MAX_ALLOWED_OBS = 2000; // keep the plugin polite to the public API
const PAGE_DELAY_MS = 250; // small gap between paged requests

// The 14 top-level "iconic taxa" iNaturalist groups everything under.
// Order roughly follows the one used on the iNaturalist website's own filter.
const ICONIC_TAXA = [
  "Plantae",
  "Animalia",
  "Mollusca",
  "Reptilia",
  "Aves",
  "Amphibia",
  "Actinopterygii",
  "Mammalia",
  "Insecta",
  "Arachnida",
  "Fungi",
  "Chromista",
  "Protozoa",
  "Unknown",
];

// Quality-grade choices for the dropdown. `value` is sent verbatim as the API's
// quality_grade parameter (several grades are comma-separated); an empty value
// sends nothing, i.e. every grade. iNaturalist has three grades - research,
// needs_id and casual - and "verifiable" is simply research + needs_id (the
// old checkbox's meaning). rinat's own `quality` argument only knows
// casual/research, so needs_id is the one option that goes beyond it.
const QUALITY_GRADES = [
  { value: "", label: "Any quality grade" },
  { value: "research", label: "Research grade" },
  { value: "needs_id", label: "Needs ID" },
  { value: "casual", label: "Casual" },
  { value: "research,needs_id", label: "Verifiable (research + needs ID)" },
];

// Values for the API's photo_license parameter (rinat's `photo_license`).
// Lower-case, as iNaturalist recommends.
const PHOTO_LICENSES = [
  { value: "", label: "Any (no license filter)" },
  { value: "cc0", label: "CC0 (public domain)" },
  { value: "cc-by", label: "CC BY" },
  { value: "cc-by-sa", label: "CC BY-SA" },
  { value: "cc-by-nc", label: "CC BY-NC" },
  { value: "cc-by-nd", label: "CC BY-ND" },
  { value: "cc-by-nc-sa", label: "CC BY-NC-SA" },
  { value: "cc-by-nc-nd", label: "CC BY-NC-ND" },
];

// iNaturalist's controlled-vocabulary annotations (rinat's `annotation`
// argument: term ID + value ID). Sent as term_id / term_value_id. IDs follow
// iNaturalist's "How to use iNaturalist Search URLs" help page. Each term has
// an `id`, a `label` and its `values` as [value id, value label] pairs.
const ANNOTATION_TERMS = [
  {
    id: 1,
    label: "Life stage",
    values: [
      [2, "Adult"],
      [3, "Teneral"],
      [4, "Pupa"],
      [5, "Nymph"],
      [6, "Larva"],
      [7, "Egg"],
      [8, "Juvenile"],
      [16, "Subimago"],
    ],
  },
  {
    id: 9,
    label: "Sex",
    values: [
      [10, "Female"],
      [11, "Male"],
      [20, "Cannot be determined"],
    ],
  },
  {
    id: 12,
    label: "Flowers and fruits",
    values: [
      [13, "Flowers"],
      [14, "Fruits or seeds"],
      [15, "Flower buds"],
      [21, "No flowers or fruits"],
    ],
  },
  {
    id: 36,
    label: "Leaves",
    values: [
      [37, "Breaking leaf buds"],
      [38, "Green leaves"],
      [39, "Colored leaves"],
      [40, "No live leaves"],
    ],
  },
  {
    id: 17,
    label: "Alive or dead",
    values: [
      [18, "Alive"],
      [19, "Dead"],
      [20, "Cannot be determined"],
    ],
  },
  {
    id: 22,
    label: "Evidence of presence",
    values: [
      [23, "Feather"],
      [24, "Organism"],
      [25, "Scat"],
      [26, "Track"],
      [27, "Bone"],
      [28, "Molt"],
      [29, "Gall"],
      [30, "Egg"],
      [31, "Hair"],
      [32, "Leafmine"],
      [35, "Construction"],
    ],
  },
];

// Small green/slate "search + paw" glyph used for the panel's rail icon,
// where an <img> is used and `currentColor` cannot follow the app theme.
const RAIL_ICON_DATA_URI =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<circle cx="10" cy="10" r="6" fill="none" stroke="#64748b" stroke-width="2"/>' +
      '<line x1="14.5" y1="14.5" x2="20" y2="20" stroke="#64748b" stroke-width="2" stroke-linecap="round"/>' +
      '<ellipse cx="10" cy="12" rx="2.6" ry="2.1" fill="#16a34a"/>' +
      '<circle cx="6.8" cy="8.3" r="1.15" fill="#16a34a"/>' +
      '<circle cx="8.8" cy="6.3" r="1.15" fill="#16a34a"/>' +
      '<circle cx="11.2" cy="6.3" r="1.15" fill="#16a34a"/>' +
      '<circle cx="13.2" cy="8.3" r="1.15" fill="#16a34a"/>' +
      "</svg>",
  );

// ############################################################################
// ########## Module state ###################################################
// ############################################################################

const state = {
  app: null,
  map: null,
  mapHandlers: null,
  disposePanel: null,
  panelKind: null, // "right" | "floating" | null
  popup: null,
  fetching: false,
  abortController: null,
  layerCount: 0,
};

// ############################################################################
// ########## Small helpers ##################################################
// ############################################################################

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatCount(n) {
  return new Intl.NumberFormat().format(n);
}

// Built through the DOM API (not innerHTML) so nothing from the API response
// - descriptions, usernames, etc. - is ever parsed as markup.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// Recursively walks a GeoJSON coordinate array (Point, LineString, Polygon,
// Multi*, GeometryCollection - any depth) and folds every [lng, lat] pair it
// finds into a running [west, south, east, north] box.
function extendBoundsWithCoordinates(bounds, coords) {
  if (coords.length === 0) return;
  if (typeof coords[0] === "number") {
    const [lng, lat] = coords;
    if (typeof lng !== "number" || typeof lat !== "number") return;
    if (lng < bounds.west) bounds.west = lng;
    if (lng > bounds.east) bounds.east = lng;
    if (lat < bounds.south) bounds.south = lat;
    if (lat > bounds.north) bounds.north = lat;
    return;
  }
  for (const child of coords) extendBoundsWithCoordinates(bounds, child);
}

// Computes a [west, south, east, north] bounding box from an array of
// GeoJSON features - used for the "active layer extent" area mode, the
// GeoLibre equivalent of the QGIS plugin's "use layer extent" option.
// Returns null when the features contain no usable geometry.
function computeBoundsFromFeatures(features) {
  const bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
  for (const feature of features || []) {
    const geometry = feature && feature.geometry;
    if (!geometry || !geometry.coordinates) continue;
    extendBoundsWithCoordinates(bounds, geometry.coordinates);
  }
  if (
    !Number.isFinite(bounds.west) ||
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.east) ||
    !Number.isFinite(bounds.north)
  ) {
    return null;
  }
  return [bounds.west, bounds.south, bounds.east, bounds.north];
}

// Formats a Date as YYYY-MM-DD, which is what the iNaturalist API's d1/d2
// parameters expect.
function toIsoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Splits a comma- and/or space-separated field into trimmed, non-empty tokens.
function splitList(raw) {
  return String(raw || "")
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

// Parses a list of numeric iNaturalist IDs (taxon / place). Tokens that aren't
// plain positive integers come back in `invalid` so the caller can tell the
// person instead of quietly dropping them.
function parseIdList(raw) {
  const ids = [];
  const invalid = [];
  for (const token of splitList(raw)) {
    if (/^\d+$/.test(token)) ids.push(token);
    else invalid.push(token);
  }
  return { ids, invalid };
}

// "Life stage \u2192 Larva" for the results summary.
function describeAnnotation(termId, valueId) {
  const term = ANNOTATION_TERMS.find((t) => String(t.id) === String(termId));
  if (!term) return null;
  const value = valueId
    ? term.values.find(([id]) => String(id) === String(valueId))
    : null;
  return value ? `${term.label} \u2192 ${value[1]}` : `${term.label} (any value)`;
}

// ############################################################################
// ########## Toolbar icon (vector, not text) ################################
// ############################################################################

// A magnifying glass with a paw print inside it: "search/extract wildlife
// observations". Built from plain SVG primitives (circle/line/ellipse), fully
// vector and themeable with currentColor - i.e. a real icon, not a text
// label standing in for one.
function createToolbarIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");

  const glass = document.createElementNS(SVG_NS, "circle");
  glass.setAttribute("cx", "10");
  glass.setAttribute("cy", "10");
  glass.setAttribute("r", "6");
  glass.setAttribute("stroke", "currentColor");
  glass.setAttribute("stroke-width", "2");
  svg.appendChild(glass);

  const handle = document.createElementNS(SVG_NS, "line");
  handle.setAttribute("x1", "14.5");
  handle.setAttribute("y1", "14.5");
  handle.setAttribute("x2", "20");
  handle.setAttribute("y2", "20");
  handle.setAttribute("stroke", "currentColor");
  handle.setAttribute("stroke-width", "2");
  handle.setAttribute("stroke-linecap", "round");
  svg.appendChild(handle);

  const pad = document.createElementNS(SVG_NS, "ellipse");
  pad.setAttribute("cx", "10");
  pad.setAttribute("cy", "12");
  pad.setAttribute("rx", "2.6");
  pad.setAttribute("ry", "2.1");
  pad.setAttribute("fill", "currentColor");
  svg.appendChild(pad);

  const toes = [
    [6.8, 8.3],
    [8.8, 6.3],
    [11.2, 6.3],
    [13.2, 8.3],
  ];
  for (const [cx, cy] of toes) {
    const toe = document.createElementNS(SVG_NS, "circle");
    toe.setAttribute("cx", String(cx));
    toe.setAttribute("cy", String(cy));
    toe.setAttribute("r", "1.15");
    toe.setAttribute("fill", "currentColor");
    svg.appendChild(toe);
  }

  return svg;
}

// ############################################################################
// ########## Map control (toolbar button) ###################################
// ############################################################################

const control = {
  _container: null,
  onAdd() {
    const container = document.createElement("div");
    container.className =
      "maplibregl-ctrl maplibregl-ctrl-group geolibre-inat-control";
    const button = document.createElement("button");
    button.type = "button";
    button.title = "iNaturalist Extractor";
    button.setAttribute("aria-label", "Open the iNaturalist Extractor panel");
    button.appendChild(createToolbarIcon());
    button.addEventListener("click", () => {
      if (state.panelKind === "right") {
        state.app?.openRightPanel?.(PANEL_ID);
      } else if (state.panelKind === "floating") {
        state.app?.openFloatingPanel?.(PANEL_ID);
      }
    });
    container.appendChild(button);
    this._container = container;
    return container;
  },
  onRemove() {
    this._container?.remove();
    this._container = null;
  },
};

// ############################################################################
// ########## Panel UI ########################################################
// ############################################################################

function renderPanel(container) {
  const root = el("div", "geolibre-inat-panel");

  const warning = el("div", "geolibre-inat-warning");
  warning.appendChild(
    document.createTextNode(
      "For small-to-medium batches, not bulk scraping - see the ",
    ),
  );
  const link = document.createElement("a");
  link.href = RECOMMENDED_PRACTICES_URL;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "API recommended practices";
  warning.appendChild(link);
  warning.appendChild(document.createTextNode("."));
  root.appendChild(warning);

  const form = el("div", "geolibre-inat-form");

  // ---- Area: current view vs. active layer extent -------------------------
  form.appendChild(el("div", "geolibre-inat-section-title", "Area"));

  const areaRadioGroup = el("div", "geolibre-inat-radio-group");
  const areaViewRow = el("label", "geolibre-inat-row geolibre-inat-radio-row");
  const areaViewRadio = document.createElement("input");
  areaViewRadio.type = "radio";
  areaViewRadio.name = `${PLUGIN_ID}-area`;
  areaViewRadio.value = "view";
  areaViewRadio.checked = true;
  areaViewRow.appendChild(areaViewRadio);
  areaViewRow.appendChild(el("span", null, "Current map view"));
  areaRadioGroup.appendChild(areaViewRow);

  const areaLayerRow = el("label", "geolibre-inat-row geolibre-inat-radio-row");
  const areaLayerRadio = document.createElement("input");
  areaLayerRadio.type = "radio";
  areaLayerRadio.name = `${PLUGIN_ID}-area`;
  areaLayerRadio.value = "layer";
  areaLayerRow.appendChild(areaLayerRadio);
  areaLayerRow.appendChild(el("span", null, "Active layer extent"));
  areaRadioGroup.appendChild(areaLayerRow);
  form.appendChild(areaRadioGroup);

  const layerSelect = document.createElement("select");
  layerSelect.className = "geolibre-inat-select";
  layerSelect.disabled = true;
  form.appendChild(layerSelect);

  const layerHint = el(
    "div",
    "geolibre-inat-hint",
    "Uses the bounding box of the layer selected in the Layers panel.",
  );
  layerHint.hidden = true;
  form.appendChild(layerHint);

  function populateLayerSelect() {
    const app = state.app;
    const layers = app?.listLayers?.() ?? [];
    const activeId = app?.getSelectedLayerId?.() ?? null;
    layerSelect.replaceChildren();
    if (layers.length === 0) {
      const option = el("option", null, "No layers available");
      option.value = "";
      layerSelect.appendChild(option);
      layerSelect.disabled = true;
      return;
    }
    for (const layer of layers) {
      const option = el("option", null, layer.name || layer.id);
      option.value = layer.id;
      layerSelect.appendChild(option);
    }
    if (activeId && layers.some((l) => l.id === activeId)) {
      layerSelect.value = activeId;
    }
  }

  function updateAreaMode() {
    const useLayer = areaLayerRadio.checked;
    layerHint.hidden = !useLayer;
    if (useLayer) {
      populateLayerSelect();
      layerSelect.disabled = false;
    } else {
      layerSelect.disabled = true;
    }
  }
  areaViewRadio.addEventListener("change", updateAreaMode);
  areaLayerRadio.addEventListener("change", updateAreaMode);

  // ---- Quality grade --------------------------------------------------------
  form.appendChild(el("div", "geolibre-inat-section-title", "Quality grade"));

  const qualitySelect = document.createElement("select");
  qualitySelect.className = "geolibre-inat-select";
  for (const grade of QUALITY_GRADES) {
    const option = el("option", null, grade.label);
    option.value = grade.value;
    qualitySelect.appendChild(option);
  }
  form.appendChild(qualitySelect);

  form.appendChild(
    el(
      "div",
      "geolibre-inat-hint",
      "Research: community-confirmed ID. Needs ID: verifiable, not yet confirmed. Casual: not verifiable (e.g. captive/cultivated, or no date or photo).",
    ),
  );

  // ---- Date filter: all years, or a from/to range ---------------------------
  form.appendChild(el("div", "geolibre-inat-section-title", "Date"));

  const dateFilterRow = el("label", "geolibre-inat-row geolibre-inat-checkbox-row");
  const dateFilterCheckbox = document.createElement("input");
  dateFilterCheckbox.type = "checkbox";
  dateFilterRow.appendChild(dateFilterCheckbox);
  dateFilterRow.appendChild(el("span", null, "Filter by date"));
  form.appendChild(dateFilterRow);

  const dateRangeRow = el("div", "geolibre-inat-row");
  const dateFromInput = document.createElement("input");
  dateFromInput.type = "date";
  dateFromInput.className = "geolibre-inat-date-input";
  dateFromInput.disabled = true;
  const dateToInput = document.createElement("input");
  dateToInput.type = "date";
  dateToInput.className = "geolibre-inat-date-input";
  dateToInput.disabled = true;
  dateRangeRow.appendChild(dateFromInput);
  dateRangeRow.appendChild(el("span", null, "to"));
  dateRangeRow.appendChild(dateToInput);
  form.appendChild(dateRangeRow);

  const dateHint = el(
    "div",
    "geolibre-inat-hint",
    "Unchecked: observations from all years. For a single year, use Jan 1 to Dec 31; for a single day, use the same date twice.",
  );
  form.appendChild(dateHint);

  dateFilterCheckbox.addEventListener("change", () => {
    const enabled = dateFilterCheckbox.checked;
    dateFromInput.disabled = !enabled;
    dateToInput.disabled = !enabled;
  });

  // ---- Species / taxon filter ------------------------------------------------
  form.appendChild(el("div", "geolibre-inat-section-title", "Species / taxon"));

  const taxonRow = el("div", "geolibre-inat-row");
  const taxonInput = document.createElement("input");
  taxonInput.type = "text";
  taxonInput.placeholder = "Scientific or common name (optional)";
  taxonInput.className = "geolibre-inat-text-input";
  taxonRow.appendChild(taxonInput);
  form.appendChild(taxonRow);

  const taxaHint = el(
    "div",
    "geolibre-inat-hint",
    "Leave blank and pick one or more iconic taxa below instead.",
  );
  form.appendChild(taxaHint);

  const taxaGrid = el("div", "geolibre-inat-taxa-grid");
  const taxaCheckboxes = [];
  for (const taxon of ICONIC_TAXA) {
    const label = el("label", "geolibre-inat-taxa-item");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = taxon;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(taxon));
    taxaGrid.appendChild(label);
    taxaCheckboxes.push(checkbox);
  }
  form.appendChild(taxaGrid);

  function updateTaxonMode() {
    const hasTaxonName = taxonInput.value.trim().length > 0;
    taxaGrid.classList.toggle("is-disabled", hasTaxonName);
    for (const checkbox of taxaCheckboxes) checkbox.disabled = hasTaxonName;
  }
  taxonInput.addEventListener("input", updateTaxonMode);

  // ---- Observer / keyword filter ------------------------------------------
  form.appendChild(el("div", "geolibre-inat-section-title", "Observer / keyword"));

  const userRow = el("div", "geolibre-inat-row");
  const userInput = document.createElement("input");
  userInput.type = "text";
  userInput.placeholder = "Username(s), comma-separated (optional)";
  userInput.className = "geolibre-inat-text-input";
  userRow.appendChild(userInput);
  form.appendChild(userRow);

  const userHint = el(
    "div",
    "geolibre-inat-hint",
    "Only observations by these iNaturalist account(s), e.g. \u201cnaturalist_jo, another_user\u201d.",
  );
  form.appendChild(userHint);

  const queryRow = el("div", "geolibre-inat-row");
  const queryInput = document.createElement("input");
  queryInput.type = "text";
  queryInput.placeholder = "Keyword search, e.g. habitat or behaviour (optional)";
  queryInput.className = "geolibre-inat-text-input";
  queryRow.appendChild(queryInput);
  form.appendChild(queryRow);

  const queryHint = el(
    "div",
    "geolibre-inat-hint",
    "Free-text search across the whole observation (like rinat's \u201cquery\u201d) - broader than the species field above.",
  );
  form.appendChild(queryHint);

  // ---- Advanced filters (rinat) ---------------------------------------------
  // Collapsed by default: these are the get_inat_obs() arguments the basic
  // form doesn't cover, so the panel stays short for everyday use.
  const advanced = document.createElement("details");
  advanced.className = "geolibre-inat-advanced";
  advanced.appendChild(
    el(
      "summary",
      "geolibre-inat-section-title geolibre-inat-advanced-summary",
      "Advanced filters (rinat)",
    ),
  );
  const advancedBody = el("div", "geolibre-inat-advanced-body");
  advanced.appendChild(advancedBody);

  // Adds "label, control, hint" as one field; returns the control.
  function addAdvancedField(labelText, control, hintText) {
    advancedBody.appendChild(el("div", "geolibre-inat-field-label", labelText));
    advancedBody.appendChild(control);
    if (hintText) advancedBody.appendChild(el("div", "geolibre-inat-hint", hintText));
    return control;
  }

  function makeTextRow(placeholder) {
    const row = el("div", "geolibre-inat-row");
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.className = "geolibre-inat-text-input";
    row.appendChild(input);
    return { row, input };
  }

  const taxonIdField = makeTextRow("e.g. 47219 (comma-separated for several)");
  const taxonIdInput = taxonIdField.input;
  addAdvancedField(
    "Taxon ID",
    taxonIdField.row,
    "Exact iNaturalist taxon ID(s), descendants included \u2014 the number in a taxon's URL (\u2026/taxa/47219-\u2026). Must match together with the species / iconic-taxa filters above.",
  );

  const placeIdField = makeTextRow("e.g. 6744 (comma-separated for several)");
  const placeIdInput = placeIdField.input;
  addAdvancedField(
    "Place ID",
    placeIdField.row,
    "iNaturalist place ID(s) \u2014 the number in a place's URL on Explore. Also limited by the Area above unless you tick \u201cIgnore the Area\u201d below.",
  );

  const photoLicenseSelect = document.createElement("select");
  photoLicenseSelect.className = "geolibre-inat-select";
  for (const license of PHOTO_LICENSES) {
    const option = el("option", null, license.label);
    option.value = license.value;
    photoLicenseSelect.appendChild(option);
  }
  addAdvancedField(
    "Photo license",
    photoLicenseSelect,
    "Only observations with a photo under this license, so observations without photos are left out.",
  );

  const projectField = makeTextRow("ID or slug, e.g. crows-in-vermont");
  const projectInput = projectField.input;
  addAdvancedField(
    "Project",
    projectField.row,
    "Project ID or URL slug (comma-separated for several). Only observations added to the project.",
  );

  // Annotation = a term (life stage, sex, ...) and, optionally, one of its
  // values (adult, female, ...) - rinat's two-element `annotation` vector.
  const annotationRow = el("div", "geolibre-inat-row");
  const annotationTermSelect = document.createElement("select");
  annotationTermSelect.className = "geolibre-inat-select";
  const noTermOption = el("option", null, "No annotation filter");
  noTermOption.value = "";
  annotationTermSelect.appendChild(noTermOption);
  for (const term of ANNOTATION_TERMS) {
    const option = el("option", null, term.label);
    option.value = String(term.id);
    annotationTermSelect.appendChild(option);
  }
  const annotationValueSelect = document.createElement("select");
  annotationValueSelect.className = "geolibre-inat-select";
  annotationRow.appendChild(annotationTermSelect);
  annotationRow.appendChild(annotationValueSelect);

  function updateAnnotationValues() {
    const term = ANNOTATION_TERMS.find(
      (t) => String(t.id) === annotationTermSelect.value,
    );
    annotationValueSelect.replaceChildren();
    const anyOption = el("option", null, "Any value");
    anyOption.value = "";
    annotationValueSelect.appendChild(anyOption);
    if (!term) {
      annotationValueSelect.disabled = true;
      return;
    }
    for (const [valueId, valueLabel] of term.values) {
      const option = el("option", null, valueLabel);
      option.value = String(valueId);
      annotationValueSelect.appendChild(option);
    }
    annotationValueSelect.disabled = false;
  }
  annotationTermSelect.addEventListener("change", updateAnnotationValues);
  updateAnnotationValues();

  addAdvancedField(
    "Annotation",
    annotationRow,
    "Pick a term, then optionally a value \u2014 e.g. Life stage \u2192 Larva. Leaving the value on \u201cAny value\u201d keeps every observation that has that annotation.",
  );

  const ignoreAreaRow = el("label", "geolibre-inat-row geolibre-inat-checkbox-row");
  const ignoreAreaCheckbox = document.createElement("input");
  ignoreAreaCheckbox.type = "checkbox";
  ignoreAreaRow.appendChild(ignoreAreaCheckbox);
  ignoreAreaRow.appendChild(
    el("span", null, "Ignore the Area (don\u2019t limit to the view / layer extent)"),
  );
  advancedBody.appendChild(ignoreAreaRow);
  advancedBody.appendChild(
    el(
      "div",
      "geolibre-inat-hint",
      "Useful when a place or project reaches beyond the current view. Needs at least one other filter (species, taxon ID, place, project, observer or keyword).",
    ),
  );

  form.appendChild(advanced);

  // ---- Max observations -------------------------------------------------
  form.appendChild(el("div", "geolibre-inat-section-title", "Results"));

  const maxRow = el("label", "geolibre-inat-row");
  maxRow.appendChild(el("span", "geolibre-inat-row-label", "Max observations"));
  const maxInput = document.createElement("input");
  maxInput.type = "number";
  maxInput.min = "10";
  maxInput.max = String(MAX_ALLOWED_OBS);
  maxInput.step = "10";
  maxInput.value = String(DEFAULT_MAX_OBS);
  maxInput.className = "geolibre-inat-number-input";
  maxRow.appendChild(maxInput);
  form.appendChild(maxRow);

  const hint = el(
    "div",
    "geolibre-inat-hint",
    "Only observations with real coordinates are extracted. A photo is included whenever the observation has one, but it's never required.",
  );
  form.appendChild(hint);

  const fetchButton = el("button", "geolibre-inat-primary-button", "Fetch observations");
  fetchButton.type = "button";
  form.appendChild(fetchButton);

  const status = el("div", "geolibre-inat-status");
  status.hidden = true;
  form.appendChild(status);

  root.appendChild(form);

  const results = el("div", "geolibre-inat-results");
  results.hidden = true;
  root.appendChild(results);

  const credit = el(
    "div",
    "geolibre-inat-credit",
    "Data and photos courtesy of the iNaturalist community.",
  );
  root.appendChild(credit);

  fetchButton.addEventListener("click", () => {
    const iconicTaxa = taxaCheckboxes
      .filter((c) => c.checked && !c.disabled)
      .map((c) => c.value);
    void runExtraction({
      areaMode: areaLayerRadio.checked ? "layer" : "view",
      layerId: layerSelect.value || null,
      qualityGrade: qualitySelect.value || null,
      taxonIdsRaw: taxonIdInput.value,
      placeIdsRaw: placeIdInput.value,
      projectRaw: projectInput.value,
      photoLicense: photoLicenseSelect.value || null,
      annotationTermId: annotationTermSelect.value || null,
      annotationValueId: annotationValueSelect.value || null,
      ignoreArea: ignoreAreaCheckbox.checked,
      maxObs: clamp(parseInt(maxInput.value, 10) || DEFAULT_MAX_OBS, 10, MAX_ALLOWED_OBS),
      useDateFilter: dateFilterCheckbox.checked,
      dateFrom: dateFromInput.value || null,
      dateTo: dateToInput.value || null,
      taxonName: taxonInput.value.trim() || null,
      iconicTaxa,
      userLogins: userInput.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      query: queryInput.value.trim() || null,
      fetchButton,
      status,
      results,
    });
  });

  // Populate the layer dropdown once up front so it isn't empty the first
  // time the user switches to "Active layer extent".
  populateLayerSelect();

  // GeoLibre calls render(container) once with an empty element that the
  // plugin has to fill itself (see GeoLibre's plugin API docs), so the panel
  // must be mounted here; the returned function is the cleanup.
  container.appendChild(root);

  return () => {
    root.remove();
  };
}

function setStatus(status, text) {
  status.hidden = !text;
  status.textContent = text || "";
}

function setResults(results, lines) {
  results.replaceChildren();
  if (!lines || lines.length === 0) {
    results.hidden = true;
    return;
  }
  results.hidden = false;
  for (const line of lines) {
    results.appendChild(el("div", "geolibre-inat-results-line", line));
  }
}

// ############################################################################
// ########## Fetching + mapping observations ################################
// ############################################################################

function buildRequestUrl({
  bounds,
  qualityGrade,
  page,
  perPage,
  d1,
  d2,
  taxonName,
  iconicTaxa,
  userLogins,
  query,
  taxonIds,
  placeIds,
  projectIds,
  photoLicense,
  termId,
  termValueId,
}) {
  const params = new URLSearchParams({
    order_by: "id",
    order: "desc",
    spam: "false",
    // Baseline requirement: only observations with real, public
    // coordinates are ever worth extracting onto a map.
    geo: "true",
    per_page: String(perPage),
    page: String(page),
    locale: (navigator.language || "en").slice(0, 2),
  });
  // `bounds` is null when the person chose to ignore the Area (place / project
  // searches that shouldn't be clipped to the current view).
  if (bounds) {
    const [west, south, east, north] = bounds;
    params.set("swlat", String(south));
    params.set("swlng", String(west));
    params.set("nelat", String(north));
    params.set("nelng", String(east));
  }
  if (qualityGrade) params.set("quality_grade", qualityGrade);
  if (d1) params.set("d1", d1);
  if (d2) params.set("d2", d2);
  if (taxonName) params.set("taxon_name", taxonName);
  if (Array.isArray(iconicTaxa)) {
    for (const taxon of iconicTaxa) params.append("iconic_taxa[]", taxon);
  }
  if (Array.isArray(userLogins)) {
    for (const login of userLogins) params.append("user_login[]", login);
  }
  if (query) params.set("q", query);

  // Advanced filters (rinat). The API takes several values as a
  // comma-separated list.
  if (taxonIds && taxonIds.length > 0) params.set("taxon_id", taxonIds.join(","));
  if (placeIds && placeIds.length > 0) params.set("place_id", placeIds.join(","));
  if (projectIds && projectIds.length > 0) {
    params.set("project_id", projectIds.join(","));
  }
  if (photoLicense) params.set("photo_license", photoLicense);
  if (termId) {
    params.set("term_id", String(termId));
    // term_value_id only makes sense alongside its term_id.
    if (termValueId) params.set("term_value_id", String(termValueId));
  }
  return `${API_BASE}?${params.toString()}`;
}

// Maps one iNaturalist observation to a GeoJSON Feature. Returns null for an
// observation with no usable coordinates (defensive - the request already
// asks for geo=true, but a feature this can't place is still worth skipping
// rather than crashing the whole batch).
function observationToFeature(obs) {
  if (!obs.geojson || !Array.isArray(obs.geojson.coordinates)) return null;

  const taxon = obs.taxon || {};
  const user = obs.user || {};

  const photos = Array.isArray(obs.observation_photos)
    ? obs.observation_photos
        .map((entry) => entry && entry.photo)
        .filter(Boolean)
        .slice(0, 5)
        .map((photo) => ({
          thumb: photo.square_url || photo.url || null,
          large:
            photo.large_url ||
            (photo.url ? photo.url.replace("square.", "large.") : null),
          attribution: photo.attribution_name || photo.attribution || null,
        }))
        .filter((p) => p.thumb || p.large)
    : [];

  const date =
    obs.time_observed_at ||
    (obs.observed_on_details && obs.observed_on_details.date) ||
    obs.observed_on ||
    null;

  let description = obs.description || null;
  if (description && description.length > 400) {
    description = `${description.slice(0, 400)}\u2026`;
  }

  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: obs.geojson.coordinates,
    },
    properties: {
      [MARKER_PROP]: true,
      inatId: obs.id,
      name: taxon.name || null,
      commonName: taxon.preferred_common_name || null,
      iconicTaxonName: taxon.iconic_taxon_name || null,
      rank: taxon.rank || null,
      taxonId: taxon.id || null,
      observerLogin: user.login || null,
      observerName: user.name || user.login || null,
      date,
      description,
      quality: obs.quality_grade || null,
      geoprivacy: obs.geoprivacy || null,
      positionalAccuracy:
        typeof obs.positional_accuracy === "number" ? obs.positional_accuracy : null,
      uri: obs.uri || `https://www.inaturalist.org/observations/${obs.id}`,
      taxonUrl: taxon.id ? `https://www.inaturalist.org/taxa/${taxon.id}` : null,
      photos,
    },
  };
}

async function runExtraction({
  areaMode,
  layerId,
  qualityGrade,
  taxonIdsRaw,
  placeIdsRaw,
  projectRaw,
  photoLicense,
  annotationTermId,
  annotationValueId,
  ignoreArea,
  maxObs,
  useDateFilter,
  dateFrom,
  dateTo,
  taxonName,
  iconicTaxa,
  userLogins,
  query,
  fetchButton,
  status,
  results,
}) {
  if (state.fetching) return;

  const app = state.app;
  if (!app) return;

  // Advanced filters: taxon / place IDs must be numbers; the project may be an
  // ID or a slug. Bad input is reported rather than silently dropped.
  const taxonParsed = parseIdList(taxonIdsRaw);
  if (taxonParsed.invalid.length > 0) {
    setStatus(
      status,
      `Taxon ID must be a number (e.g. 47219) - not \u201c${taxonParsed.invalid.join(", ")}\u201d.`,
    );
    return;
  }
  const placeParsed = parseIdList(placeIdsRaw);
  if (placeParsed.invalid.length > 0) {
    setStatus(
      status,
      `Place ID must be a number (e.g. 6744) - not \u201c${placeParsed.invalid.join(", ")}\u201d.`,
    );
    return;
  }
  const taxonIds = taxonParsed.ids;
  const placeIds = placeParsed.ids;
  const projectIds = splitList(projectRaw);

  if (ignoreArea) {
    const hasOtherFilter =
      Boolean(taxonName) ||
      (iconicTaxa && iconicTaxa.length > 0) ||
      taxonIds.length > 0 ||
      placeIds.length > 0 ||
      projectIds.length > 0 ||
      (userLogins && userLogins.length > 0) ||
      Boolean(query);
    if (!hasOtherFilter) {
      setStatus(
        status,
        "Ignoring the Area needs at least one other filter (species, taxon ID, place, project, observer or keyword).",
      );
      return;
    }
  }

  let bounds = null;
  if (!ignoreArea) {
    if (areaMode === "layer") {
      if (!layerId) {
        setStatus(status, "Pick a layer first, or switch to \u201cCurrent map view\u201d.");
        return;
      }
      // getLayerFeatures throws for an unknown layer id (e.g. the layer was
      // removed after the dropdown was filled), so report that instead of
      // letting the click do nothing.
      let features = [];
      try {
        features = app.getLayerFeatures?.(layerId) ?? [];
      } catch {
        setStatus(status, "That layer is no longer available - pick another one from the list.");
        return;
      }
      bounds = computeBoundsFromFeatures(features);
      if (!bounds) {
        setStatus(status, "That layer has no usable geometry to derive an extent from.");
        return;
      }
    } else {
      bounds = app.getViewBounds?.() ?? null;
      if (!bounds) {
        setStatus(status, "Current map extent isn't available right now - pan or zoom the map and try again.");
        return;
      }
    }
  }

  const d1 = useDateFilter ? toIsoDate(dateFrom) : null;
  const d2 = useDateFilter ? toIsoDate(dateTo) : null;
  if (useDateFilter && !d1 && !d2) {
    setStatus(status, "Pick at least a start or end date, or uncheck \u201cFilter by date\u201d.");
    return;
  }

  state.fetching = true;
  state.abortController = new AbortController();
  fetchButton.disabled = true;
  setResults(results, null);
  setStatus(status, "Contacting iNaturalist\u2026");

  const perPage = Math.min(PER_PAGE_LIMIT, maxObs);
  let totalPages = Math.ceil(maxObs / perPage);
  const collected = [];
  let totalAvailable = null;

  try {
    for (let page = 1; page <= totalPages; page += 1) {
      const url = buildRequestUrl({
        bounds,
        qualityGrade,
        page,
        perPage,
        d1,
        d2,
        taxonName,
        iconicTaxa,
        userLogins,
        query,
        taxonIds,
        placeIds,
        projectIds,
        photoLicense,
        termId: annotationTermId,
        termValueId: annotationValueId,
      });
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: state.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`iNaturalist API responded with ${response.status}`);
      }

      const data = await response.json();

      if (totalAvailable === null) {
        totalAvailable = typeof data.total_results === "number" ? data.total_results : null;
        if (totalAvailable !== null) {
          totalPages = Math.min(totalPages, Math.max(1, Math.ceil(totalAvailable / perPage)));
        }
      }

      const pageResults = Array.isArray(data.results) ? data.results : [];
      collected.push(...pageResults);

      setStatus(
        status,
        `Fetched ${formatCount(collected.length)}${
          totalAvailable !== null ? ` / ${formatCount(Math.min(totalAvailable, maxObs))}` : ""
        } observation(s)\u2026`,
      );

      if (pageResults.length < perPage) break;
      if (page < totalPages) await sleep(PAGE_DELAY_MS);
    }

    if (collected.length === 0) {
      setStatus(status, "No observations with coordinates matched these filters.");
      return;
    }

    const features = collected.map(observationToFeature).filter(Boolean);
    const withPhotos = features.filter((f) => f.properties.photos.length > 0).length;

    const featureCollection = { type: "FeatureCollection", features };

    state.layerCount += 1;
    const layerName = `iNaturalist observations (${formatCount(features.length)})`;
    app.addGeoJsonLayer(layerName, featureCollection);

    setStatus(status, "");
    const lines = [
      `Added ${formatCount(features.length)} observation(s) to the map as "${layerName}".`,
      `${formatCount(withPhotos)} of them have at least one photo - click a point to see it.`,
      ignoreArea
        ? "Area: not limited (Area setting ignored)."
        : areaMode === "layer"
          ? "Area: extent of the selected layer."
          : "Area: current map view.",
    ];
    if (qualityGrade) {
      const grade = QUALITY_GRADES.find((g) => g.value === qualityGrade);
      lines.push(`Quality grade: ${grade ? grade.label : qualityGrade}.`);
    }
    if (taxonName) {
      lines.push(`Species filter: "${taxonName}".`);
    } else if (iconicTaxa && iconicTaxa.length > 0) {
      lines.push(`Iconic taxa: ${iconicTaxa.join(", ")}.`);
    }
    if (d1 || d2) {
      lines.push(`Date range: ${d1 || "\u2026"} to ${d2 || "\u2026"}.`);
    }
    if (userLogins && userLogins.length > 0) {
      lines.push(`Observer(s): ${userLogins.join(", ")}.`);
    }
    if (query) {
      lines.push(`Keyword search: "${query}".`);
    }
    if (taxonIds.length > 0) lines.push(`Taxon ID: ${taxonIds.join(", ")}.`);
    if (placeIds.length > 0) lines.push(`Place ID: ${placeIds.join(", ")}.`);
    if (projectIds.length > 0) lines.push(`Project: ${projectIds.join(", ")}.`);
    if (photoLicense) {
      const license = PHOTO_LICENSES.find((l) => l.value === photoLicense);
      lines.push(`Photo license: ${license ? license.label : photoLicense}.`);
    }
    const annotationLabel = annotationTermId
      ? describeAnnotation(annotationTermId, annotationValueId)
      : null;
    if (annotationLabel) lines.push(`Annotation: ${annotationLabel}.`);
    if (totalAvailable !== null && totalAvailable > features.length) {
      lines.push(
        `${formatCount(totalAvailable)} total observations exist for these filters - increase "Max observations" to see more.`,
      );
    }
    setResults(results, lines);
  } catch (error) {
    if (error?.name !== "AbortError") {
      setStatus(status, `Could not fetch observations: ${error.message || error}`);
    }
  } finally {
    state.fetching = false;
    state.abortController = null;
    fetchButton.disabled = false;
  }
}

// ############################################################################
// ########## Map interactions: click-to-popup ################################
// ############################################################################

function attachMapInteractions(map) {
  const onClick = (event) => {
    const features = map.queryRenderedFeatures(event.point);
    const feature = features.find((f) => f.properties && f.properties[MARKER_PROP]);
    if (!feature) {
      closePopup();
      return;
    }
    showPopup(map, feature, event.lngLat);
  };

  const onMouseMove = (event) => {
    const features = map.queryRenderedFeatures(event.point);
    const hasFeature = features.some((f) => f.properties && f.properties[MARKER_PROP]);
    map.getCanvas().style.cursor = hasFeature ? "pointer" : "";
  };

  map.on("click", onClick);
  map.on("mousemove", onMouseMove);
  state.mapHandlers = { onClick, onMouseMove };
}

function detachMapInteractions(map) {
  if (!map || !state.mapHandlers) return;
  map.off("click", state.mapHandlers.onClick);
  map.off("mousemove", state.mapHandlers.onMouseMove);
  if (map.getCanvas()) map.getCanvas().style.cursor = "";
  state.mapHandlers = null;
}

// The popup is a plain DOM overlay positioned with map.project(), rather than
// maplibre-gl's own Popup class - that keeps this plugin from having to
// bundle a full copy of maplibre-gl just for one widget, and matches the
// pattern GeoLibre's own cross-engine controls use for map-anchored DOM.
function showPopup(map, feature, lngLat) {
  closePopup();

  const props = feature.properties || {};
  let photos = props.photos;
  if (typeof photos === "string") {
    try {
      photos = JSON.parse(photos);
    } catch {
      photos = [];
    }
  }
  if (!Array.isArray(photos)) photos = [];

  const container = map.getContainer();
  const popupEl = el("div", "geolibre-inat-popup");

  const closeButton = el("button", "geolibre-inat-popup-close", "\u00d7");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    closePopup();
  });
  popupEl.appendChild(closeButton);

  // Photo popup - only rendered when the observation actually has a photo.
  if (photos.length > 0 && (photos[0].thumb || photos[0].large)) {
    const photoStrip = el("div", "geolibre-inat-popup-photos");
    photos.slice(0, 3).forEach((photo, index) => {
      const src = photo.thumb || photo.large;
      if (!src) return;
      const img = document.createElement("img");
      img.src = src;
      img.loading = "lazy";
      img.alt = props.commonName || props.name || "iNaturalist observation photo";
      img.className = "geolibre-inat-popup-thumb" + (index === 0 ? " is-main" : "");
      img.addEventListener("click", (event) => {
        event.stopPropagation();
        window.open(photo.large || src, "_blank", "noopener");
      });
      photoStrip.appendChild(img);
    });
    popupEl.appendChild(photoStrip);

    if (photos[0].attribution) {
      popupEl.appendChild(el("div", "geolibre-inat-popup-attribution", photos[0].attribution));
    }
  }

  const body = el("div", "geolibre-inat-popup-body");

  body.appendChild(
    el("div", "geolibre-inat-popup-title", props.commonName || props.name || "Unidentified observation"),
  );

  if (props.name && props.commonName && props.name !== props.commonName) {
    body.appendChild(el("div", "geolibre-inat-popup-scientific", props.name));
  }

  const rows = [
    ["Observer", props.observerName || props.observerLogin],
    ["Date", formatDate(props.date)],
    ["Quality", props.quality],
    ["Iconic taxon", props.iconicTaxonName],
  ].filter(([, value]) => Boolean(value));

  for (const [label, value] of rows) {
    const row = el("div", "geolibre-inat-popup-row");
    row.appendChild(el("span", "geolibre-inat-popup-label", `${label}:`));
    row.appendChild(document.createTextNode(value));
    body.appendChild(row);
  }

  if (props.description) {
    body.appendChild(el("p", "geolibre-inat-popup-desc", props.description));
  }

  const link = document.createElement("a");
  link.className = "geolibre-inat-popup-link";
  link.href = props.uri || (props.inatId ? `https://www.inaturalist.org/observations/${props.inatId}` : "#");
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "View on iNaturalist \u2197";
  body.appendChild(link);

  popupEl.appendChild(body);
  container.appendChild(popupEl);

  const onMove = () => positionPopup();
  map.on("move", onMove);

  state.popup = { el: popupEl, lngLat, map, onMove };
  positionPopup();
}

function positionPopup() {
  if (!state.popup) return;
  const { el: popupEl, lngLat, map } = state.popup;
  const point = map.project(lngLat);
  popupEl.style.left = `${point.x}px`;
  popupEl.style.top = `${point.y}px`;
}

function closePopup() {
  if (!state.popup) return;
  const { el: popupEl, map, onMove } = state.popup;
  map.off("move", onMove);
  popupEl.remove();
  state.popup = null;
}

// ############################################################################
// ########## Panel surface registration ######################################
// ############################################################################

function registerSurfaces(app) {
  if (app.registerRightPanel) {
    state.disposePanel = app.registerRightPanel({
      id: PANEL_ID,
      title: "iNaturalist Extractor",
      dock: "replace-style",
      icon: RAIL_ICON_DATA_URI,
      defaultWidth: 340,
      render: renderPanel,
    });
    state.panelKind = "right";
    return;
  }
  if (app.registerFloatingPanel) {
    state.disposePanel = app.registerFloatingPanel({
      id: PANEL_ID,
      title: "iNaturalist Extractor",
      defaultWidth: 320,
      render: renderPanel,
    });
    state.panelKind = "floating";
  }
}

// ############################################################################
// ########## Plugin entry point ##############################################
// ############################################################################

export const plugin = {
  id: PLUGIN_ID,
  name: "iNaturalist Extractor",
  version: "1.3.0",
  engines: ["maplibre"],

  activate(app) {
    state.app = app;

    const map = app.getMap?.() ?? null;
    state.map = map;
    if (map) attachMapInteractions(map);

    app.addMapControl(control, "top-right");
    registerSurfaces(app);
  },

  deactivate(app) {
    state.abortController?.abort();
    closePopup();

    if (state.map) detachMapInteractions(state.map);

    state.disposePanel?.();
    state.disposePanel = null;
    state.panelKind = null;

    app.removeMapControl(control);

    state.app = null;
    state.map = null;
    state.mapHandlers = null;
    state.fetching = false;
  },
};

export default plugin;
