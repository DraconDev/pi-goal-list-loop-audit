# Landscape store thumbnail — 2026-10-01

The Pi package-store screenshot supplied by the user shows the square GLLA
thumbnail cropped vertically inside an approximately 144 × 90 image box.

Updated the native SVG and both published PNG paths to 1600 × 1000 (8:5).
The complete loop/check mark sits beside a large GLLA wordmark, with safe
margins around both. The wordmark uses outlined glyphs for consistent rendering.
The existing package image URL is unchanged; this is a post-release artwork
update, with no runtime or package-version change.

## Verification

Rendered the SVG with resvg and visually inspected 640 × 400 and 144 × 90
previews. The full loop fits and the wordmark remains legible at store size.
Both PNG paths contain identical bytes and have the intended dimensions.

- `media/glla-icon.png`: 1600 × 1000; SHA-256 `0dd41b0bec981c067fb014774cf671ceb7d1c9992f270eabdefc7cd018887df6`.
- `media/glla-thumb.png`: 1600 × 1000; SHA-256 `0dd41b0bec981c067fb014774cf671ceb7d1c9992f270eabdefc7cd018887df6`.
