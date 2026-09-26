"""Exercise image capabilities with actual files and no external services."""

import functools
import http.server
import json
import subprocess
import threading
from pathlib import Path

import pandas as pd
import pdfplumber
import pytesseract
import requests
import yaml
from bs4 import BeautifulSoup
from defusedxml import ElementTree
from pdf2image import convert_from_path
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

from python_environment import check_python_environment


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise AssertionError(f"{args[0]}: {result.stderr or result.stdout}")
    return result.stdout.strip()


def check_extended(root):
    check_python_environment(root)
    checks = ["python-pip-alignment", "offline-package-install", "isolated-uv-environment"]

    table_path = root / "table.pdf"
    pdf = canvas.Canvas(str(table_path))
    table = Table([["Item", "USD"], ["Diagnosis", "350"], ["Part", "1600"], ["Labor", "500"]], colWidths=[200, 100], rowHeights=35)
    table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 1, "black")]))
    table.wrapOn(pdf, 300, 140)
    table.drawOn(pdf, 60, 600)
    pdf.save()
    with pdfplumber.open(table_path) as document:
        rows = document.pages[0].extract_table()
    assert rows == [["Item", "USD"], ["Diagnosis", "350"], ["Part", "1600"], ["Labor", "500"]]
    data = pd.DataFrame(rows[1:], columns=rows[0]).astype({"USD": "int64"})
    data.to_csv(root / "extracted.csv", index=False)
    data.to_parquet(root / "costs.parquet", index=False)
    assert pd.read_parquet(root / "costs.parquet")["USD"].sum() == 2450
    command("qpdf", "--check", str(table_path))
    checks += ["pdf-table-extraction", "parquet-roundtrip", "pdf-structure"]

    scanned = Image.new("RGB", (1500, 600), "white")
    draw = ImageDraw.Draw(scanned)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 65)
    draw.text((80, 100), "Invoice 12345\nTotal USD 2450", font=font, fill="black", spacing=30)
    scanned.save(root / "scanned-invoice.pdf", resolution=150)
    assert not PdfReader(root / "scanned-invoice.pdf").pages[0].extract_text().strip()
    page = convert_from_path(root / "scanned-invoice.pdf", dpi=150, first_page=1, last_page=1)[0]
    text = pytesseract.image_to_string(page, lang="eng", config="--psm 6", timeout=30)
    assert "12345" in text and "2450" in text, text
    (root / "ocr.txt").write_text(text)
    checks.append("scanned-pdf-ocr")

    markdown = root / "summary.md"
    markdown.write_text("# Service summary\n\nEstimated total: **2450 USD**. Approval pending.\n")
    command("pandoc", str(markdown), "-o", str(root / "summary.docx"))
    manifest = json.loads(command("sixb-render", str(root / "summary.docx"), "--output-dir", str(root / "summary-preview")))
    assert "2450" in PdfReader(manifest["pdf"]).pages[0].extract_text()
    checks.append("markdown-word-render")

    html = root / "page.html"
    html.write_text('''<!doctype html><html><head><meta charset="utf-8"><title>Sixb browser check</title>
<style>body{font:28px sans-serif;margin:60px}button{font:24px sans-serif;padding:12px}</style></head>
<body><h1>Service estimate</h1><p id="total">2450 USD</p>
<button onclick="document.querySelector('#state').textContent='Verified 2450'">Verify</button>
<p id="state">Pending</p></body></html>''')

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(root)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/page.html"
        with requests.Session() as session:
            session.trust_env = False
            response = session.get(url, timeout=10)
            response.raise_for_status()
        assert BeautifulSoup(response.text, "html.parser").select_one("#total").text == "2450 USD"
        browser_script = root / "browser.cjs"
        browser_script.write_text('''
const {chromium} = require("/opt/sixb/js/node_modules/playwright")
const path = require("node:path")
async function main() {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage({viewport:{width:1200,height:800}})
    page.setDefaultTimeout(15000)
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(process.argv[2], {waitUntil:"load"})
    await page.getByRole("button", {name:"Verify"}).click()
    if (await page.locator("#state").textContent() !== "Verified 2450") throw Error("Interaction failed")
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({path:path.join(process.argv[3],"browser.png")})
    await page.pdf({path:path.join(process.argv[3],"browser.pdf"),format:"A4",printBackground:true})
    if (errors.length) throw Error(errors.join("; "))
    console.log(browser.version())
  } finally { await browser.close() }
}
main().catch(error => {console.error(error);process.exitCode=1})
''')
        # Run like the worker's bash tool, with the image ENV cleared as on a provider that drops it.
        # Regression check: delete profile.sh from the image; Playwright then looks for its browser
        # under ~/.cache and this launch fails.
        browser_version = command(
            "env", "-i", f"HOME={Path.home()}", "bash", "-lc", 'node "$0" "$1" "$2"',
            str(browser_script), url, str(root),
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert "Verified 2450" in PdfReader(root / "browser.pdf").pages[0].extract_text()
    with Image.open(root / "browser.png") as preview:
        assert preview.size == (1200, 800) and preview.convert("L").getextrema()[0] < 200
    checks += ["http-html-parsing", "browser-interaction-screenshot-pdf"]

    test = root / "test_total.py"
    test.write_text("def test_total():\n    assert 350 + 1600 + 500 == 2450\n")
    command("pytest", "-q", str(test))
    command("ruff", "check", str(test))
    assert yaml.safe_load("total: 2450")["total"] == 2450
    assert ElementTree.fromstring("<total>2450</total>").text == "2450"
    checks += ["pytest", "ruff", "yaml-xml"]
    return {"checks": checks, "browserVersion": browser_version}
