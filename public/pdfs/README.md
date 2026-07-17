# Self-hosted source PDFs (for clickable citations)

Citations in the assistant deep-link to the exact page of the source PDF using
`source_url#page=N`. Those PDFs are served from this folder by GitHub Pages, so
each answer's **Sources** list links straight to the passage it cited.

## Add the two PDFs here

Drop the two source PDFs in this folder with these **exact** filenames (they
must match the `source_url` values stored in the `documents` table):

| File | Document | Served at |
|---|---|---|
| `fundamentals-of-piano-practice.pdf` | *Fundamentals of Piano Practice* — Chuan C. Chang | `…/pdfs/fundamentals-of-piano-practice.pdf` |
| `hanon-virtuoso-pianist-pt1.pdf` | *The Virtuoso Pianist, Part I* — C. L. Hanon | `…/pdfs/hanon-virtuoso-pianist-pt1.pdf` |

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
