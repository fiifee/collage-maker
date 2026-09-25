# Photo Collage

A browser app for making a large, print-quality collage from lots of photos. It runs entirely on your Mac: nothing is uploaded, and there's nothing to install.

## Start

1. Download or clone this folder.
2. Double-click **`index.html`**. It opens in your default browser.
   - iPhone **HEIC** photos work in every browser. They are converted to high-quality JPEG when you add them.
   - **Chrome** also saves your work automatically as you go. In Safari, use **Save…** to keep your work (see below).

## Make a collage

1. **Add photos:** click **Add photos**, or drag photos (or a whole folder) from Finder into the window. They are laid out automatically to fill the page.
2. **Pick a layout:**
   - **Squares:** a clean grid. Use *Columns* and *Rows*, or click **Fit to photos**.
   - **Diamonds:** the grid turned 45°.
   - **Hexagons:** a honeycomb.
   - **Mixed:** a grid with some big tiles. Click **New arrangement** for a different pattern.
   - **Scattered:** photos tossed on a table, with optional Polaroid frames and shadows.
   - Squares, diamonds and hexagons can also be shaped like a **heart** or a **circle**.
3. **Arrange:**
   - **Reorder:** drag a tile onto another tile to swap them, or click **Shuffle**.
   - **Place a specific photo:** drag it from the tray at the bottom onto a tile.
   - **Crop:** double-click a tile, then drag the photo inside it. Pinch on the trackpad (or ⌘-scroll) to zoom, and press **Esc** when done. The right panel also has **Zoom**, **Rotate**, **Flip** and **Reset crop**.
   - **Scattered layout:** drag photos to move them, drag a corner to resize, and use the round handle to rotate (hold ⇧ to snap to 15°). ⌥-drag swaps two photos.
4. **Style:** set the gap between photos, rounded corners and the background colour.
5. **Paper:** choose the print size (A4–A0, common poster sizes, or a custom size), the orientation, the margin and the print resolution.
6. **Export image:** saves a JPEG (or PNG) at full print resolution to your Downloads folder. The DPI is written into the file, so print shops read the correct physical size.

## Print quality

Select a tile to see its **print quality** in the right panel. It shows how many dots per inch that photo will have in the final print. Around 150 dpi or more looks good. Lower values will look soft; give that photo a bigger tile or zoom it out. The export dialog also warns you if any photos are low resolution.

## Saving your work

- In Chrome, your collage is **saved automatically** in the browser.
- **Save…** writes a `.collage` file to Downloads. It contains all your original photos and the full layout. Use **Open…** (or drag the file into the window) to continue later, or on another Mac.
- **⌘Z / ⇧⌘Z** undo and redo.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| ⌘O | Add photos |
| ⌘S | Save project |
| ⌘E | Export image |
| ⌘Z / ⇧⌘Z | Undo / redo |
| Double-click / Enter | Crop the selected photo |
| Esc | Finish cropping / deselect |
| ⌫ | Remove the selected photo from its tile |
| R | Rotate the selected photo 90° |
| + / − / 0 | Zoom the view in / out / fit |
| Space + drag | Pan the view |

## Files

```
index.html        page and controls
css/styles.css    styling (follows the Mac's light/dark mode)
js/geometry.js    layout generators (squares, diamonds, hexagons, mixed, scatter, masks)
js/render.js      drawing, shared by the editor and the full-resolution export
js/storage.js     autosave (IndexedDB), .collage project files, DPI metadata
js/app.js         state, editing, undo, import/export
vendor/heic-to.js HEIC decoder (libheif, LGPL-3.0), loaded only when a HEIC photo is added
```
