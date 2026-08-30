#!/usr/bin/env python3
"""
Regenerate the app icon, Android adaptive foreground, and splash mark.

The art is deliberately trivial: the same "bloop" the agent avatars use (a
sphere with a specular crescent), so the icon, the Connect-screen mark and the
avatars are one idea. Nothing here is anyone's brand — change COLORS to make it
yours, then rerun. The outputs are committed, so running this is only necessary
if you change them.

    python3 scripts/make-icons.py        # needs Pillow

Keep in sync with `brandMark` in src/theme/tokens.ts.
"""
from PIL import Image, ImageDraw

BLOOP = (0, 79, 80)      # tokens.brandMark.bloop  (#004F50, Angus teal)
FIELD = (156, 241, 240)  # tokens.brandMark.field  (#9CF1F0, Angus light teal)


def draw_bloop(img: Image.Image, cx: float, cy: float, r: float, fill) -> None:
    """A filled sphere plus a crescent gloss, cut by an offset disc of the same fill."""
    ImageDraw.Draw(img, "RGBA").ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill + (255,))
    gloss = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(gloss)
    hx, hy = cx + r * 0.36, cy - r * 0.40
    rx, ry = r * 0.26, r * 0.40
    d.ellipse([hx - rx, hy - ry, hx + rx, hy + ry], fill=(255, 255, 255, 235))
    d.ellipse(
        [hx - rx - r * 0.12, hy - ry + r * 0.06, hx + rx - r * 0.12, hy + ry + r * 0.06],
        fill=fill + (255,),
    )
    img.alpha_composite(gloss.rotate(38, resample=Image.BICUBIC, center=(hx, hy)))


def main() -> None:
    # Store icon: full-bleed field; iOS applies its own rounded mask.
    icon = Image.new("RGBA", (1024, 1024), FIELD + (255,))
    draw_bloop(icon, 512, 512, 300, BLOOP)
    icon.convert("RGB").save("assets/images/icon.png")

    # Android adaptive foreground: bloop only, inset for the safe zone.
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    draw_bloop(fg, 512, 512, 250, BLOOP)
    fg.save("assets/images/icon-foreground.png")

    # Splash mark: the splash config supplies the field colour.
    splash = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    draw_bloop(splash, 256, 256, 200, BLOOP)
    splash.save("assets/images/splash-icon.png")
    print("wrote assets/images/{icon,icon-foreground,splash-icon}.png")


if __name__ == "__main__":
    main()
