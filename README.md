# Kings Canyon — 3D Terrain

An interactive [MapLibre GL JS](https://maplibre.org/) map centered on **Kings Canyon National Park**, California, rendered with real elevation data for true 3D terrain displacement.

Built with **Vite + React + TypeScript**, managed with **Bun**.

## Features

- **3D elevation terrain** using AWS open elevation tiles (terrarium-encoded DEM).
- **Satellite imagery** base layer (Esri World Imagery).
- **Dynamic hillshade** for shaded relief.
- **Adjustable terrain exaggeration** slider (0–4×).
- Atmospheric **sky + fog**, pitch/rotate navigation, fullscreen, and a scale bar.
- Map state is stored in the URL hash, so you can share or bookmark a view.

No API keys required — all data sources are public.

## Quick start

```bash
make start    # installs deps, frees port 5173, runs the dev server in the background
make logs     # tail the dev server output
make stop     # kill whatever is on port 5173
make restart  # stop + start
```

Then open <http://127.0.0.1:5173>.

Prefer Bun scripts directly?

```bash
bun install
bun run dev      # dev server
bun run build    # type-check + production build
bun run preview  # preview the production build
```

## Project structure

```
index.html          Vite entry
src/
  main.tsx          React bootstrap
  App.tsx           App shell
  MapView.tsx       MapLibre map + UI controls (React component)
  mapConfig.ts      Map style, sources, terrain & camera config
  index.css         Styles
vite.config.ts      Vite config (port 5173, strict)
Makefile            start / stop / restart / logs helpers
```

## Controls

- **Drag** to pan.
- **Right-drag** (or two-finger drag) to tilt and rotate.
- **Scroll** to zoom.
- Use the **Terrain exaggeration** slider to amplify relief.
- **Fly to canyon overlook** resets to the dramatic default view.

## Data sources

- Elevation: Mapzen / [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
- Imagery: Esri World Imagery (Maxar, Earthstar Geographics)
