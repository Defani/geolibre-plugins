# Energy Data, a GeoLibre plugin

A curated catalog of U.S. energy datasets inside GeoLibre: generation,
transmission, data centers, fuel pipelines, and outage reliability. Adding one
puts an ordinary GeoLibre layer on the map, so the host's styling, attribute
table, and analysis tools all apply to it.

## Install

In GeoLibre: **Settings → Manage Plugins**, find **Energy Data**, install.

To install a development build instead, use **Settings → Plugins → Install from
file** with a packaged zip, or add a manifest URL.

## What ships in the catalog

| Group | Datasets |
| --- | --- |
| Generation | Power plants, plants by hexbin, coal mines |
| Transmission and delivery | Transmission lines, substations |
| Demand and load growth | Data centers, their footprints, modeled growth scenarios |
| Fuels and pipelines | Natural gas, crude oil, petroleum products |

Sources are the U.S. Energy Information Administration, HIFLD, PNNL's IM3 Open
Source Data Center Atlas, and OpenStreetMap. Every entry links to its publisher.

## Pointing it at your own datasets

The catalog is a JSON document compiled into the bundle. To use a different one,
open GeoLibre with `?energyCatalog=<url>` and the plugin loads that instead,
falling back to the bundled catalog if the URL fails. The schema:

```json
{
  "version": 1,
  "defaultLayers": ["some-dataset-id"],
  "groups": [
    {
      "id": "generation",
      "label": "Generation",
      "accent": "hsl(24 88% 50%)",
      "datasets": [
        {
          "id": "some-dataset-id",
          "title": "U.S. Power Plants",
          "description": "Shown on the card, and searched.",
          "kind": "arcgis-feature",
          "url": "https://…/FeatureServer/0",
          "source": "EIA",
          "infoUrl": "https://atlas.eia.gov/",
          "tags": ["generation"],
          "maxFeatures": 2500
        }
      ]
    }
  ]
}
```

Supported kinds: `arcgis-feature` (a numbered FeatureServer layer, read as
GeoJSON and bounded to the current view), `geojson`, `overpass` (a live
OpenStreetMap query, which must bound itself with `{{bbox}}`), `cog`, and `xyz`.

GeoParquet and PMTiles are deliberately absent. Those load through GeoLibre
internals that an external plugin cannot reach.

## Development

```bash
npm install
npm test        # node:test over tests/
npm run build   # -> geolibre-plugin/dist/{index.js,style.css}
npm run package # -> geolibre-plugin/geoenergy-catalog-<version>.zip
npm run serve -- 8000   # then add http://localhost:8000/plugin.json in GeoLibre
```

Releasing: bump the version in `package.json` and `geolibre-plugin/plugin.json`,
rebuild, then open a pull request against
[opengeos/geolibre-plugins](https://github.com/opengeos/geolibre-plugins) with
the rebuilt bundle and an updated registry entry.

## Credit

Built on [GeoLibre](https://github.com/opengeos/GeoLibre) by Qiusheng Wu, and
scaffolded from its plugin template. The panel began life inside
[Geoenergy](https://github.com/Andyzxm/geoenergy), a GeoLibre fork focused on
energy data, where a fuller version of it still runs.

MIT licensed. Data belongs to its publishers.
