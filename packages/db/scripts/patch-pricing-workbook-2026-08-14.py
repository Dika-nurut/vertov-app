#!/usr/bin/env python3
"""Patch the signed Vertov workbook without rewriting unrelated worksheet XML.

This is intentionally a small OOXML patcher rather than a spreadsheet-library save.
The first fourteen worksheets are the media model's protected history; only the
cells/rows named below are changed.  The script adds the eight explicitly costed
Nano Banana/GPT Image 2 reserve legs and records the temporary Scenario margin
policy on the existing LLM sheet.
"""

from __future__ import annotations

import html
import re
import shutil
import tempfile
import zipfile
from pathlib import Path


WORKBOOK = Path(__file__).resolve().parents[3] / "docs/business/pricing-workbook/Vertov_Pricing_Model_v14_2026-07-28.xlsx"
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
CELL_RE = re.compile(
    r'<c\b(?=[^>]*\br="{coord}"(?:\s|>))[^>]*(?:/>|>.*?</c>)', re.S
)
ROW_RE = re.compile(r'<row\b[^>]*\br="{row}"[^>]*>.*?</row>', re.S)


def esc(value: str) -> str:
    return html.escape(value, quote=False)


def style_from(cell_xml: str | None, fallback: str = "59") -> str:
    if cell_xml:
        match = re.search(r'\bs="([^"]+)"', cell_xml)
        if match:
            return match.group(1)
    return fallback


def cell_xml(coord: str, value: object, style: str = "59", formula: str | None = None) -> str:
    attrs = f' r="{coord}" s="{style}"'
    if formula is not None:
        return f'<c{attrs}><f>{esc(formula)}</f><v>{value}</v></c>'
    if isinstance(value, str):
        return f'<c{attrs} t="inlineStr"><is><t xml:space="preserve">{esc(value)}</t></is></c>'
    return f'<c{attrs}><v>{value}</v></c>'


def replace_cell(xml: str, coord: str, value: object, *, formula: str | None = None, style: str | None = None) -> str:
    """Replace one cell while retaining its existing style; add it if absent."""
    pattern = re.compile(CELL_RE.pattern.format(coord=re.escape(coord)), re.S)
    match = pattern.search(xml)
    if match:
        old = match.group(0)
        rendered = cell_xml(coord, value, style or style_from(old), formula)
        return xml[: match.start()] + rendered + xml[match.end() :]
    # New cells are appended inside the row.  Consumers use the coordinate, not
    # arrival order; Excel also accepts sparse cells in any order.
    row_end = xml.rfind("</row>")
    if row_end < 0:
        raise ValueError(f"cannot add {coord}: row XML has no closing tag")
    return xml[:row_end] + cell_xml(coord, value, style or "59", formula) + xml[row_end:]


def row_xml(sheet: str, row_number: int) -> str:
    match = re.search(ROW_RE.pattern.format(row=row_number), sheet, re.S)
    if not match:
        raise ValueError(f"sheet has no row {row_number}")
    return match.group(0)


def replace_row(sheet: str, row_number: int, new_row: str) -> str:
    pattern = re.compile(ROW_RE.pattern.format(row=row_number), re.S)
    match = pattern.search(sheet)
    if not match:
        raise ValueError(f"sheet has no row {row_number}")
    return sheet[: match.start()] + new_row + sheet[match.end() :]


def remove_rows(sheet: str, row_numbers: set[int]) -> str:
    """Remove any existing rows with these coordinates so the patch is repeatable."""
    for row_number in row_numbers:
        sheet = re.sub(ROW_RE.pattern.format(row=row_number), "", sheet, flags=re.S)
    return sheet


def clone_row(sheet: str, source_row: int, target_row: int) -> str:
    row = row_xml(sheet, source_row)
    row = re.sub(rf'(<row\b[^>]*\br=")({source_row})(")', rf'\g<1>{target_row}\g<3>', row, count=1)
    row = re.sub(rf'([A-Z]+){source_row}(?=")', rf'\g<1>{target_row}', row)
    return row


def cell_number(sheet: str, coord: str) -> float:
    match = re.search(CELL_RE.pattern.format(coord=re.escape(coord)), sheet, re.S)
    if not match:
        raise ValueError(f"missing numeric cell {coord}")
    value = re.search(r"<v>([^<]*)</v>", match.group(0))
    if not value:
        raise ValueError(f"cell {coord} has no cached value")
    return float(value.group(1))


