from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font

import argparse

parser = argparse.ArgumentParser(description="Generate synthetic inputs for the issue 9 import test.")
parser.add_argument("output", type=Path, help="new or empty fixture directory")
out = parser.parse_args().output
out.mkdir(parents=True, exist_ok=True)
if any(out.iterdir()):
    parser.error("choose a new or empty fixture directory")
workbook = Workbook()
sheet = workbook.active
sheet.title = "IS"
sheet.append(["company: ACME"])
sheet.append(["consolidated RMB mn"])
sheet.append(["Metric", "2023A", "2024A", "2025E", "2024", "2027A"])
sheet.append(["revenue", 90, 100, 130, 100, 200])
sheet.append(["ebitda", 18, "=C4/5", 26, 20, 40])
sheet.append(["WACC", 0.09, 0.1, 0.1, 0.1, 0.1])
sheet.append(["target price", 8, 12, 13, 10, 10])
sheet.append(["scenario switch", 1, 1, 1, 1, 1])
sheet.append(["net_profit", 15, 20, 21, 20, 25])
sheet["C4"].font = Font(bold=True)
sheet.freeze_panes = "B4"
workbook.save(out / "model.xlsx")

def disclosure(name, amount):
    lines = [
        "Fixture ACME annual results for FY 2024",
        "company: ACME",
        "scope: consolidated",
        "period: 2024A",
        "unit: RMB million",
        "currency: RMB",
        "basis: actual",
        f"revenue: {amount}",
        "ebitda: 20",
        "Publication date: 2025-03-31",
    ]
    commands = ["BT", "/F1 12 Tf", "50 740 Td", "18 TL"]
    for line in lines:
        commands.extend([f"({line}) Tj", "T*"])
    stream = ("\n".join([*commands, "ET"]) + "\n").encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"endstream",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for num, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{num} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for at in offsets[1:]:
        pdf.extend(f"{at:010d} 00000 n \n".encode())
    pdf.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    (out / name).write_bytes(pdf)

disclosure("disclosure.pdf", 120)
disclosure("conflicting-disclosure.pdf", 122)
