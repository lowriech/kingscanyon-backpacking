import type { StyleSpecification } from "maplibre-gl";

// Kings Canyon project area of interest.
export const KINGS_CANYON = {
  center: [-118.6, 36.44] as [number, number],
  zoom: 12.2,
  pitch: 70,
  bearing: 25,
};

export const DEFAULT_EXAGGERATION = 1.5;

export const mapStyle: StyleSpecification = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    // Satellite imagery base (Esri World Imagery)
    satellite: {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    },
    // DEM for terrain + hillshade (AWS open elevation, terrarium encoding)
    terrainDEM: {
      type: "raster-dem",
      tiles: [
        "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png",
      ],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 15,
      attribution: "Elevation &copy; Mapzen / AWS Terrain Tiles",
    },
  },
  layers: [
    { id: "satellite", type: "raster", source: "satellite" },
    {
      id: "hillshade",
      type: "hillshade",
      source: "terrainDEM",
      paint: {
        "hillshade-exaggeration": 0.4,
        "hillshade-shadow-color": "#1a2230",
        "hillshade-highlight-color": "#ffffff",
      },
    },
  ],
  // 3D terrain elevation displacement
  terrain: { source: "terrainDEM", exaggeration: DEFAULT_EXAGGERATION },
  sky: {
    "sky-color": "#8fc6ff",
    "sky-horizon-blend": 0.6,
    "horizon-color": "#dfeeff",
    "horizon-fog-blend": 0.5,
    "fog-color": "#cdd9e6",
    "fog-ground-blend": 0.4,
  },
};
