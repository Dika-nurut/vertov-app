#!/usr/bin/env python3
"""Append signed Scenario context-band rows to the existing LLM sheet.

The workbook is a protected OOXML package.  This patch changes only
``sheet15.xml`` (the LLM sheet), leaving every media worksheet byte-for-byte
untouched.  The legacy flat Scenario rows remain for replay/import compatibility;
new runtime pricing uses the explicit band rows below.
"""

from __future__ import annotations

import html
import math
import re
import shutil
import tempfile
import zipfile
from pathlib import Path


WORKBOOK = Path(__file__).resolve().parents[3] / "docs/business/pricing-workbook/Vertov_Pricing_Model_v14_2026-07-28.xlsx"
ACTIVE_CACHE_VALUES = {
    "cache_read_multiplier": 1.0,
    "cache_write_multiplier": 1.0,
    "cache_ttl": "none",
    "cache_min_prefix_tokens": 0,
    "cache_status": "unverified_disabled",
    "cache_evidence": "OWNER-GATED PROBE; 2026-08-15",
}
CELL_RE = re.compile(r'<c\b(?=[^>]*\br="{coord}"(?:\s|>))[^>]*(?:/>|>.*?</c>)', re.S)
ROW_RE = re.compile(r'<row\b[^>]*\br="{row}"[^>]*>.*?</row>', re.S)


def esc(value: str) -> str:
    return html.escape(value, quote=False)


def cell(coord: str, value: object, style: str = "59", formula: str | None = None) -> str:
    attrs = f' r="{coord}" s="{style}"'
    if formula is not None:
        return f'<c{attrs}><f>{esc(formula)}</f><v>{value}</v></c>'
    if isinstance(value, str):
        return f'<c{attrs} t="inlineStr"><is><t xml:space="preserve">{esc(value)}</t></is></c>'
    return f'<c{attrs}><v>{value}</v></c>'


def replace_cell(xml: str, coord: str, value: object, *, formula: str | None = None, style: str = "59") -> str:
    pattern = re.compile(CELL_RE.pattern.format(coord=re.escape(coord)), re.S)
    match = pattern.search(xml)
    rendered = cell(coord, value, style=style, formula=formula)
    if match:
        return xml[:match.start()] + rendered + xml[match.end():]
    end = xml.rfind("</row>")
    if end < 0:
        raise ValueError(f"row has no end while adding {coord}")
    return xml[:end] + rendered + xml[end:]


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
    return sheet[:match.start()] + new_row + sheet[match.end():]


def band_rows() -> list[dict[str, object]]:
    # These are UTF-8 byte envelopes, not provider token promises.  The API
    # measures the complete serialized prompt in bytes and selects the first
    # envelope that contains it.
    bands = {
        "project": [("8k", 8_000), ("16k", 16_000), ("24k", 24_000)],
        "span": [("8k", 8_000), ("16k", 16_000), ("22_4k", 22_400)],
        "scene": [("8k", 8_000), ("16k", 16_000), ("28k", 28_000)],
        "script": [("16k", 16_000), ("32k", 32_000), ("48k", 48_000), ("64k", 64_000), ("83_8k", 83_800)],
    }
    tiers = {
        "economy": ("qwen/qwen3.5-plus-02-15", "OpenRouter", "—", 0.26, 1.56, 0.0, 0.0, 2, 0),
        "standard": ("google/gemini-3-flash-preview", "Kie", "OpenRouter", 0.15, 0.9, 0.5, 3.0, 1, 2),
        "max": ("anthropic/claude-sonnet-5", "Kie", "OpenRouter", 0.85, 4.275, 2.0, 10.0, 1, 2),
    }
    outputs = {"project": 2_000, "span": 1_500, "scene": 2_000, "script": 2_500}
    rows: list[dict[str, object]] = []
    for tier, (model, primary, fallback, pi, po, fi, fo, pa, fa) in tiers.items():
        for scope, scope_bands in bands.items():
            for band_id, max_input in scope_bands:
                for conspect in (False, True):
                    rows.append({
                        "selector": f"{tier}/{scope}/{band_id}/{('conspect' if conspect else 'no-conspect')}",
                        "model": model, "primary": primary, "fallback": fallback,
                        "pi": pi, "po": po, "fi": fi, "fo": fo, "pa": pa, "fa": fa,
                        "max_input": max_input, "max_output": outputs[scope],
                        "typical_input": int(max_input * 0.6), "typical_output": int(outputs[scope] * 0.6),
                        "conspect": conspect, "scope": scope,
                    })
    return rows


