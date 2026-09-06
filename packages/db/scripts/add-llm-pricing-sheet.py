#!/usr/bin/env python3
"""Append the finance-owned LLM pricing sheet without rewriting existing sheets.

The Vertov workbook is a mature LibreOffice-generated OOXML package.  Loading and
saving it through a spreadsheet library rewrites styles, cached formula values and
worksheet XML even when no business cell changed.  This updater works at the OOXML
package boundary instead: it appends one worksheet part and changes only the package
indexes needed to make that sheet visible.  Every pre-existing worksheet part is
therefore preserved byte-for-byte.
"""

from __future__ import annotations

import argparse
import copy
import math
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types"
XML = "http://www.w3.org/XML/1998/namespace"

ET.register_namespace("", MAIN)
ET.register_namespace("r", REL)

SHEET_NAME = "LLM ЦЕНЫ"
CAPTURED_ON = "2026-08-13"
# Legacy flat rows retain the historical owner-approved value for replay.  Active
# quote rows below use the signed launch floor and are the only rows runtime reads.
SCENARIO_MARGIN_FLOOR = 0.07
SCENARIO_ACTIVE_MARGIN_FLOOR = 0.25
GLOBAL_MARGIN_FLOOR = 0.25
ACTIVE_CACHE_VALUES = {
    "cache_read_multiplier": 1.0,
    "cache_write_multiplier": 1.0,
    "cache_ttl": "none",
    "cache_min_prefix_tokens": 0,
    "cache_status": "unverified_disabled",
    "cache_evidence": "OWNER-GATED PROBE; 2026-08-15",
}


def cell(ref: str, value: object, style: int = 59, formula: str | None = None) -> ET.Element:
    attrs = {"r": ref, "s": str(style)}
    node = ET.Element(f"{{{MAIN}}}c", attrs)
    if formula is not None:
        ET.SubElement(node, f"{{{MAIN}}}f").text = formula
        ET.SubElement(node, f"{{{MAIN}}}v").text = str(value)
        return node
    if isinstance(value, str):
        node.set("t", "inlineStr")
        inline = ET.SubElement(node, f"{{{MAIN}}}is")
        text = ET.SubElement(inline, f"{{{MAIN}}}t")
        if value != value.strip() or "\n" in value:
            text.set(f"{{{XML}}}space", "preserve")
        text.text = value
    else:
        ET.SubElement(node, f"{{{MAIN}}}v").text = str(value)
    return node


def row(index: int, values: list[tuple[str, object, int, str | None]]) -> ET.Element:
    node = ET.Element(f"{{{MAIN}}}row", {"r": str(index)})
    for ref, value, style, formula in values:
        node.append(cell(ref, value, style, formula))
    return node


def excel_col(index: int) -> str:
    """Zero-based column index to an OOXML A1 column label."""
    value = index + 1
    out = ""
    while value:
        value, remainder = divmod(value - 1, 26)
        out = chr(65 + remainder) + out
    return out


