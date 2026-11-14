# PayProof public site

This directory is the static GitHub Pages site. Publish the repository's `master` branch from `/docs`. `.nojekyll` keeps the HTML, CSS, screenshots, and video files intact.

`index.html` explains the public problem, the permission workflow, and the product's use through six screenshots. The walkthrough uses synthetic companies and invoice data. The CAFC source links to its May 13, 2026 release; CAD 3.5 million is the reported recovery in one Quebec case, not construction-sector loss.

`slides/` contains the six-slide pitch and four muted recordings. Right advances, left goes back, and down restarts the current slide. A clip holds its final frame for four seconds before looping. It never automatically advances to another slide. The small PayProof link returns to the site.

All assets are relative to this directory, so the site works under a project path such as `/ts-payproof/`. No model key, database connection, or live application server is used by this site. The live application and local setup instructions are in the repository root.

## Preview

Serve this directory using any static HTTP server. Open `index.html` through that server, then follow the pitch link. Check desktop and narrow layouts, screenshot links, and slide playback before publishing.

## Validation

Run the repository's standard check:

```sh
nix develop --command vp run check
```

The public screenshots and video clips are captures of PayProof's synthetic demo workflow. The slides render through WebGPU where available and use Canvas2D when an adapter is unavailable. Both use local media only. No music is included in these pitch clips.