def render_row(row_number: int, data: dict[str, object]) -> str:
    selector = str(data["selector"])
    # The formulas deliberately use the active 25% Scenario-band floor in Q4;
    # the legacy 7% rows above are not consulted by the runtime planner.
    conspect_cost = "IF(\"conspect\"=\"conspect\",$Q$3*($K$3*0.26+$N$3*1.56)/1000000,0)" if data["conspect"] else "0"
    primary = f"J{row_number}*(N{row_number}*F{row_number}+O{row_number}*G{row_number})/1000000"
    fallback = f"K{row_number}*(N{row_number}*H{row_number}+O{row_number}*I{row_number})/1000000"
    # The rates above are OpenRouter/Kie route rates; a Kie leg is landed at H3,
    # an OpenRouter leg at E3.  The conditional conspect is always economy/OR.
    rub = f"P{row_number}*IF(D{row_number}=\"OpenRouter\",$E$3,$H$3)+Q{row_number}*IF(E{row_number}=\"OpenRouter\",$E$3,$H$3)+{conspect_cost}*$E$3"
    primary_usd = int(data["pa"]) * (int(data["max_input"]) * float(data["pi"]) + int(data["max_output"]) * float(data["po"])) / 1_000_000
    fallback_usd = int(data["fa"]) * (int(data["max_input"]) * float(data["fi"]) + int(data["max_output"]) * float(data["fo"])) / 1_000_000
    conspect_usd = 2 * (24_000 * 0.26 + 1_600 * 1.56) / 1_000_000 if data["conspect"] else 0
    primary_rub = primary_usd * (106.182 if data["primary"] == "OpenRouter" else 100.6315)
    fallback_rub = fallback_usd * (106.182 if data["fallback"] == "OpenRouter" else 100.6315)
    route_rub = primary_rub + fallback_rub + conspect_usd * 106.182
    credits = math.ceil(route_rub / (0.331111 * 0.75))
    margin = 1 - route_rub / (credits * 0.331111)
    values = [
        ("A", "scenario_assist_band"), ("B", selector), ("C", data["model"]),
        ("D", data["primary"]), ("E", data["fallback"]), ("F", data["pi"]), ("G", data["po"]),
        ("H", data["fi"]), ("I", data["fo"]), ("J", data["pa"]), ("K", data["fa"]),
        ("L", data["typical_input"]), ("M", data["typical_output"]),
        ("N", data["max_input"]), ("O", data["max_output"]),
    ]
    xml = '<row r="%d">' % row_number
    for col, value in values:
        xml += cell(f"{col}{row_number}", value)
    xml += cell(f"P{row_number}", primary_usd, formula=primary)
    xml += cell(f"Q{row_number}", fallback_usd, formula=fallback)
    xml += cell(f"R{row_number}", primary_usd + fallback_usd + conspect_usd, formula=f"P{row_number}+Q{row_number}+{conspect_cost}")
    xml += cell(f"S{row_number}", route_rub, formula=rub)
    xml += cell(f"T{row_number}", credits, style="60", formula=f"ROUNDUP(S{row_number}/($B$4*(1-$Q$4)),0)")
    xml += cell(f"U{row_number}", margin, formula=f"1-S{row_number}/(T{row_number}*$B$4)")
    xml += cell(f"V{row_number}", 0)
    xml += cell(f"W{row_number}", 0)
    xml += cell(f"X{row_number}", 3)
    note = "ACTIVE 25% Scenario band; uncached worst-route; conditional conspect; no user content. " + selector
    xml += cell(f"Y{row_number}", note, style="63")
    xml += cell(f"Z{row_number}", ACTIVE_CACHE_VALUES["cache_read_multiplier"])
    xml += cell(f"AA{row_number}", ACTIVE_CACHE_VALUES["cache_write_multiplier"])
    xml += cell(f"AB{row_number}", ACTIVE_CACHE_VALUES["cache_ttl"])
    xml += cell(f"AC{row_number}", ACTIVE_CACHE_VALUES["cache_min_prefix_tokens"])
    xml += cell(f"AD{row_number}", ACTIVE_CACHE_VALUES["cache_status"])
    xml += cell(f"AE{row_number}", ACTIVE_CACHE_VALUES["cache_evidence"], style="63")
    return xml + "</row>"


