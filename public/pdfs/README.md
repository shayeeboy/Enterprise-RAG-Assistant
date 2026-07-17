# Self-hosted source PDFs (for clickable citations)

Citations in the assistant deep-link to the exact page of the source PDF using
`source_url#page=N`. Those PDFs are served from this folder by GitHub Pages, so
each answer's **Sources** list links straight to the passage it cited.

## Status

| File | Document | Status |
|---|---|---|
| `fundamentals-of-piano-practice.pdf` | *Fundamentals of Piano Practice* — Chuan C. Chang | ✅ **present & page-verified** — `#page=N` matches the ingested pages (offset 0, ~1.0 text overlap on sampled pages). Live. |
| *(not hosted)* | *The Virtuoso Pianist, Part I* — C. L. Hanon (public domain) | ➖ **Plain-text by design** — Hanon is mostly staff notation, which `pdftotext` can't read, so only ~21 pages of prose were ever ingested. Its `source_url` is `NULL`, so citations render as plain text (no deep-link). To enable it later, host the **exact 21-page file that was ingested** and re-run the alignment check before setting `source_url`. |

Filenames must be **lowercase `.pdf`** and match the `source_url` in `documents`
(GitHub Pages is case-sensitive).

## Attribution & license

- **_Fundamentals of Piano Practice_ — Chuan C. Chang.** Redistributed here under
  the author's own terms: *"Copyright © 2009. Copy permitted if author's name,
  Chuan C. Chang, and this copyright statement are included."* Official source:
  <http://www.pianopractice.org/>; this edition via
  [gmoe/piano_fundamentals](https://github.com/gmoe/piano_fundamentals) (Read the
  Docs). The hosted PDF retains the book's own copyright page.
- **_The Virtuoso Pianist, Part I_ — C. L. Hanon (1873).** Public domain.

## ⚠️ Use the EXACT files that were ingested

The stored page numbers come from `pdftotext`'s page indexing of the specific
PDFs that were parsed at ingestion time. `#page=N` only lands on the right page
if these files are **the same PDFs** (a re-generated or differently-paginated
copy will be off by the front-matter offset). If you must use a different copy,
re-verify a few citations against `data/parsed/*.json` before trusting the links.

## Notes

- The URL base is set in `scripts/05_index.js` (`PDF_BASE_URL`, default the Pages
  site) and stored per document as `documents.source_url`.
- `#page=` is honored by browsers' built-in PDF viewers (Chrome, Firefox, Edge,
  Safari, Adobe) for directly-served `application/pdf` — which GitHub Pages does.
- Until the PDFs are added, the Sources still render with title + page; the links
  just 404. Once the files are here and Pages redeploys, the links work.
