---
name: documents
description: Create, read, edit, and verify PDFs, scanned documents, PowerPoint, Word, and spreadsheet files.
---

The Sixb agent image has ReportLab, pypdf, pdfplumber, python-pptx, python-docx, openpyxl, pandas,
PyArrow, NumPy, matplotlib, Pillow, PptxGenJS, LibreOffice, Poppler, Pandoc, qpdf, and
DejaVu/Liberation/Noto fonts.

Use `python3` for Python scripts. For JavaScript slide authoring, use a `.cjs` script with
`const pptxgen = require("/opt/sixb/js/node_modules/pptxgenjs")`; this works from any workspace.
Use the user's source facts, formatting, and template. Keep requested charts and tables editable.
Preserve distinctions such as proposed versus approved costs and response versus completion times.

For digital PDF tables, use pdfplumber and verify extracted rows and totals against the source.
For scans, use pdf2image or pdftoppm followed by pytesseract/Tesseract; English OCR data is installed.
OCR output can misread numbers and punctuation. Check source page images before using uncertain
values. pypdf and pdfplumber alone do not OCR image-only pages.

Pandoc can read DOCX as Markdown or create DOCX from Markdown. For PDF output, render the generated
DOCX with sixb-render; this image does not include a TeX engine. qpdf --check checks PDF structure,
not visual layout. Use pandas/PyArrow for Parquet data; keep source units and null values intact.

After authoring, run:

```bash
sixb-render draft.pptx --output-dir previews-1
```

The helper accepts PDF, PPTX, DOCX, and XLSX. It creates a PDF, page PNGs, and a JSON manifest.
Always use a new output directory after revisions. Rendering has a 30-page default limit; use
`--first-page` and `--last-page` for larger documents and inspect every required page across batches.
The manifest's `complete` field says whether previews cover the entire document.

Inspect the PNG paths with `view_file` when image input is supported. Check clipping, overlap,
contrast, fonts, chart labels, and units. Repair and render again when needed. Text extraction alone
does not verify layout. A model without image input can check text/structure but must not claim
visual inspection. LibreOffice is a compatibility check; it does not prove exact PowerPoint layout.

For spreadsheets, inspect formulas and values separately from printed-page previews. openpyxl does
not calculate formulas. Use LibreOffice on a copy when recalculation is needed and verify the result.

Create previews inside the workspace so `view_file` can read them. Keep source scripts when another
turn may need to edit the document. Publish only the requested formats using the worker's output
instructions; preview PNGs and validation logs are working files unless the user requests them.
