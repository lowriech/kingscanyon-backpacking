import type { FeatureCollection, Polygon } from "geojson";

// Mineral King valley — subalpine glacial basin in the southern Sierra.
// Camera framing for the valley.
export const MINERAL_KING = {
  center: [-118.5969, 36.4495] as [number, number],
  zoom: 13,
  pitch: 68,
  bearing: -30,
};

// Mineral King Ranger Station, at the end of Mineral King Road.
export const RANGER_STATION = {
  name: "Mineral King Ranger Station",
  coordinates: [-118.5997, 36.4527] as [number, number],
};

// Project area of interest: 36.38N-36.50N, 118.55W-118.65W.
export const mineralKingBoundary: FeatureCollection<Polygon> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Kings Canyon Area of Interest" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-118.65, 36.38],
            [-118.55, 36.38],
            [-118.55, 36.5],
            [-118.65, 36.5],
            [-118.65, 36.38],
          ],
        ],
      },
    },
  ],
};
