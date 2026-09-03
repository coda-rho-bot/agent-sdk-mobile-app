#!/usr/bin/env python3
"""Generate src/theme/catalog.ts from the Angus theming library's token JSONs.

Maps Material-3 semantic slots to the app's Palette slots. Themes with a
single mode (e.g. gruvbox-light) provide that mode for both light and dark
selection — they're deliberate looks.

Regenerate after adding themes to the library:
    python3 scripts/gen-themes.py
"""
import json
import os

LIB = os.path.expanduser("~/dev/angus/angus-software-theming/tokens")
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "theme", "catalog.ts")


def flatten(mode_tokens: dict) -> dict:
    out = {}
    for k, v in mode_tokens.items():
        if k == "$type":
            continue
        if isinstance(v, dict) and "$value" in v:
            out[k] = v["$value"]
        elif isinstance(v, dict) and "$value" == v.get("$value"):
            out[k] = v["$value"]
    return out


def to_palette(t: dict) -> dict:
    def hex_norm(v: str) -> str:
        v = v.strip()
        if len(v) == 9 and v.startswith("#"):  # #RRGGBBAA → rgba
            r, g, b, a = int(v[1:3], 16), int(v[3:5], 16), int(v[5:7], 16), int(v[7:9], 16)
            return f"rgba({r},{g},{b},{round(a / 255, 2)})"
        return v.upper()

    on_bg = t.get("onBackground", "#202020")
    # Pressed overlay: 6-8% of the on-background color.
    r = int(on_bg[1:3], 16); g = int(on_bg[3:5], 16); b = int(on_bg[5:7], 16)
    pressed = f"rgba({r},{g},{b},0.07)"

    surface = t.get("surfaceContainer") or t.get("surface") or "#FFFFFF"
    return {
        "bg": hex_norm(t.get("background", "#FBFBFA")),
        "surface": hex_norm(surface),
        "surfaceEdge": hex_norm(t.get("outlineVariant", "#E7E8E5")),
        "ink": hex_norm(t.get("onBackground", "#202020")),
        "ink2": hex_norm(t.get("onSurfaceVariant", "#5A5E63")),
        "ink3": hex_norm(t.get("outline", "#8B9096")),
        "accent": hex_norm(t.get("primary", "#004F50")),
        "run": hex_norm(t.get("primary", "#1B7F5C")),
        "wait": hex_norm(t.get("tertiary", "#A66A16")),
        "danger": hex_norm(t.get("error", "#B4362B")),
        "bubble": hex_norm(t.get("surfaceContainerHigh") or t.get("surfaceContainer") or surface),
        "pressed": pressed,
    }


SLOT_ORDER = ["bg", "surface", "surfaceEdge", "ink", "ink2", "ink3", "accent", "run", "wait", "danger", "bubble", "pressed"]


def main():
    catalog = {}
    for fname in sorted(os.listdir(LIB)):
        if not fname.endswith(".json"):
            continue
        theme_id = fname[:-5].replace("-tokens", "").replace("_", "-")
        data = json.load(open(os.path.join(LIB, fname)))
        color_root = data.get("color", {})
        # Skip the raw material-theme builder export (no .color family wrapper)
        if not color_root or any(k in color_root for k in ("schemes", "coreColors")):
            continue
        family = next(iter(color_root.values()))
        entry = {}
        for mode_name, mode_tokens in family.items():
            if mode_name in ("standard", "medium", "high"):
                # Angus contrast tiers — use "standard" only.
                if mode_name != "standard":
                    continue
                for sub, sub_tokens in mode_tokens.items():
                    entry[sub] = to_palette(flatten(sub_tokens))
            else:
                entry[mode_name] = to_palette(flatten(mode_tokens))
        if entry:
            catalog[theme_id] = entry

    lines = [
        "// AUTO-GENERATED from the Angus theming library (scripts/gen-themes.py) — do not edit.",
        "// Source: angus-software-theming/tokens/*.json (Material-3 semantic slots → Palette).",
        "",
        'import type { Palette } from "./tokens";',
        "",
        "/** Theme catalog: id → available modes. Single-mode themes apply to both. */",
        "export interface CatalogEntry {",
        '  light?: Palette;',
        '  dark?: Palette;',
        "}",
        "",
        "export const themeCatalog: Record<string, CatalogEntry> = {",
    ]
    for tid in sorted(catalog):
        entry = catalog[tid]
        lines.append(f'  "{tid}": {{')
        for mode in ("light", "dark"):
            if mode in entry:
                lines.append(f"    {mode}: {{")
                for slot in SLOT_ORDER:
                    v = entry[mode][slot]
                    lines.append(f'      {slot}: "{v}",')
                lines.append("    },")
        lines.append("  },")
    lines.append("};")
    lines.append("")
    lines.append("/** Display names for the picker. */")
    lines.append("export const themeNames: Record<string, string> = {")
    pretty = {
        "angus": "Angus", "dracula": "Dracula", "frappe": "Catppuccin Frappé",
        "gruvbox-dark": "Gruvbox Dark", "gruvbox-light": "Gruvbox Light",
        "latte": "Catppuccin Latte", "macchiato": "Catppuccin Macchiato",
        "mocha": "Catppuccin Mocha", "nord": "Nord", "nord-polar": "Nord Polar",
        "rose-pine": "Rosé Pine", "rose-pine-dawn": "Rosé Pine Dawn",
        "rose-pine-moon": "Rosé Pine Moon", "solarized-dark": "Solarized Dark",
        "solarized-light": "Solarized Light",
    }
    for tid in sorted(catalog):
        lines.append(f'  "{tid}": "{pretty.get(tid, tid.replace("-", " ").title())}",')
    lines.append("};")
    lines.append("")
    open(OUT, "w").write("\n".join(lines))
    print(f"wrote {OUT}: {len(catalog)} themes")


if __name__ == "__main__":
    main()
