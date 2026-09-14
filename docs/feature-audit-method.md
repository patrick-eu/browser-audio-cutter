# How the online audio cutter feature audit was made

File: [`data/online-audio-cutter-feature-audit-2026-09-14.csv`](../data/online-audio-cutter-feature-audit-2026-09-14.csv)

- **Query:** `audio cutter`, English results.
- **Date:** 2026-09-14.
- **Search entry:** google.com returned a CAPTCHA to the server running the audit, so the ranking was taken from Startpage (English), which serves Google results. The server was located in the Netherlands, so the order may differ from a US Google search.
- **What counts:** organic results only. Ads, videos and "People also ask" boxes were skipped.
- **How each cell was filled:** every page was opened in a headless Chromium browser and its text was read, including collapsed FAQ answers. A cell records only what that page states. Anything the page does not state is written as `Not stated`. Nothing was tested by uploading files, so options that appear only after an upload are not covered.
- **Replacement:** the original rank 10 (a Microsoft Store listing) showed only a cookie banner on two attempts, so the next organic result (rank 11) was used.
- **Contradictions:** when a page states two different values, both are recorded.

These are snapshots of third-party pages and will go out of date. Re-check a page before relying on a value.