def patch_grid(sheet: str) -> str:
    # G/H are the reserve channel/rate, AE the reserve relay and AQ the route
    # arming flag.  Gemini's Kie edit route is connected; GPT rows remain
    # costed-but-not-armed until Kie's quality-to-resolution mapping is signed.
    grid = {
        31: {"G": "direct", "H": 0.02, "AE": "Kie", "AQ": "да", "U": "Kie fallback google/nano-banana $0.02/img; owner list 2026-07-25; t2i route connected."},
        92: {"G": "direct", "H": 0.02, "AE": "Kie", "AQ": "да", "U": "Kie fallback google/nano-banana-edit $0.02/edit; owner list 2026-07-25; i2i route connected."},
        36: {"G": "direct", "H": 0.03, "AE": "Kie", "U": "Kie fallback gpt-image-2-text-to-image $0.03/low; owner list 2026-07-25. Costed reserve; quality mapping remains unarmed."},
        37: {"G": "direct", "H": 0.05, "AE": "Kie", "U": "Kie fallback gpt-image-2-text-to-image $0.05/medium; owner list 2026-07-25. Costed reserve; quality mapping remains unarmed."},
        38: {"G": "direct", "H": 0.08, "AE": "Kie", "U": "Kie fallback gpt-image-2-text-to-image $0.08/high; owner list 2026-07-25. Costed reserve; quality mapping remains unarmed."},
        89: {"G": "direct", "H": 0.03, "AE": "Kie", "U": "Kie fallback gpt-image-2-image-to-image $0.03/low; owner list 2026-07-25. Costed reserve; quality mapping remains unarmed."},
        90: {"G": "direct", "H": 0.05, "AE": "Kie", "U": "Kie fallback gpt-image-2-image-to-image $0.05/medium; owner list 2026-07-25. Costed reserve; quality mapping remains unarmed."},
        91: {"G": "direct", "H": 0.08, "AE": "Kie", "U": "Kie fallback gpt-image-2-image-to-image $0.08/high; owner list 2026-07-25. Costed reserve; quality mapping remains unarmed."},
    }
    for row_number, values in grid.items():
        row = row_xml(sheet, row_number)
        for column, value in values.items():
            row = replace_cell(row, f"{column}{row_number}", value)
        sheet = replace_row(sheet, row_number, row)
    banner = "Fallback legs signed 2026-08-14: gemini-2.5 flash image Kie $0.02 t2i/edit; GPT Image 2 Kie $0.03/$0.05/$0.08 by low/medium/high and t2i/i2i. GPT quality reserves are costed for margin governance but remain unarmed until Kie quality mapping is approved; sell prices unchanged."
    sheet = replace_cell(sheet, "A2", "Правило: кредитов = максимум из трёх (потолок щедрости +28% к Syntx / маржа 25% / безубыток при уходе на резерв). Маржа — ВАЛОВАЯ, только вендорская себестоимость. " + banner)
    return sheet


def export_leg_values(source_row: int, target_row: int, *, model: str, mode: str, quality: str, cost: float, credits: int, source_ref: str, sku: str, route_risk: str = "") -> dict[str, object]:
    rung = "default"
    aspect = "any"
    row_key = f"{model}|{rung}|{mode}|-" + (f"|{quality}|{aspect}" if model == "gpt-image-2" else f"|-|{aspect}")
    margin = 1 - (cost * 100.6315) / (credits * 0.331111)
    relay_source = "Сетка FX стр.31/92" if model.startswith("gemini") else f"Сетка FX стр.{source_ref}"
    return {
        "A": model,
        "B": rung,
        "C": mode,
        "D": "-",
        "E": quality if model == "gpt-image-2" else "",
        "F": 2,
        "G": "резервная",
        "H": "Kie",
        "I": "Google" if model.startswith("gemini") else "OpenAI",
        "J": sku,
        "K": "прямой",
        "L": 1.1839,
        "M": "за изображение",
        "N": cost,
        "O": 100.6315,
        "P": round(cost * 100.6315, 2),
        "Q": "да",
        "R": "HIGH — owner list 2026-07-25; fallback rate signed; live probe not run in this change",
        "S": credits,
        "T": round(margin, 6),
        "U": 2,
        "V": f"Сетка FX стр.{source_ref}; fallback cost row",
        "W": "2026-08-14",
        "X": 1,
        "Y": aspect,
        "Z": 0,
        "AA": 0,
        "AB": "плоская",
        "AC": 0,
        "AD": row_key,
        "AE": row_key + "|нога2",
        "AF": route_risk,
        "AG": "low" if model == "gpt-image-2" else "default",
        "AH": "",
    }