def patch_sheet(sheet: str) -> str:
    header = row_xml(sheet, 10)
    header_values = [
        ("Z10", "cache_read_multiplier"),
        ("AA10", "cache_write_multiplier"),
        ("AB10", "cache_ttl"),
        ("AC10", "cache_min_prefix_tokens"),
        ("AD10", "cache_status"),
        ("AE10", "cache_evidence"),
    ]
    for coord, value in header_values:
        header = replace_cell(header, coord, value, style="50")
    if not all(coord in header for coord, _ in header_values):
        insertion = "".join(cell(coord, value, style="50") for coord, value in header_values)
        header = header.replace("</row>", insertion + "</row>")
    sheet = replace_row(sheet, 10, header)
    # Add an explicit active-band floor beside the legacy temporary policy.
    settings = row_xml(sheet, 4)
    settings = replace_cell(settings, "P4", "Scenario active band margin floor", style="46")
    settings = replace_cell(settings, "Q4", 0.25, style="47")
    sheet = replace_row(sheet, 4, settings)
    note = " ACTIVE Scenario pricing uses scenario_assist_band rows: UTF-8 context bands, no-cache worst-route, conditional conspect, and 25% minimum gross margin. Legacy scenario_assist_price rows remain only for backwards-compatible import/replay."
    for coord in ("A2", "A6"):
        row_number = 2 if coord == "A2" else 6
        row = row_xml(sheet, row_number)
        match = re.search(CELL_RE.pattern.format(coord=coord), row, re.S)
        if match:
            text = "".join(re.findall(r"<t[^>]*>(.*?)</t>", match.group(0), re.S))
            if "ACTIVE Scenario pricing uses" not in text:
                row = replace_cell(row, coord, text + note, style="45")
                sheet = replace_row(sheet, row_number, row)
    # Make the patch idempotent while iterating on formulas: remove any prior
    # generated band rows before choosing fresh row numbers.
    for match in list(re.finditer(r'<row\b[^>]*\br="(\d+)"[^>]*>.*?</row>', sheet, re.S)):
        if "scenario_assist_band</t>" in match.group(0) or "scenario_structurize_active</t>" in match.group(0):
            sheet = sheet.replace(match.group(0), "", 1)
    existing = {int(n) for n in re.findall(r'<row\b[^>]*\br="(\d+)"', sheet)}
    generated = band_rows()
    start = max(existing) + 1
    additions = "".join(render_row(start + i, data) for i, data in enumerate(generated))
    # Structurization has a separate active 25% row.  The legacy row 30 is kept
    # unchanged so old replay/import jobs remain deterministic.
    row_number = start + len(generated)
    p_cost = 2 * (40_000 * 0.09 + 4_000 * 0.18) / 1_000_000
    route_rub = p_cost * 106.182
    credits = math.ceil(route_rub / (0.331111 * 0.75))
    margin = 1 - route_rub / (credits * 0.331111)
    struct = '<row r="%d">' % row_number
    struct += cell(f"A{row_number}", "scenario_structurize_active")
    struct += cell(f"B{row_number}", "economy/active")
    struct += cell(f"C{row_number}", "deepseek/deepseek-v4-flash")
    struct += cell(f"D{row_number}", "OpenRouter") + cell(f"E{row_number}", "—")
    for col, value in [("F", .09), ("G", .18), ("H", 0), ("I", 0), ("J", 2), ("K", 0), ("L", 0), ("M", 0), ("N", 40_000), ("O", 4_000)]:
        struct += cell(f"{col}{row_number}", value)
    struct += cell(f"P{row_number}", p_cost, formula=f"J{row_number}*(N{row_number}*F{row_number}+O{row_number}*G{row_number})/1000000")
    struct += cell(f"Q{row_number}", 0, formula=f"K{row_number}*(N{row_number}*H{row_number}+O{row_number}*I{row_number})/1000000")
    struct += cell(f"R{row_number}", p_cost, formula=f"P{row_number}+Q{row_number}")
    struct += cell(f"S{row_number}", route_rub, formula=f"P{row_number}*$E$3")
    struct += cell(f"T{row_number}", credits, style="60", formula=f"ROUNDUP(S{row_number}/($B$4*(1-$Q$4)),0)")
    struct += cell(f"U{row_number}", margin, formula=f"1-S{row_number}/(T{row_number}*$B$4)")
    struct += cell(f"V{row_number}", 0) + cell(f"W{row_number}", 0) + cell(f"X{row_number}", 3)
    struct += cell(f"Y{row_number}", "ACTIVE 25% structurize row; two uncached OpenRouter attempts", style="63")
    struct += cell(f"Z{row_number}", ACTIVE_CACHE_VALUES["cache_read_multiplier"])
    struct += cell(f"AA{row_number}", ACTIVE_CACHE_VALUES["cache_write_multiplier"])
    struct += cell(f"AB{row_number}", ACTIVE_CACHE_VALUES["cache_ttl"])
    struct += cell(f"AC{row_number}", ACTIVE_CACHE_VALUES["cache_min_prefix_tokens"])
    struct += cell(f"AD{row_number}", ACTIVE_CACHE_VALUES["cache_status"])
    struct += cell(f"AE{row_number}", ACTIVE_CACHE_VALUES["cache_evidence"], style="63")
    additions += struct + "</row>"
    sheet = sheet.replace("</sheetData>", additions + "</sheetData>", 1)
    sheet = re.sub(r'<dimension ref="A1:[A-Z]+\d+"', f'<dimension ref="A1:AE{row_number}"', sheet, count=1)
    sheet = re.sub(r'<autoFilter ref="A10:[A-Z]+\d+"', f'<autoFilter ref="A10:AE{row_number}"', sheet, count=1)
    return sheet


def patch(workbook: Path = WORKBOOK) -> None:
    with zipfile.ZipFile(workbook, "r") as source:
        entries = {info.filename: source.read(info.filename) for info in source.infolist()}
        sheet = entries["xl/worksheets/sheet15.xml"].decode("utf-8")
        entries["xl/worksheets/sheet15.xml"] = patch_sheet(sheet).encode("utf-8")
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