def sheet_xml() -> bytes:
    root = ET.Element(f"{{{MAIN}}}worksheet")
    # The active band and active structurize rows are appended below legacy rows.
    ET.SubElement(root, f"{{{MAIN}}}dimension", {"ref": "A1:AE121"})
    views = ET.SubElement(root, f"{{{MAIN}}}sheetViews")
    view = ET.SubElement(views, f"{{{MAIN}}}sheetView", {"workbookViewId": "0"})
    ET.SubElement(view, f"{{{MAIN}}}pane", {
        "ySplit": "10", "topLeftCell": "A11", "activePane": "bottomLeft", "state": "frozen"
    })
    ET.SubElement(root, f"{{{MAIN}}}sheetFormatPr", {"defaultRowHeight": "15"})
    cols = ET.SubElement(root, f"{{{MAIN}}}cols")
    for minimum, maximum, width in [
        (1, 1, 21), (2, 2, 32), (3, 5, 15), (6, 11, 14), (12, 15, 16),
        (16, 21, 17), (22, 24, 15), (25, 25, 48), (26, 27, 16), (28, 28, 12),
        (29, 29, 20), (30, 31, 17),
    ]:
        ET.SubElement(cols, f"{{{MAIN}}}col", {
            "min": str(minimum), "max": str(maximum), "width": str(width), "customWidth": "1"
        })

    data = ET.SubElement(root, f"{{{MAIN}}}sheetData")
    data.append(row(1, [("A1", "LLM / TEXT PRICING — ЕДИНЫЙ ФИНАНСОВЫЙ ИСТОЧНИК", 44, None)]))
    data.append(row(2, [("A2", (
        "Синие входы: ставки $/1M токенов и продуктовые лимиты. Все цены в кредитах, "
        "себестоимость и маржа считаются формулами. Существующие media-листы не изменены. "
        "TEMPORARY POLICY (owner-approved 2026-08-14): Scenario/structurize use a 7% gross-margin floor "
        "until reviewed before launch; Boards/media retain the global 25% floor."
    ), 45, None)]))
    data.append(row(3, [
        ("A3", "Курс USD/RUB", 46, None), ("B3", 85, 47, "'Сетка FX'!$B$3"),
        ("D3", "Landed ₽/$ OpenRouter", 46, None), ("E3", 106.182, 47, "'Сетка FX'!$F$3"),
        ("G3", "Landed ₽/$ direct / Kie", 46, None), ("H3", 100.6315, 47, "'Сетка FX'!$F$4"),
        ("J3", "Conspect max input tokens", 46, None), ("K3", 24000, 47, None),
        ("M3", "Conspect max output tokens", 46, None), ("N3", 1600, 47, None),
        ("P3", "Conspect max attempts", 46, None), ("Q3", 2, 47, None),
    ]))
    data.append(row(4, [
        ("A4", "Цена кредита, ₽", 46, None), ("B4", 0.331111, 47, "'Сетка FX'!$B$4"),
        ("D4", "Целевая валовая маржа", 46, None), ("E4", 0.25, 47, "'Сетка FX'!$B$5"),
        ("G4", "Дата снимка ставок", 46, None), ("H4", CAPTURED_ON, 47, None),
        ("J4", "Structurize max attempts", 46, None), ("K4", 2, 47, None),
        ("M4", "Scenario temporary margin floor (legacy)", 46, None), ("N4", SCENARIO_MARGIN_FLOOR, 47, None),
        ("P4", "Scenario active band margin floor", 46, None), ("Q4", SCENARIO_ACTIVE_MARGIN_FLOOR, 47, None),
    ]))
    data.append(row(5, [("A5", (
        "Правило Boards: цена покрывает полностью выполненную primary-попытку и полностью выполненный fallback "
        "на максимальном input/output. Это консервативный fail-closed сценарий; пользователь списывается один раз."
    ), 45, None)]))
    data.append(row(6, [("A6", (
        "Scenario использует одну стоимость OpenRouter на вызов и отдельные лимиты каждого scope. "
        "Boards Prompt Studio использует строки surface=boards_prompt_studio. "
        "Legacy Scenario rows retain 7% for replay; active band rows use 25% no-cache worst-route floor."
    ), 45, None)]))

    headers = [
        "surface", "selector", "model_slug", "primary_provider", "fallback_provider",
        "primary_input_$/MTok", "primary_output_$/MTok", "fallback_input_$/MTok",
        "fallback_output_$/MTok", "primary_max_attempts", "fallback_max_attempts",
        "typical_input_tokens", "typical_output_tokens", "max_input_tokens", "max_output_tokens",
        "primary_max_cost_$", "fallback_max_cost_$", "worst_route_cost_$", "worst_route_cost_₽",
        "credits", "margin_at_floor", "brief_char_limit", "result_char_limit", "chars_per_token",
        "source/status", "cache_read_multiplier", "cache_write_multiplier", "cache_ttl",
        "cache_min_prefix_tokens", "cache_status", "cache_evidence",
    ]
    data.append(row(10, [
        (f"{excel_col(index)}10", value, 50, None)
        for index, value in enumerate(headers)
    ]))

    records = [
        (11, "boards_prompt_studio", "gemini", "google/gemini-3-flash-preview", "Kie", "OpenRouter", 0.15, 0.90, 0.50, 3.00, 1, 1, 420, 96, 2400, 400, 1000, 1000, 1.5, "owner-confirmed Kie + OpenRouter catalog; 2026-08-13"),
        (12, "boards_prompt_studio", "claude", "anthropic/claude-sonnet-5", "Kie", "OpenRouter", 0.85, 4.275, 2.00, 10.00, 1, 1, 420, 96, 2400, 400, 1000, 1000, 1.5, "owner-confirmed Kie + OpenRouter catalog; 2026-08-13"),
        (13, "boards_prompt_studio", "gpt", "openai/gpt-5.6-terra", "Kie", "OpenRouter", 0.70, 4.20, 2.50, 15.00, 1, 1, 420, 96, 2400, 400, 1000, 1000, 1.5, "owner-confirmed Kie + OpenRouter catalog; 2026-08-13"),
        (15, "scenario_assist_price", "economy/project", "qwen/qwen3.5-plus-02-15", "OpenRouter", "—", 0.26, 1.56, 0, 0, 2, 0, 0, 0, 24000, 2000, 0, 0, 0, "OpenRouter catalog; two pre-token attempts + conspect overhead"),
        (16, "scenario_assist_price", "economy/span", "qwen/qwen3.5-plus-02-15", "OpenRouter", "—", 0.26, 1.56, 0, 0, 2, 0, 0, 0, 22400, 1500, 0, 0, 0, "OpenRouter catalog; two pre-token attempts + conspect overhead"),
        (17, "scenario_assist_price", "economy/scene", "qwen/qwen3.5-plus-02-15", "OpenRouter", "—", 0.26, 1.56, 0, 0, 2, 0, 0, 0, 28000, 2000, 0, 0, 0, "OpenRouter catalog; two pre-token attempts + conspect overhead"),
        (18, "scenario_assist_price", "economy/script", "qwen/qwen3.5-plus-02-15", "OpenRouter", "—", 0.26, 1.56, 0, 0, 2, 0, 0, 0, 83800, 2500, 0, 0, 0, "OpenRouter catalog; two pre-token attempts + conspect overhead"),
        (20, "scenario_assist_price", "standard/project", "google/gemini-3-flash-preview", "Kie", "OpenRouter", 0.15, 0.90, 0.50, 3.00, 1, 2, 0, 0, 24000, 2000, 0, 0, 0, "Kie primary + two OpenRouter pre-token attempts + conspect overhead"),
        (21, "scenario_assist_price", "standard/span", "google/gemini-3-flash-preview", "Kie", "OpenRouter", 0.15, 0.90, 0.50, 3.00, 1, 2, 0, 0, 22400, 1500, 0, 0, 0, "Kie primary + two OpenRouter pre-token attempts + conspect overhead"),
        (22, "scenario_assist_price", "standard/scene", "google/gemini-3-flash-preview", "Kie", "OpenRouter", 0.15, 0.90, 0.50, 3.00, 1, 2, 0, 0, 28000, 2000, 0, 0, 0, "Kie primary + two OpenRouter pre-token attempts + conspect overhead"),
        (23, "scenario_assist_price", "standard/script", "google/gemini-3-flash-preview", "Kie", "OpenRouter", 0.15, 0.90, 0.50, 3.00, 1, 2, 0, 0, 83800, 2500, 0, 0, 0, "Kie primary + two OpenRouter pre-token attempts + conspect overhead"),
        (25, "scenario_assist_price", "max/project", "anthropic/claude-sonnet-5", "Kie", "OpenRouter", 0.85, 4.275, 2.00, 10.00, 1, 2, 0, 0, 24000, 2000, 0, 0, 0, "Kie primary + two OpenRouter pre-token attempts + conspect overhead"),
        (26, "scenario_assist_price", "max/span", "anthropic/claude-sonnet-5", "Kie", "OpenRouter", 0.85, 4.275, 2.00, 10.00, 1, 2, 0, 0, 22400, 1500, 0, 0, 0, "Kie primary + two OpenRouter pre-token attempts + conspect overhead"),
        (27, "scenario_assist_price", "max/scene", "anthropic/claude-sonnet-5", "Kie", "OpenRouter", 0.85, 4.275, 2.00, 10.00, 1, 2, 0, 0, 28000, 2000, 0, 0, 0, "Kie primary + two OpenRouter pre-token attempts + conspect overhead"),
        (28, "scenario_assist_price", "max/script", "anthropic/claude-sonnet-5", "Kie", "OpenRouter", 0.85, 4.275, 2.00, 10.00, 1, 2, 0, 0, 83800, 2500, 0, 0, 0, "Kie primary + two OpenRouter pre-token attempts + conspect overhead"),
        (30, "scenario_structurize", "economy", "deepseek/deepseek-v4-flash", "OpenRouter", "—", 0.09, 0.18, 0, 0, 2, 0, 0, 0, 40000, 4000, 0, 0, 0, "OpenRouter catalog; two schema attempts priced"),
        (31, "scenario_candidate", "candidate", "google/gemini-2.5-flash", "OpenRouter", "—", 0.30, 2.50, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, "OpenRouter catalog; evaluated candidate, not active"),
        (33, "boards_shot_plan", "default", "google/gemini-3-flash-preview", "OpenRouter", "—", 0.50, 3.00, 0, 0, 2, 0, 0, 0, 24000, 4500, 0, 0, 0, "OpenRouter; reserve ceiling covers two schema attempts"),
        (34, "boards_scene_objects", "default", "deepseek/deepseek-v4-flash", "OpenRouter", "—", 0.09, 0.18, 0, 0, 1, 0, 0, 0, 68000, 800, 0, 0, 0, "OpenRouter; free user policy, COGS ceiling still signed"),
        (35, "disabled_prompt_enhancer", "generate", "openai/gpt-4o-mini", "OpenRouter", "—", 0.15, 0.60, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, "Disabled feature flag; rate recorded for inventory, not billed"),
        (36, "scenario_material_compaction", "background", "qwen/qwen3.5-plus-02-15", "OpenRouter", "—", 0.26, 1.56, 0, 0, 2, 0, 0, 0, 72000, 700, 0, 0, 0, "Free background policy; two OpenRouter attempts and bounded raw material"),
    ]
    for record in records:
        (idx, surface, selector, slug, primary, fallback, pi, po, fi, fo, pa, fa, ti, to, mi, mo, bc, rc, cpt, source) = record
        values = [
            (f"A{idx}", surface, 59, None), (f"B{idx}", selector, 59, None),
            (f"C{idx}", slug, 59, None), (f"D{idx}", primary, 59, None),
            (f"E{idx}", fallback, 59, None), (f"F{idx}", pi, 59, None),
            (f"G{idx}", po, 59, None), (f"H{idx}", fi, 59, None),
            (f"I{idx}", fo, 59, None), (f"J{idx}", pa, 59, None),
            (f"K{idx}", fa, 59, None), (f"L{idx}", ti, 59, None),
            (f"M{idx}", to, 59, None), (f"N{idx}", mi, 59, None),
            (f"O{idx}", mo, 59, None),
        ]
        if surface in {"boards_prompt_studio", "scenario_assist_price", "scenario_structurize", "boards_shot_plan", "boards_scene_objects", "scenario_material_compaction"}:
            primary_cost = pa * (mi * pi + mo * po) / 1_000_000
            fallback_cost = fa * (mi * fi + mo * fo) / 1_000_000
            conspect_cost = 2 * (24000 * 0.26 + 1600 * 1.56) / 1_000_000 if surface == "scenario_assist_price" else 0
            route_cost = primary_cost + fallback_cost + conspect_cost
            primary_fx = 106.182 if primary == "OpenRouter" else 100.6315
            fallback_fx = 106.182 if fallback == "OpenRouter" else 100.6315
            route_cost_rub = primary_cost * primary_fx + fallback_cost * fallback_fx + conspect_cost * 106.182
            margin_floor = SCENARIO_MARGIN_FLOOR if surface in {"scenario_assist_price", "scenario_structurize"} else GLOBAL_MARGIN_FLOOR
            credits = math.ceil(route_cost_rub / (0.331111 * (1 - margin_floor)))
            margin = 1 - route_cost_rub / (credits * 0.331111)
            floor_ref = "$N$4" if surface in {"scenario_assist_price", "scenario_structurize"} else "$E$4"
            source = (
                f"TEMPORARY 7% Scenario margin policy — owner-approved 2026-08-14; review before launch. {source}"
                if surface in {"scenario_assist_price", "scenario_structurize"}
                else source
            )
            values.extend([
                (f"P{idx}", primary_cost, 59, f"J{idx}*(N{idx}*F{idx}+O{idx}*G{idx})/1000000"),
                (f"Q{idx}", fallback_cost, 59, f"K{idx}*(N{idx}*H{idx}+O{idx}*I{idx})/1000000"),
                (f"R{idx}", route_cost, 59, f"P{idx}+Q{idx}+IF(A{idx}=\"scenario_assist_price\",$Q$3*($K$3*$F$15+$N$3*$G$15)/1000000,0)"),
                (f"S{idx}", route_cost_rub, 59, f"P{idx}*IF(D{idx}=\"OpenRouter\",$E$3,$H$3)+Q{idx}*IF(E{idx}=\"OpenRouter\",$E$3,$H$3)+IF(A{idx}=\"scenario_assist_price\",$Q$3*($K$3*$F$15+$N$3*$G$15)/1000000*$E$3,0)"),
                (f"T{idx}", credits, 60, f"ROUNDUP(S{idx}/($B$4*(1-{floor_ref})),0)"),
                (f"U{idx}", margin, 59, f"1-S{idx}/(T{idx}*$B$4)"),
            ])
        values.extend([
            (f"V{idx}", bc, 59, None), (f"W{idx}", rc, 59, None),
            (f"X{idx}", cpt, 59, None), (f"Y{idx}", source, 63, None),
        ])
        data.append(row(idx, values))

    # Active Scenario quote rows.  Each UTF-8 envelope has an explicit
    # no-conspect and conspect variant; the planner chooses the smallest band
    # and the shared conspect predicate chooses the corresponding row.
    active_bands = {
        "project": [("8k", 8000), ("16k", 16000), ("24k", 24000)],
        "span": [("8k", 8000), ("16k", 16000), ("22_4k", 22400)],
        "scene": [("8k", 8000), ("16k", 16000), ("28k", 28000)],
        "script": [("16k", 16000), ("32k", 32000), ("48k", 48000), ("64k", 64000), ("83_8k", 83800)],
    }
    active_tiers = [
        ("economy", "qwen/qwen3.5-plus-02-15", "OpenRouter", "—", .26, 1.56, 0, 0, 2, 0),
        ("standard", "google/gemini-3-flash-preview", "Kie", "OpenRouter", .15, .9, .5, 3, 1, 2),
        ("max", "anthropic/claude-sonnet-5", "Kie", "OpenRouter", .85, 4.275, 2, 10, 1, 2),
    ]
    active_outputs = {"project": 2000, "span": 1500, "scene": 2000, "script": 2500}
    active_index = 37
    for tier, slug, primary, fallback, pi, po, fi, fo, pa, fa in active_tiers:
        for scope, scope_bands in active_bands.items():
            for band_id, max_input in scope_bands:
                for includes_conspect in (False, True):
                    selector = f"{tier}/{scope}/{band_id}/{('conspect' if includes_conspect else 'no-conspect')}"
                    max_output = active_outputs[scope]
                    p_cost = pa * (max_input * pi + max_output * po) / 1_000_000
                    f_cost = fa * (max_input * fi + max_output * fo) / 1_000_000
                    c_cost = 2 * (24000 * .26 + 1600 * 1.56) / 1_000_000 if includes_conspect else 0
                    p_rub = p_cost * (106.182 if primary == "OpenRouter" else 100.6315)
                    f_rub = f_cost * (106.182 if fallback == "OpenRouter" else 100.6315)
                    route_rub = p_rub + f_rub + c_cost * 106.182
                    credits = math.ceil(route_rub / (.331111 * (1 - SCENARIO_ACTIVE_MARGIN_FLOOR)))
                    margin = 1 - route_rub / (credits * .331111)
                    values = [
                        (f"A{active_index}", "scenario_assist_band", 59, None),
                        (f"B{active_index}", selector, 59, None), (f"C{active_index}", slug, 59, None),
                        (f"D{active_index}", primary, 59, None), (f"E{active_index}", fallback, 59, None),
                        (f"F{active_index}", pi, 59, None), (f"G{active_index}", po, 59, None),
                        (f"H{active_index}", fi, 59, None), (f"I{active_index}", fo, 59, None),
                        (f"J{active_index}", pa, 59, None), (f"K{active_index}", fa, 59, None),
                        (f"L{active_index}", int(max_input * .6), 59, None),
                        (f"M{active_index}", int(max_output * .6), 59, None),
                        (f"N{active_index}", max_input, 59, None), (f"O{active_index}", max_output, 59, None),
                        (f"P{active_index}", p_cost, 59, f"J{active_index}*(N{active_index}*F{active_index}+O{active_index}*G{active_index})/1000000"),
                        (f"Q{active_index}", f_cost, 59, f"K{active_index}*(N{active_index}*H{active_index}+O{active_index}*I{active_index})/1000000"),
                        (f"R{active_index}", p_cost + f_cost + c_cost, 59, f"P{active_index}+Q{active_index}+{c_cost}"),
                        (f"S{active_index}", route_rub, 59, f"P{active_index}*IF(D{active_index}=\"OpenRouter\",$E$3,$H$3)+Q{active_index}*IF(E{active_index}=\"OpenRouter\",$E$3,$H$3)+{c_cost}*$E$3"),
                        (f"T{active_index}", credits, 60, f"ROUNDUP(S{active_index}/($B$4*(1-$Q$4)),0)"),
                        (f"U{active_index}", margin, 59, f"1-S{active_index}/(T{active_index}*$B$4)"),
                        (f"V{active_index}", 0, 59, None), (f"W{active_index}", 0, 59, None),
                        (f"X{active_index}", 3, 59, None),
                        (f"Y{active_index}", f"ACTIVE 25% Scenario band; uncached worst-route; conditional conspect; {selector}", 63, None),
                        (f"Z{active_index}", ACTIVE_CACHE_VALUES["cache_read_multiplier"], 59, None),
                        (f"AA{active_index}", ACTIVE_CACHE_VALUES["cache_write_multiplier"], 59, None),
                        (f"AB{active_index}", ACTIVE_CACHE_VALUES["cache_ttl"], 59, None),
                        (f"AC{active_index}", ACTIVE_CACHE_VALUES["cache_min_prefix_tokens"], 59, None),
                        (f"AD{active_index}", ACTIVE_CACHE_VALUES["cache_status"], 59, None),
                        (f"AE{active_index}", ACTIVE_CACHE_VALUES["cache_evidence"], 63, None),
                    ]
                    data.append(row(active_index, values))
                    active_index += 1

    p_cost = 2 * (40_000 * .09 + 4_000 * .18) / 1_000_000
    route_rub = p_cost * 106.182
    credits = math.ceil(route_rub / (.331111 * (1 - SCENARIO_ACTIVE_MARGIN_FLOOR)))
    margin = 1 - route_rub / (credits * .331111)
    idx = active_index
    values = [
        (f"A{idx}", "scenario_structurize_active", 59, None), (f"B{idx}", "economy/active", 59, None),
        (f"C{idx}", "deepseek/deepseek-v4-flash", 59, None), (f"D{idx}", "OpenRouter", 59, None),
        (f"E{idx}", "—", 59, None), (f"F{idx}", .09, 59, None), (f"G{idx}", .18, 59, None),
        (f"H{idx}", 0, 59, None), (f"I{idx}", 0, 59, None), (f"J{idx}", 2, 59, None),
        (f"K{idx}", 0, 59, None), (f"L{idx}", 0, 59, None), (f"M{idx}", 0, 59, None),
        (f"N{idx}", 40_000, 59, None), (f"O{idx}", 4_000, 59, None),
        (f"P{idx}", p_cost, 59, f"J{idx}*(N{idx}*F{idx}+O{idx}*G{idx})/1000000"),
        (f"Q{idx}", 0, 59, f"K{idx}*(N{idx}*H{idx}+O{idx}*I{idx})/1000000"),
        (f"R{idx}", p_cost, 59, f"P{idx}+Q{idx}"), (f"S{idx}", route_rub, 59, f"P{idx}*$E$3"),
        (f"T{idx}", credits, 60, f"ROUNDUP(S{idx}/($B$4*(1-$Q$4)),0)"),
        (f"U{idx}", margin, 59, f"1-S{idx}/(T{idx}*$B$4)"), (f"V{idx}", 0, 59, None),
        (f"W{idx}", 0, 59, None), (f"X{idx}", 3, 59, None),
        (f"Y{idx}", "ACTIVE 25% structurize row; two uncached OpenRouter attempts", 63, None),
        (f"Z{idx}", ACTIVE_CACHE_VALUES["cache_read_multiplier"], 59, None),
        (f"AA{idx}", ACTIVE_CACHE_VALUES["cache_write_multiplier"], 59, None),
        (f"AB{idx}", ACTIVE_CACHE_VALUES["cache_ttl"], 59, None),
        (f"AC{idx}", ACTIVE_CACHE_VALUES["cache_min_prefix_tokens"], 59, None),
        (f"AD{idx}", ACTIVE_CACHE_VALUES["cache_status"], 59, None),
        (f"AE{idx}", ACTIVE_CACHE_VALUES["cache_evidence"], 63, None),
    ]
    data.append(row(idx, values))
    active_index += 1

    ET.SubElement(root, f"{{{MAIN}}}autoFilter", {"ref": f"A10:AE{active_index - 1}"})
    ET.SubElement(root, f"{{{MAIN}}}mergeCells", {"count": "4"})
    merges = root.find(f"{{{MAIN}}}mergeCells")
    assert merges is not None
    for ref in ["A1:AE1", "A2:AE2", "A5:AE5", "A6:AE6"]:
        ET.SubElement(merges, f"{{{MAIN}}}mergeCell", {"ref": ref})
    ET.SubElement(root, f"{{{MAIN}}}pageMargins", {
        "left": "0.7", "right": "0.7", "top": "0.75", "bottom": "0.75", "header": "0.3", "footer": "0.3"
    })
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def update(workbook: Path) -> None:
    with zipfile.ZipFile(workbook, "r") as source:
        names = set(source.namelist())
        if "xl/worksheets/sheet15.xml" in names:
            raise SystemExit(f"{workbook}: sheet15.xml already exists; refusing to overwrite")
        workbook_xml = ET.fromstring(source.read("xl/workbook.xml"))
        sheets = workbook_xml.find(f"{{{MAIN}}}sheets")
        assert sheets is not None
        if any(sheet.get("name") == SHEET_NAME for sheet in sheets):
            raise SystemExit(f"{workbook}: sheet «{SHEET_NAME}» already exists")

        rels_xml = ET.fromstring(source.read("xl/_rels/workbook.xml.rels"))
        rel_ids = [int(rel.get("Id", "rId0")[3:]) for rel in rels_xml if rel.get("Id", "").startswith("rId")]
        next_rel = max(rel_ids) + 1
        sheet_ids = [int(sheet.get("sheetId", "0")) for sheet in sheets]
        next_sheet = max(sheet_ids) + 1
        relationship_id = f"rId{next_rel}"

        sheets.append(ET.Element(f"{{{MAIN}}}sheet", {
            "name": SHEET_NAME, "sheetId": str(next_sheet), "state": "visible", f"{{{REL}}}id": relationship_id,
        }))
        rels_xml.append(ET.Element(f"{{{PKG_REL}}}Relationship", {
            "Id": relationship_id,
            "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
            "Target": "worksheets/sheet15.xml",
        }))

        types_xml = ET.fromstring(source.read("[Content_Types].xml"))
        types_xml.append(ET.Element(f"{{{CONTENT}}}Override", {
            "PartName": "/xl/worksheets/sheet15.xml",
            "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        }))

        replacement = {
            "xl/workbook.xml": ET.tostring(workbook_xml, encoding="utf-8", xml_declaration=True),
            "xl/_rels/workbook.xml.rels": ET.tostring(rels_xml, encoding="utf-8", xml_declaration=True),
            "[Content_Types].xml": ET.tostring(types_xml, encoding="utf-8", xml_declaration=True),
            "xl/worksheets/sheet15.xml": sheet_xml(),
        }

        fd, temp_name = tempfile.mkstemp(prefix=workbook.stem + ".", suffix=".xlsx", dir=workbook.parent)
        os.close(fd)
        try:
            with zipfile.ZipFile(temp_name, "w") as target:
                for info in source.infolist():
                    target.writestr(copy.copy(info), replacement.get(info.filename, source.read(info.filename)))
                new_info = zipfile.ZipInfo("xl/worksheets/sheet15.xml")
                new_info.date_time = source.infolist()[0].date_time
                new_info.compress_type = zipfile.ZIP_DEFLATED
                new_info.external_attr = 0o600 << 16
                target.writestr(new_info, replacement["xl/worksheets/sheet15.xml"])
            shutil.move(temp_name, workbook)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook", type=Path)
    args = parser.parse_args()
    update(args.workbook.resolve())


if __name__ == "__main__":
    main()