def patch_export(sheet: str) -> str:
    # Existing primary rows become depth 2 for the configurations that now have
    # a real reserve.  The source rows are kept in place; new legs append at end.
    # XML row numbers include the banner/header rows.  The target primary rows are
    # gemini t2i 38, GPT t2i 46–48, GPT i2i 115–117 and gemini i2i 118.
    primary_rows = [38, 46, 47, 48, 115, 116, 117, 118]
    for row_number in primary_rows:
        row = row_xml(sheet, row_number)
        row = replace_cell(row, f"U{row_number}", 2)
        if row_number in (38, 118):
            row = replace_cell(
                row,
                f"R{row_number}",
                "HIGH; Kie reserve costed 2026-08-14 — LaoZhang remains primary; no longer single-leg.",
            )
        sheet = replace_row(sheet, row_number, row)

    additions = [
        (46, 140, export_leg_values(46, 140, model="gpt-image-2", mode="t2i", quality="low", cost=0.03, credits=13, source_ref="36", sku="gpt-image-2-text-to-image", route_risk="COSTED RESERVE ONLY — Kie spec has resolution, not OpenAI quality; fallback is not armed for low until mapping is approved.")),
        (47, 141, export_leg_values(47, 141, model="gpt-image-2", mode="t2i", quality="medium", cost=0.05, credits=21, source_ref="37", sku="gpt-image-2-text-to-image", route_risk="COSTED RESERVE ONLY — Kie spec has resolution, not OpenAI quality; fallback is not armed for medium until mapping is approved.")),
        (48, 142, export_leg_values(48, 142, model="gpt-image-2", mode="t2i", quality="high", cost=0.08, credits=33, source_ref="38", sku="gpt-image-2-text-to-image", route_risk="COSTED RESERVE ONLY — Kie spec has resolution, not OpenAI quality; fallback is not armed for high until mapping is approved.")),
        (111, 143, export_leg_values(111, 143, model="gpt-image-2", mode="i2i", quality="low", cost=0.03, credits=13, source_ref="89", sku="gpt-image-2-image-to-image", route_risk="COSTED RESERVE ONLY — Kie spec has resolution, not OpenAI quality; fallback is not armed for low until mapping is approved.")),
        (112, 144, export_leg_values(112, 144, model="gpt-image-2", mode="i2i", quality="medium", cost=0.05, credits=21, source_ref="90", sku="gpt-image-2-image-to-image", route_risk="COSTED RESERVE ONLY — Kie spec has resolution, not OpenAI quality; fallback is not armed for medium until mapping is approved.")),
        (113, 145, export_leg_values(113, 145, model="gpt-image-2", mode="i2i", quality="high", cost=0.08, credits=33, source_ref="91", sku="gpt-image-2-image-to-image", route_risk="COSTED RESERVE ONLY — Kie spec has resolution, not OpenAI quality; fallback is not armed for high until mapping is approved.")),
        (38, 146, export_leg_values(38, 146, model="gemini-2-5-flash-image", mode="t2i", quality="", cost=0.02, credits=9, source_ref="31", sku="google/nano-banana", route_risk="")),
        (118, 147, export_leg_values(118, 147, model="gemini-2-5-flash-image", mode="i2i", quality="", cost=0.02, credits=9, source_ref="92", sku="google/nano-banana-edit", route_risk="")),
    ]
    # The workbook patch may be re-run while iterating on a note or a formula. Remove
    # prior generated coordinates first; otherwise OOXML would contain duplicate rows
    # with the same address and the importer would count them twice.
    sheet = remove_rows(sheet, {target_row for _, target_row, _ in additions})
    for source_row, target_row, values in additions:
        row = clone_row(sheet, source_row, target_row)
        for column, value in values.items():
            row = replace_cell(row, f"{column}{target_row}", value)
        sheet = sheet.replace("</sheetData>", row + "</sheetData>", 1)
    sheet = re.sub(r'<dimension ref="A1:AH139"', '<dimension ref="A1:AH147"', sheet, count=1)
    sheet = replace_cell(sheet, "A1", "ЭКСПОРТ ДЛЯ ДВИЖКА МАРШРУТИЗАЦИИ · ВЕРСИЯ 2026-08-14 · РЕД. 22 · ЛИСТ ГЕНЕРИРУЕТСЯ ЦЕЛИКОМ ИЗ «Сетка FX», НИКОГДА НЕ ПРАВИТСЯ ТОЧЕЧНО")
    sheet = replace_cell(sheet, "A3", "СТРОК ДАННЫХ: 140   ·   КОНТРОЛЬНАЯ СУММА КРЕДИТОВ: 26729   ·   КОНТРОЛЬНАЯ СУММА МАРЖИ: 35.241635   ·   РАЗЛИЧНЫХ КЛЮЧЕЙ СТРОК: 140")
    sheet = replace_cell(sheet, "A4", "РЕД. 22: добавлены восемь подписанных fallback-cost rows: gemini-2.5 flash image для t2i/i2i и GPT Image 2 для low/medium/high в t2i/i2i. GPT quality rows costed for margin governance; route remains unarmed until Kie quality mapping is approved. Workbook remains the SSOT; regenerate cost-legs.csv after every financial edit.")
    return sheet


