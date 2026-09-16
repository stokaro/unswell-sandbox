# Construction regression source

`ptah-database-urls.md` is the unmodified source of the page reported in
stokaro/unswell#294. It is a development example, not a labeled quality benchmark.
The other construction probes are declared inline in `test/frames.mjs`.

- Source: stokaro/ptah at `1392b732b0f7c85b0d35b907d96b8f5eba749ac0`.
- Path: `docs/site/src/content/docs/concepts/database-urls-and-dev-databases.md`.
- SHA-256: `9fff3f89117111fbd829bf0c6f99befdf84d6f5b320f885cc12c1a0793ed2c64`.
- License: MIT, copyright 2025, 2026 Denis Voytyuk; see `PTAH-LICENSE`.

`ptah-rhetoric.json` is the core engine's `e2e/rhetoricdata/ptah.json` at the
commit recorded in `third_party/unswell.pin`. Its 21 exact excerpts are from Ptah
`654eae5591392278e6c8bce8e54737f780766f19`; each retains its source-file hash,
byte range, and excerpt hash. Nine proposed revisions and twelve technical
controls accompany the original expected clause ranges. The same MIT notice
applies. These are assistant-authored development judgments, not independent
human labels. `test/ptah-rhetoric.mjs` checks them through the WASM host, including
the editing guidance and score contribution shown by the page.
