# Workflow canvas experiment

Throwaway local prototypes. No ranking.

## Versions

React / React DOM 19.3.0; Vite 8.3.5; plugin-react 6.1.2. Excalidraw 0.18.1; React Flow 12.12.0; roughjs 4.6.6; tldraw 5.6.0. See app lockfiles.

## Bundle bytes

Each cell is raw / gzip / Brotli bytes, summed per emitted file. Lazy means all non-entry JS, including optional secondary imports, not the initial navigation transfer. Compression uses Node defaults.

| Library | Total JS | Lazy JS | CSS | Fonts | Other |

|---|---:|---:|---:|---:|---:|

| excalidraw | 7766007 / 2551120 / 2142565 | 7541847 / 2481280 / 2082470 | 142637 / 22724 / 18726 | 81144 / 81251 / 81100 | 0 / 0 / 0 |

| reactflow | 432970 / 136635 / 118109 | 208320 / 66563 / 57771 | 16030 / 2918 / 2483 | 0 / 0 / 0 | 0 / 0 / 0 |

| tldraw | 2013643 / 598911 / 486418 | 1789117 / 528916 / 426181 | 78092 / 14843 / 12808 | 0 / 0 / 0 | 0 / 0 / 0 |

Rerun `node measure.mjs` from this folder. This is artifact size, not loading speed.

## Times and installs

### excalidraw

Install: `1.45user 1.32system 0:03.00elapsed 92%CPU (0avgtext+0avgdata 252144maxresident)k`

Build wrapper including lock wait: `0.00user 0.00system 0:07.53elapsed 0%CPU (0avgtext+0avgdata 7748maxresident)k`

### reactflow

Install: `0.10user 0.09system 0:00.53elapsed 37%CPU (0avgtext+0avgdata 61132maxresident)k`

Build wrapper including lock wait: `0.00user 0.00system 0:01.68elapsed 0%CPU (0avgtext+0avgdata 7588maxresident)k`

### tldraw

Install: `0.63user 0.75system 0:02.41elapsed 57%CPU (0avgtext+0avgdata 240108maxresident)k`

Build wrapper including lock wait: `0.00user 0.00system 0:00.99elapsed 0%CPU (0avgtext+0avgdata 7500maxresident)k`

All builds used heavy.sh serially. Build logs show actual Vite build time; wrapper times include the load gate. Excalidraw reported peer warnings; other initial installs did not. Exact warnings remain in install.log.

## License evidence

React Flow package.json says MIT; installed LICENSE is MIT, copyright webkid GmbH. Excalidraw package.json says MIT but its published package contains no LICENSE file. This missing package artifact is a verification gap. Primary repository: https://github.com/excalidraw/excalidraw/blob/master/LICENSE .

tldraw package.json says `SEE LICENSE IN LICENSE.md`. Installed LICENSE.md says: "This code is licensed under the [tldraw license](https://github.com/tldraw/tldraw/blob/main/LICENSE.md)".

https://tldraw.dev/community/license states: "The tldraw SDK will not work in production without a valid license key." https://tldraw.dev/pricing advertises a 100-day trial and commercial production licensing.

Installed @tldraw/editor source: LicenseManager.ts takes `licenseKey`, parses and validates its signature and domain, distinguishes local development hosts from deployment, and returns `unlicensed-production` for missing/invalid production licensing. LicenseProvider.tsx determines the blocked state. Localhost production bundles still qualify as development hosts; therefore these screenshots do not prove behavior on a public production hostname.

## Implementation and limits

### Excalidraw

1. Native rectangles, bound labels, arrows and kind colors. Native hand-drawn style.

2. Native move/add/arrow/delete tools. `startBinding` and `endBinding` map to graph endpoints. Unbound arrows produce validation errors. Native new boxes have unknown kind until metadata is assigned; no metadata editing UI was added.

3. Converter uses `regenerateIds:false` for stable roundtrips. Startup panel compares canonical graphs ignoring positions.

4. Bot patch reuses stored node positions. Scene replacement does not preserve selection or history.

5. viewModeEnabled and scrollToContent fit the scene. exportToSvg works; export is regenerated when the graph changes.

6. Native sketch rendering.

### React Flow

1. Custom nodes show kind and label with kind colors.