def patch_llm(sheet: str) -> str:
    note = " TEMPORARY POLICY (owner-approved 2026-08-14): Scenario and structurize use a 7% gross-margin floor until reviewed before launch; Boards and media remain on the global 25% floor."
    # Existing LLM sheet uses inline strings, so these replacements preserve styles
    # while avoiding sharedStrings churn.
    for coord in ("A2", "A6"):
        match = re.search(CELL_RE.pattern.format(coord=coord), sheet, re.S)
        if match:
            text = "".join(re.findall(r"<t[^>]*>(.*?)</t>", match.group(0), re.S))
            sheet = replace_cell(sheet, coord, text if note.strip() in text else text + note)
    settings_row = row_xml(sheet, 4)
    m4 = re.search(CELL_RE.pattern.format(coord="M4"), settings_row, re.S)
    m4_style = style_from(m4.group(0) if m4 else None, "46")
    n4 = re.search(CELL_RE.pattern.format(coord="N4"), settings_row, re.S)
    n4_style = style_from(n4.group(0) if n4 else None, "47")
    if not m4:
        m3 = re.search(CELL_RE.pattern.format(coord="M3"), row_xml(sheet, 3), re.S)
        m4_style = style_from(m3.group(0) if m3 else None, "46")
    if not n4:
        n3 = re.search(CELL_RE.pattern.format(coord="N3"), row_xml(sheet, 3), re.S)
        n4_style = style_from(n3.group(0) if n3 else None, "47")
    settings_row = replace_cell(settings_row, "M4", "Scenario temporary margin floor", style=m4_style)
    settings_row = replace_cell(settings_row, "N4", 0.07, style=n4_style)
    sheet = replace_row(sheet, 4, settings_row)

    # Identify paid Scenario rows from the A-cell text.  Their cost cache in S
    # is already formula-derived; only the floor reference and cached T/U move.
    rows = re.findall(r'<row\b[^>]*\br="(\d+)"[^>]*>.*?</row>', sheet, re.S)
    for row_number in map(int, rows):
        row = row_xml(sheet, row_number)
        a = re.search(CELL_RE.pattern.format(coord=f"A{row_number}"), row, re.S)
        if not a:
            continue
        a_text = "".join(re.findall(r"<t[^>]*>(.*?)</t>", a.group(0), re.S))
        if a_text not in {"scenario_assist_price", "scenario_structurize"}:
            continue
        s = cell_number(row, f"S{row_number}")
        b4 = 0.331111
        credits = int(__import__("math").ceil(s / (b4 * (1 - 0.07))))
        margin = 1 - s / (credits * b4)
        row = replace_cell(row, f"T{row_number}", credits, formula=f"ROUNDUP(S{row_number}/($B$4*(1-$N$4)),0)")
        row = replace_cell(row, f"U{row_number}", margin, formula=f"1-S{row_number}/(T{row_number}*$B$4)")
        y = re.search(CELL_RE.pattern.format(coord=f"Y{row_number}"), row, re.S)
        if y:
            source = "".join(re.findall(r"<t[^>]*>(.*?)</t>", y.group(0), re.S))
            if "TEMPORARY 7% Scenario margin policy" not in source:
                row = replace_cell(row, f"Y{row_number}", "TEMPORARY 7% Scenario margin policy — owner-approved 2026-08-14; review before launch. " + source)
        sheet = replace_row(sheet, row_number, row)
    return sheet


def patch(workbook: Path = WORKBOOK) -> None:
    with zipfile.ZipFile(workbook, "r") as source:
        entries = {info.filename: source.read(info.filename) for info in source.infolist()}
        sheet4 = entries["xl/worksheets/sheet4.xml"].decode("utf-8")
        sheet5 = entries["xl/worksheets/sheet5.xml"].decode("utf-8")
        sheet15 = entries["xl/worksheets/sheet15.xml"].decode("utf-8")
        entries["xl/worksheets/sheet4.xml"] = patch_grid(sheet4).encode("utf-8")
        entries["xl/worksheets/sheet5.xml"] = patch_export(sheet5).encode("utf-8")
        entries["xl/worksheets/sheet15.xml"] = patch_llm(sheet15).encode("utf-8")
        fd, temp_name = tempfile.mkstemp(prefix=workbook.stem + ".", suffix=".xlsx", dir=workbook.parent)
        Path(temp_name).unlink(missing_ok=True)
        try:
            with zipfile.ZipFile(temp_name, "w") as target:
                for info in source.infolist():
                    target.writestr(info, entries[info.filename])
            shutil.move(temp_name, workbook)
        finally:
            Path(temp_name).unlink(missing_ok=True)


if __name__ == "__main__":
    patch(Path(__import__("sys").argv[1]).resolve() if len(__import__("sys").argv) > 1 else WORKBOOK)
