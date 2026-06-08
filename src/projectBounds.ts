import type { FeatureCollection, Polygon } from "geojson";
import bbox from "../scripts/bbox.json";

// Project bounding box — single source of truth lives in scripts/bbox.json.
export const projectBounds = bbox;

export const projectBoundsPolygon: FeatureCollection<Polygon> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: bbox.name },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [bbox.west, bbox.south],
            [bbox.east, bbox.south],
            [bbox.east, bbox.north],
            [bbox.west, bbox.north],
            [bbox.west, bbox.south],
          ],
        ],
      },
    },
  ],
};