2. Handles connect IDs; controlled node/edge changes derive the strict JSON. Add agent button and native selection/delete.

3. Pure adapter roundtrip is checked at startup.

4. Bot patch preserves existing positions.

5. Native fitView and disabled editing flags. No built-in SVG exporter; would need node SVG serialization, paths, viewport transforms, and font embedding.

6. roughjs renders node rectangles. Edges now use a roughjs path along the computed Bezier.

### tldraw

1. Native geo boxes, rich text and arrows; kinds stored in shape metadata.

2. Arrow bindings are separate store records with terminal and target ID. Unbound arrows and unknown kinds are rejected by graph validation. Native created boxes lack workflow metadata.

3. Startup graph roundtrip ignores positions. Arrow rich text preserves optional labels; the sample includes "on conflict".

4. Bot patch recreates shapes while keeping graph positions.

5. isReadonly and zoomToFit. getSvgString is wired to user document changes; initial export is not proactively requested.

6. Native draw font and sketch shapes.

## Round 2 verification

Builds ran serially through heavy.sh. Run `node measure.mjs` from this directory and `node capture.mjs` from reactflow/. Playwright is installed in that app. The capture script records actual gestures, JSON checks, errors and runtime requests in evidence.json. It closes pages and terminates only its captured preview child processes. No commit or push was made.

React Flow preserves measured node state across canvas-originated JSON updates, has an explicit canvas height, roughjs edge paths, and fits external patches. The shared patch shifts gate/output one column right while preserving other existing positions. Excalidraw uses real arrow points and explicit bindings, fits content, and regenerates SVG on graph changes. tldraw arrows now preserve rich-text labels. The sample contains an "on conflict" edge.

Native newly drawn rectangles still have unknown workflow kind. Assigning metadata is outside this prototype UI. Native tool automation for creating and binding arrows is incomplete; human rectangle and arrow tools are available, but their complete editing path has not been verified here. A failed scripted check is not evidence that a human cannot perform it.

Screenshots: `shots/<library>-desktop.png`, `shots/<library>-patch.png`, `shots/<library>-readonly.png` and `shots/<library>-edited.png` for excalidraw, reactflow and tldraw. Edited captures show the final attempted gesture, including validation errors.

CDN requests are recorded per library in evidence.json. Excalidraw font assets can be self-hosted using `window.EXCALIDRAW_ASSET_PATH`; tldraw assets can be overridden with the `assetUrls` prop. These options were verified in installed source; self-hosting was not configured or tested. React Flow has no runtime CDN dependency observed in these captures. Bundle totals exclude runtime CDN traffic.

| Library    | a drag | b bound edge | c delete | d unbound error                      |
| ---------- | ------ | ------------ | -------- | ------------------------------------ |
| excalidraw | FAIL   | FAIL         | FAIL     | PASS                                 |
| reactflow  | PASS   | PASS         | FAIL     | PASS (dangling edge unrepresentable) |
| tldraw     | PASS   | FAIL         | FAIL     | PASS                                 |

### excalidraw observed results

- a: TimeoutError: locator.boundingBox: Timeout 2000ms exceeded.

- b: Error: Rectangle tool attempted; native canvas binding hit targets not calibrated. Human arrow tool remains available.
- c: Error: Blocked: step b produced no bound edge
- d: PASS

Page errors: []

External request hosts: esm.sh

### reactflow observed results

Round 3: rough edges use BaseEdge with a 24px interaction path; the visible rough path ignores pointer events. Free sticky notes have no handles and serialize separately in annotations.

- a: PASS
- b: PASS
- c: FAIL: Error: Delete did not remove edge
- d: PASS
- e: PASS

The d assertion checks unchanged edge count and Graph valid: dangling edge unrepresentable. The e assertion checks unchanged strict nodes/edges and annotation preservation through JSON scene roundtrip. Screenshots reactflow-edited.png and reactflow-patch.png were recaptured.

Page errors: []

### tldraw observed results

- a: PASS
- b: Error: Rectangle tool attempted; native canvas binding hit targets not calibrated. Human arrow tool remains available.
- c: Error: Blocked: step b produced no bound edge
- d: PASS

Page errors: []

External request hosts: , cdn.tldraw.com
