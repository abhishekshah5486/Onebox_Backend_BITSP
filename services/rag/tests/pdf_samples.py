"""PDFs drawn with reportlab for the pdfplumber engine's tests."""

import io

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

WIDTH, HEIGHT = A4
LOREM = (
    "Refunds are issued to the original payment method within thirty days of the return "
    "arriving at our warehouse, once the item has been inspected."
)


def _wrap(pdf: canvas.Canvas, text: str, x: float, y: float, width: float, size: int = 10) -> float:
    pdf.setFont("Helvetica", size)
    line = ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if pdf.stringWidth(trial, "Helvetica", size) > width:
            pdf.drawString(x, y, line)
            y -= size * 1.3
            line = word
        else:
            line = trial
    if line:
        pdf.drawString(x, y, line)
        y -= size * 1.3
    return y


def _png() -> ImageReader:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (300, 200), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 120, 80, 190), fill="navy")
    draw.rectangle((120, 60, 180, 190), fill="teal")
    draw.rectangle((220, 20, 280, 190), fill="orange")
    return ImageReader(image)


def handbook() -> bytes:
    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=A4)
    for page in range(1, 6):
        pdf.setFont("Helvetica", 8)
        pdf.drawString(50, HEIGHT - 30, "Acme Returns Handbook")
        pdf.drawString(WIDTH / 2, 25, str(page))
        y = HEIGHT - 80
        if page == 1:
            pdf.setFont("Helvetica-Bold", 20)
            pdf.drawString(50, y, "Returns and refunds")
            y -= 34
            pdf.setFont("Helvetica-Bold", 14)
            pdf.drawString(50, y, "Eligibility")
            y = _wrap(pdf, LOREM, 50, y - 22, WIDTH - 100)
            pdf.setFont("Helvetica", 10)
            for bullet in ("Unworn items only", "Tags still attached", "Receipt or order number"):
                y -= 4
                pdf.drawString(60, y, f"• {bullet}")
                y -= 13
            y -= 10
            for n, step in enumerate(("Print the label", "Pack the item", "Drop it off"), 1):
                pdf.drawString(60, y, f"{n}. {step}")
                y -= 17
        elif page == 2:
            pdf.setFont("Helvetica-Bold", 14)
            pdf.drawString(50, y, "Plans")
            table = Table(
                [
                    ["Plan", "Return window", "Price"],
                    ["Basic", "14 days", "$0"],
                    ["Plus", "30 days", "$5"],
                    ["Pro", "60 days", "$12"],
                ],
                colWidths=[120, 120, 80],
            )
            table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.8, colors.black)]))
            _, h = table.wrapOn(pdf, WIDTH, HEIGHT)
            table.drawOn(pdf, 50, y - 20 - h)
            y -= 60 + h
            pdf.setFont("Helvetica-Bold", 14)
            pdf.drawString(50, y, "Shipping costs")
            y -= 24
            pdf.setFont("Helvetica", 10)
            for row in (
                ("Region", "Carrier", "Cost"),
                ("North", "Royal Mail", "4.50"),
                ("South", "DPD", "5.10"),
                ("Islands", "Parcelforce", "9.90"),
            ):
                for x, cell in zip((60, 220, 380), row, strict=True):
                    pdf.drawString(x, y, cell)
                y -= 16
        elif page == 3:
            pdf.drawImage(_png(), 50, y - 200, width=300, height=200)
            pdf.setFont("Helvetica", 9)
            pdf.drawString(50, y - 215, "Figure 1: Returns by quarter")
            _wrap(pdf, LOREM, 50, y - 245, WIDTH - 100)
        else:
            pdf.setFont("Helvetica-Bold", 14)
            pdf.drawString(50, y, "Policy details" if page == 4 else "More details")
            column = (WIDTH - 130) / 2
            left = right = y - 24
            for k in range(4):
                left = _wrap(pdf, f"Left {page}.{k}: {LOREM}", 50, left, column) - 8
                right = _wrap(pdf, f"Right {page}.{k}: {LOREM}", 80 + column, right, column) - 8
        pdf.showPage()
    pdf.save()
    return out.getvalue()


def grid_in_image() -> bytes:
    """A table whose rules are part of a background picture, with real text in its cells: no
    vector rules for pdfplumber, but OpenCV sees them on the raster."""
    from PIL import Image, ImageDraw

    cols, rows, cell_w, cell_h = 3, 4, 120, 24
    image = Image.new("RGB", (cols * cell_w + 1, rows * cell_h + 1), "white")
    draw = ImageDraw.Draw(image)
    for r in range(rows + 1):
        draw.line((0, r * cell_h, cols * cell_w, r * cell_h), fill="black", width=1)
    for c in range(cols + 1):
        draw.line((c * cell_w, 0, c * cell_w, rows * cell_h), fill="black", width=1)
    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=A4)
    x, top = 60, HEIGHT - 120
    pdf.drawImage(ImageReader(image), x, top - rows * cell_h, cols * cell_w, rows * cell_h)
    pdf.setFont("Helvetica", 10)
    cells = [
        ["Store", "City", "Opens"],
        ["Kings Cross", "London", "08:00"],
        ["Deansgate", "Manchester", "09:00"],
        ["Broad St", "Birmingham", "09:30"],
    ]
    for r, row in enumerate(cells):
        for c, text in enumerate(row):
            pdf.drawString(x + c * cell_w + 6, top - (r + 1) * cell_h + 8, text)
    pdf.showPage()
    pdf.save()
    return out.getvalue()


def scanned(pdf: bytes, dpi: int = 150) -> bytes:
    """`pdf` printed and scanned: every page only a picture, with no text layer."""
    import pypdfium2 as pdfium

    out = io.BytesIO()
    scan = canvas.Canvas(out, pagesize=A4)
    document = pdfium.PdfDocument(pdf)
    try:
        for page in document:
            image = page.render(scale=dpi / 72).to_pil().convert("L")
            scan.drawImage(ImageReader(image), 0, 0, WIDTH, HEIGHT)
            scan.showPage()
            page.close()
    finally:
        document.close()
    scan.save()
    return out.getvalue()


def text_in_picture() -> bytes:
    """A digital page with a screenshot-like picture whose words exist only as pixels."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (900, 260), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=40)
    draw.text((30, 40), "Order 4471 refunded", fill="black", font=font)
    draw.text((30, 140), "Amount 129.99 GBP", fill="black", font=font)
    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=A4)
    pdf.setFont("Helvetica", 11)
    pdf.drawString(50, HEIGHT - 80, "Support ticket summary with the payment screenshot below.")
    pdf.drawImage(ImageReader(image), 50, HEIGHT - 300, 450, 130)
    pdf.showPage()
    pdf.save()
    return out.getvalue()
