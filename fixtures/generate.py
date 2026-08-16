"""Generate the fixture corpus: ten Indian GST tax invoices with known truth.

The Gemini API is not reachable from the build sandbox, and arbitrary PDF
downloads are blocked, so the corpus is generated rather than collected. That
turns out to be the better test material anyway: ground truth is known exactly,
and the failure modes the validation layer exists to catch can be planted
deliberately instead of hoped for.

Five invoices are digital PDFs with a real text layer. Five are rendered to
image and re-wrapped as image-only PDFs, so they have no text layer at all and
must go through Tesseract. That mirrors the reported 1:1 split.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field as dc_field
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

HERE = Path(__file__).parent
PDF_DIR = HERE / "pdfs"

STATE_NAMES = {
    "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "19": "West Bengal",
    "24": "Gujarat", "27": "Maharashtra", "29": "Karnataka", "33": "Tamil Nadu",
    "36": "Telangana",
}


@dataclass
class Invoice:
    slug: str
    scanned: bool
    supplier_name: str
    supplier_gstin: str
    supplier_address: str
    recipient_name: str
    recipient_gstin: str
    invoice_number: str
    invoice_date: str          # ISO, as printed in DD/MM/YYYY on the page
    place_of_supply: str
    hsn: str
    description: str
    quantity: str
    unit_price: str
    taxable_value: str
    cgst: str
    sgst: str
    igst: str
    cess: str
    total: str
    note: str = ""
    # What the pipeline should conclude. Written to expected.json and asserted
    # by the integration tests.
    expect_route: str = "review"
    expect_codes: list[str] = dc_field(default_factory=list)
    omit_invoice_number: bool = False


INVOICES: list[Invoice] = [
    # --- digital text layer -------------------------------------------------
    Invoice(
        slug="01-clean-intra-state", scanned=False,
        supplier_name="Umbra Fabrication Pvt Ltd", supplier_gstin="27AAPFU0939F1ZV",
        supplier_address="Unit 4, Bhosari Industrial Estate, Pune 411026",
        recipient_name="Bhagwati Components Ltd", recipient_gstin="27AAGCB7383J1Z8",
        invoice_number="INV/2026/0042", invoice_date="2026-07-15",
        place_of_supply="27", hsn="998314",
        description="Precision machining services", quantity="1", unit_price="1000.00",
        taxable_value="1000.00", cgst="90.00", sgst="90.00", igst="0.00", cess="0.00",
        total="1180.00",
        expect_route="auto_approve", expect_codes=[],
    ),
    Invoice(
        slug="02-clean-inter-state", scanned=False,
        supplier_name="Bhagwati Components Ltd", supplier_gstin="29AAGCB7383J1Z4",
        supplier_address="Plot 19, Peenya Phase II, Bengaluru 560058",
        recipient_name="Sterling Traders", recipient_gstin="07AABCS1429B1ZW",
        invoice_number="BC-2026-0117", invoice_date="2026-06-02",
        place_of_supply="07", hsn="8483",
        description="Transmission shafts, 40mm", quantity="25", unit_price="1480.00",
        taxable_value="37000.00", cgst="0.00", sgst="0.00", igst="6660.00", cess="0.00",
        total="43660.00",
        expect_route="auto_approve", expect_codes=[],
    ),
    Invoice(
        slug="03-five-percent-slab", scanned=False,
        supplier_name="Nithya Foods & Spices", supplier_gstin="33AACCN2082N1ZD",
        supplier_address="12 Anna Salai, Chennai 600002",
        recipient_name="Coromandel Retail LLP", recipient_gstin="33AACCN2082N1ZD",
        invoice_number="NF/26-27/318", invoice_date="2026-05-21",
        place_of_supply="33", hsn="0904",
        description="Black pepper, whole, 50kg", quantity="50", unit_price="248.00",
        taxable_value="12400.00", cgst="310.00", sgst="310.00", igst="0.00", cess="0.00",
        total="13020.00",
        expect_route="auto_approve", expect_codes=[],
    ),
    Invoice(
        slug="04-invoice-number-too-long", scanned=False,
        supplier_name="Harsha Engineering Works", supplier_gstin="06AAACH0850J1ZU",
        supplier_address="Sector 34, Gurugram 122001",
        recipient_name="Trident Logistics", recipient_gstin="06AAACH0850J1ZU",
        invoice_number="HEW/GGN/2026-2027/000891", invoice_date="2026-04-30",
        place_of_supply="06", hsn="7318",
        description="Fasteners, assorted", quantity="500", unit_price="18.00",
        taxable_value="9000.00", cgst="810.00", sgst="810.00", igst="0.00", cess="0.00",
        total="10620.00",
        note="Invoice number exceeds the sixteen characters permitted by Rule 46(b).",
        expect_route="review", expect_codes=["INVOICE_NUMBER_TOO_LONG"],
    ),
    Invoice(
        slug="05-total-mismatch", scanned=False,
        supplier_name="Tarasoft Systems Pvt Ltd", supplier_gstin="19AABCT3518Q1ZT",
        supplier_address="Salt Lake Sector V, Kolkata 700091",
        recipient_name="Anand Retail Pvt Ltd", recipient_gstin="19AABCT3518Q1ZT",
        invoice_number="TS/2026/0771", invoice_date="2026-07-01",
        place_of_supply="19", hsn="998313",
        description="Software maintenance, quarterly", quantity="1", unit_price="60000.00",
        taxable_value="60000.00", cgst="5400.00", sgst="5400.00", igst="0.00", cess="0.00",
        total="71800.00",
        note="Printed total does not equal taxable value plus tax. Correct total is 70800.00.",
        expect_route="review", expect_codes=["TOTAL_MISMATCH"],
    ),

    # --- scanned, no text layer --------------------------------------------
    Invoice(
        slug="06-scan-clean-intra-state", scanned=True,
        supplier_name="Raghuram Industries", supplier_gstin="27AAACR5055K1Z7",
        supplier_address="MIDC Andheri, Mumbai 400093",
        recipient_name="Deccan Traders", recipient_gstin="27AAPFU0939F1ZV",
        invoice_number="RI-2026-0208", invoice_date="2026-06-18",
        place_of_supply="27", hsn="8544",
        description="Copper wire, 2.5 sq mm", quantity="200", unit_price="112.00",
        taxable_value="22400.00", cgst="2016.00", sgst="2016.00", igst="0.00", cess="0.00",
        total="26432.00",
        expect_route="review", expect_codes=[],
    ),
    Invoice(
        slug="07-scan-clean-inter-state", scanned=True,
        supplier_name="Bharath Ceramics Ltd", supplier_gstin="36AADCB2923M1ZM",
        supplier_address="Balanagar, Hyderabad 500037",
        recipient_name="Konkan Interiors", recipient_gstin="27AAGCB7383J1Z8",
        invoice_number="BCL/26/1442", invoice_date="2026-07-09",
        place_of_supply="27", hsn="6907",
        description="Vitrified floor tiles, 600x600", quantity="120", unit_price="465.00",
        taxable_value="55800.00", cgst="0.00", sgst="0.00", igst="10044.00", cess="0.00",
        total="65844.00",
        expect_route="review", expect_codes=[],
    ),
    Invoice(
        slug="08-scan-wrong-tax-head", scanned=True,
        supplier_name="Indus Chemicals Pvt Ltd", supplier_gstin="29AAACI1195H1ZI",
        supplier_address="Yeshwanthpur, Bengaluru 560022",
        recipient_name="Suvarna Labs", recipient_gstin="29AAGCB7383J1Z4",
        invoice_number="IC/2026/0654", invoice_date="2026-05-08",
        place_of_supply="29", hsn="2815",
        description="Sodium hydroxide flakes, 25kg", quantity="40", unit_price="2100.00",
        taxable_value="84000.00", cgst="0.00", sgst="0.00", igst="15120.00", cess="0.00",
        total="99120.00",
        note="Supplier and place of supply are both Karnataka, so this is an "
             "intra-state supply wrongly charged as IGST.",
        expect_route="review", expect_codes=["WRONG_TAX_HEAD"],
    ),
    Invoice(
        slug="09-scan-bad-gstin-checkdigit", scanned=True,
        supplier_name="Prakash Enterprises", supplier_gstin="08AAECP4653R1ZQ",
        supplier_address="Malviya Nagar, Jaipur 302017",
        recipient_name="Marwar Hardware", recipient_gstin="08AAECP4653R1ZP",
        invoice_number="PE/2026/0093", invoice_date="2026-04-12",
        place_of_supply="08", hsn="7326",
        description="Mild steel brackets", quantity="300", unit_price="76.00",
        taxable_value="22800.00", cgst="2052.00", sgst="2052.00", igst="0.00", cess="0.00",
        total="26904.00",
        note="Supplier GSTIN check character is Q where the mod-36 algorithm "
             "requires P. A single-character error, caught with certainty.",
        expect_route="review", expect_codes=["SUPPLIER_GSTIN_INVALID"],
    ),
    Invoice(
        slug="10-scan-no-invoice-number", scanned=True,
        supplier_name="Gokul Packaging", supplier_gstin="24AAACC1206D1ZM",
        supplier_address="GIDC Vatva, Ahmedabad 382445",
        recipient_name="Saurashtra Distributors", recipient_gstin="24AAACC1206D1ZM",
        invoice_number="", invoice_date="2026-06-25",
        place_of_supply="24", hsn="4819",
        description="Corrugated cartons, 5-ply", quantity="1000", unit_price="34.00",
        taxable_value="34000.00", cgst="3060.00", sgst="3060.00", igst="0.00", cess="0.00",
        total="40120.00",
        note="No invoice number at all. Rule 46(b) makes this not a tax invoice, "
             "so the pipeline must reject rather than queue it for review.",
        expect_route="reject", expect_codes=["MISSING_INVOICE_NUMBER"],
        omit_invoice_number=True,
    ),
]


def as_ddmmyyyy(iso: str) -> str:
    year, month, day = iso.split("-")
    return f"{day}/{month}/{year}"


def rupees(amount: str) -> str:
    """Indian digit grouping: 1,00,000.00 rather than 100,000.00."""
    whole, _, fraction = amount.partition(".")
    negative = whole.startswith("-")
    whole = whole.lstrip("-")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join([*groups, tail])
    return f"{'-' if negative else ''}{whole}.{fraction or '00'}"


def draw(inv: Invoice, path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=A4)
    width, height = A4
    y = height - 20 * mm

    c.setFont("Helvetica-Bold", 15)
    c.drawCentredString(width / 2, y, "TAX INVOICE")
    y -= 12 * mm

    c.setFont("Helvetica-Bold", 11)
    c.drawString(18 * mm, y, inv.supplier_name)
    y -= 5 * mm
    c.setFont("Helvetica", 9)
    c.drawString(18 * mm, y, inv.supplier_address)
    y -= 5 * mm
    c.drawString(18 * mm, y, f"GSTIN: {inv.supplier_gstin}")
    y -= 5 * mm
    state = STATE_NAMES.get(inv.supplier_gstin[:2], "")
    c.drawString(18 * mm, y, f"State: {state} ({inv.supplier_gstin[:2]})")

    top = height - 44 * mm
    c.setFont("Helvetica", 9)
    if not inv.omit_invoice_number:
        c.drawRightString(width - 18 * mm, top, f"Invoice No: {inv.invoice_number}")
    c.drawRightString(width - 18 * mm, top - 5 * mm, f"Date: {as_ddmmyyyy(inv.invoice_date)}")
    pos_state = STATE_NAMES.get(inv.place_of_supply, "")
    c.drawRightString(
        width - 18 * mm, top - 10 * mm,
        f"Place of Supply: {pos_state} ({inv.place_of_supply})",
    )

    y -= 14 * mm
    c.setFont("Helvetica-Bold", 9)
    c.drawString(18 * mm, y, "Bill To")
    y -= 5 * mm
    c.setFont("Helvetica", 9)
    c.drawString(18 * mm, y, inv.recipient_name)
    y -= 5 * mm
    c.drawString(18 * mm, y, f"GSTIN: {inv.recipient_gstin}")

    y -= 12 * mm
    c.setLineWidth(0.6)
    c.line(18 * mm, y, width - 18 * mm, y)
    y -= 5 * mm
    c.setFont("Helvetica-Bold", 9)
    for label, x in (("Description", 18), ("HSN/SAC", 105), ("Qty", 132),
                     ("Rate", 152), ("Amount", 178)):
        (c.drawRightString if label in ("Rate", "Amount") else c.drawString)(x * mm, y, label)
    y -= 3 * mm
    c.line(18 * mm, y, width - 18 * mm, y)

    y -= 6 * mm
    c.setFont("Helvetica", 9)
    c.drawString(18 * mm, y, inv.description)
    c.drawString(105 * mm, y, inv.hsn)
    c.drawString(132 * mm, y, inv.quantity)
    c.drawRightString(152 * mm, y, rupees(inv.unit_price))
    c.drawRightString(178 * mm, y, rupees(inv.taxable_value))

    y -= 6 * mm
    c.line(18 * mm, y, width - 18 * mm, y)

    rows = [("Taxable Value", inv.taxable_value)]
    if inv.cgst != "0.00":
        rows.append(("CGST", inv.cgst))
        rows.append(("SGST", inv.sgst))
    if inv.igst != "0.00":
        rows.append(("IGST", inv.igst))
    if inv.cess != "0.00":
        rows.append(("Cess", inv.cess))

    y -= 7 * mm
    c.setFont("Helvetica", 9)
    for label, amount in rows:
        c.drawRightString(152 * mm, y, label)
        c.drawRightString(178 * mm, y, f"Rs. {rupees(amount)}")
        y -= 5 * mm

    y -= 1 * mm
    c.setFont("Helvetica-Bold", 10)
    c.drawRightString(152 * mm, y, "Total")
    c.drawRightString(178 * mm, y, f"Rs. {rupees(inv.total)}")

    y -= 16 * mm
    c.setFont("Helvetica", 8)
    c.drawString(18 * mm, y, "Declaration: e-invoice not applicable; aggregate turnover")
    y -= 4 * mm
    c.drawString(18 * mm, y, "is below the notified threshold under Rule 48(4).")

    c.setFont("Helvetica", 8)
    c.drawRightString(width - 18 * mm, 28 * mm, f"For {inv.supplier_name}")
    c.drawRightString(width - 18 * mm, 18 * mm, "Authorised Signatory")

    c.showPage()
    c.save()


def rasterise(source: Path, target: Path) -> None:
    """Re-render as an image-only PDF, destroying the text layer.

    200 dpi with a light JPEG quality loss, which is what a real office scanner
    or a phone photograph of an invoice looks like to an OCR engine.
    """
    subprocess.run(
        ["pdftoppm", "-jpeg", "-r", "200", "-jpegopt", "quality=72",
         str(source), str(target.with_suffix(""))],
        check=True,
    )
    page = target.with_name(f"{target.stem}-1.jpg")
    subprocess.run(
        ["img2pdf", str(page), "-o", str(target)],
        check=True,
    )
    page.unlink()


def main() -> None:
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []

    for inv in INVOICES:
        target = PDF_DIR / f"{inv.slug}.pdf"
        if inv.scanned:
            temporary = PDF_DIR / f"{inv.slug}.digital.pdf"
            draw(inv, temporary)
            rasterise(temporary, target)
            temporary.unlink()
        else:
            draw(inv, target)

        manifest.append({
            "slug": inv.slug,
            "file": f"pdfs/{inv.slug}.pdf",
            "scanned": inv.scanned,
            "note": inv.note,
            "expect": {"route": inv.expect_route, "codes": inv.expect_codes},
            "truth": {
                "supplierGstin": inv.supplier_gstin,
                "recipientGstin": inv.recipient_gstin,
                "invoiceNumber": None if inv.omit_invoice_number else inv.invoice_number,
                "invoiceDate": inv.invoice_date,
                "placeOfSupplyStateCode": inv.place_of_supply,
                "taxableValue": inv.taxable_value,
                "cgstAmount": inv.cgst,
                "sgstAmount": inv.sgst,
                "igstAmount": inv.igst,
                "cessAmount": inv.cess,
                "totalValue": inv.total,
                "hsn": inv.hsn,
            },
        })

    (HERE / "expected.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(manifest)} invoices to {PDF_DIR}")


if __name__ == "__main__":
    main()
