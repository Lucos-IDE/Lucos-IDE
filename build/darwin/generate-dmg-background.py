#!/usr/bin/env python3
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Lucos. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
"""
Generate Lucos-branded multi-resolution DMG Finder backgrounds.

Produces the multi-page TIFF layout expected by dmgbuild / Finder:
  page 0: 480x320 @ 72 dpi
  page 1: 960x640 @ 144 dpi

Icon slots (from dmg-settings.py.template):
  Lucos.app    -> (120, 160)
  Applications -> (360, 160)
"""

from __future__ import annotations

import math
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


# Lucos brand colors (app icon cyan -> violet + sign-in indigo)
CYAN = (56, 189, 248)        # #38bdf8
INDIGO = (99, 102, 241)      # #6366f1
VIOLET = (139, 92, 246)      # #8b5cf6
BG_TL = (214, 236, 252)      # cool ice (top-left)
BG_TR = (232, 228, 255)      # soft lilac (top-right)
BG_BL = (236, 244, 255)      # pale blue (bottom-left)
BG_BR = (245, 240, 255)      # pale violet (bottom-right)
BG_CENTER = (250, 252, 255)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return (
        int(lerp(c1[0], c2[0], t)),
        int(lerp(c1[1], c2[1], t)),
        int(lerp(c1[2], c2[2], t)),
    )


def brand_color(t: float) -> tuple[int, int, int]:
    if t < 0.55:
        return mix(CYAN, INDIGO, t / 0.55)
    return mix(INDIGO, VIOLET, (t - 0.55) / 0.45)


def paint_background(width: int, height: int) -> Image.Image:
    img = Image.new('RGBA', (width, height), (*BG_CENTER, 255))
    px = img.load()
    cx, cy = width * 0.5, height * 0.45
    max_r = math.hypot(width, height) * 0.62

    for y in range(height):
        yv = y / max(height - 1, 1)
        for x in range(width):
            xv = x / max(width - 1, 1)
            top = mix(BG_TL, BG_TR, xv)
            bottom = mix(BG_BL, BG_BR, xv)
            c = mix(top, bottom, yv)
            # Soft radial lift behind the install arrow lane
            r = math.hypot(x - cx, y - cy) / max_r
            spot = max(0.0, 1.0 - r) ** 1.8
            c = mix(c, BG_CENTER, spot * 0.55)
            px[x, y] = (*c, 255)

    return img


def rounded_poly(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]], fill: int | tuple) -> None:
    """Approximate a filled polygon (Pillow has no stroke-join for custom shapes)."""
    draw.polygon([(int(x), int(y)) for x, y in points], fill=fill)


def draw_chevron_arrow(base: Image.Image) -> Image.Image:
    """Solid Lucos gradient arrow between the two icon slots."""
    w, h = base.size
    s = w / 480.0

	# Icon centers: (120,160) and (360,160), icon_size=80 - keep those zones clear.
    left = 176 * s
    right = 304 * s
    mid_y = 148 * s
    half_t = 7 * s          # shaft half-thickness
    head_w = 36 * s         # chevron depth
    head_h = 28 * s         # chevron half-height

    # Soft brand glow
    glow = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    pad = 10 * s
    gdraw.rounded_rectangle(
        (left - pad, mid_y - half_t - pad, right - head_w * 0.35 + pad, mid_y + half_t + pad),
        radius=int(half_t + pad),
        fill=(*INDIGO, 40),
    )
    gdraw.polygon([
        (right - head_w - pad, mid_y - head_h - pad),
        (right + pad * 1.2, mid_y),
        (right - head_w - pad, mid_y + head_h + pad),
    ], fill=(*VIOLET, 40))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=max(3, int(10 * s))))
    img = Image.alpha_composite(base, glow)

	# Arrow silhouette mask - continuous shaft + chevron head
    mask = Image.new('L', (w, h), 0)
    mdraw = ImageDraw.Draw(mask)

    # Shaft as a thick rounded capsule ending inside the head
    shaft_end = right - head_w * 0.55
    mdraw.rounded_rectangle(
        (left, mid_y - half_t, shaft_end, mid_y + half_t),
        radius=int(half_t),
        fill=255,
    )

    # Solid filled arrowhead connected to the shaft
    tip_x = right
    base_x = right - head_w
    rounded_poly(mdraw, [
        (base_x, mid_y - head_h),
        (tip_x, mid_y),
        (base_x, mid_y + head_h),
    ], 255)
    # Cover the shaft/head join so it reads as one shape
    mdraw.rectangle(
        (base_x - 2 * s, mid_y - half_t, shaft_end + 2 * s, mid_y + half_t),
        fill=255,
    )

    # Fill with horizontal brand gradient clipped by mask
    grad = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    gpx = grad.load()
    span = max(right - left, 1)
    for y in range(int(mid_y - head_h - 2), int(mid_y + head_h + 3)):
        if y < 0 or y >= h:
            continue
        for x in range(int(left), min(int(right) + 1, w)):
            t = (x - left) / span
            r, g, b = brand_color(t)
            gpx[x, y] = (r, g, b, 255)

    colored = Image.composite(grad, Image.new('RGBA', (w, h), (0, 0, 0, 0)), mask)

    # Soft top highlight for a slight material feel
    highlight = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    hdraw = ImageDraw.Draw(highlight)
    hdraw.rounded_rectangle(
        (left + 3 * s, mid_y - half_t + 1 * s, shaft_end - 4 * s, mid_y - half_t + 3.2 * s),
        radius=1,
        fill=(255, 255, 255, 80),
    )
    colored = Image.alpha_composite(colored, highlight)
    return Image.alpha_composite(img, colored)


def render(scale: int) -> Image.Image:
    return draw_chevron_arrow(paint_background(480 * scale, 320 * scale))


def save_multires_tiff(path: Path) -> None:
    img1x = render(1).convert('RGBA')
    img2x = render(2).convert('RGBA')

    tmp_dir = path.parent / '.dmg-bg-tmp'
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True)

    p1 = tmp_dir / 'bg.png'
    p2 = tmp_dir / 'bg@2x.png'
    img1x.save(p1, format='PNG')
    img2x.save(p2, format='PNG')

    subprocess.run(['sips', '-s', 'dpiWidth', '72', '-s', 'dpiHeight', '72', str(p1)], check=True, capture_output=True)
    subprocess.run(['sips', '-s', 'dpiWidth', '144', '-s', 'dpiHeight', '144', str(p2)], check=True, capture_output=True)

    t1 = tmp_dir / 'bg.tiff'
    t2 = tmp_dir / 'bg@2x.tiff'
    subprocess.run(['sips', '-s', 'format', 'tiff', str(p1), '--out', str(t1)], check=True, capture_output=True)
    subprocess.run(['sips', '-s', 'format', 'tiff', str(p2), '--out', str(t2)], check=True, capture_output=True)

    # Multi-resolution TIFF that Finder uses for Retina DMG backgrounds
    subprocess.run(
        ['tiffutil', '-cathidpicheck', str(t1), str(t2), '-out', str(path)],
        check=True,
        capture_output=True,
    )
    shutil.rmtree(tmp_dir, ignore_errors=True)


def main() -> None:
    here = Path(__file__).resolve().parent
    targets = [
        here / 'dmg-background-stable.tiff',
        here / 'dmg-background-insider.tiff',
        here / 'dmg-background-exploration.tiff',
    ]
    primary = targets[0]
    save_multires_tiff(primary)
    data = primary.read_bytes()
    for target in targets[1:]:
        target.write_bytes(data)

    # Optional local preview (not committed)
    preview_dir = here / '.dmg-bg-preview'
    preview_dir.mkdir(exist_ok=True)
    render(1).save(preview_dir / 'preview.png', format='PNG')

    print('Wrote Lucos DMG backgrounds:')
    for t in targets:
        print(f'  {t} ({t.stat().st_size} bytes)')
    print(f'Preview: {preview_dir / "preview.png"}')


if __name__ == '__main__':
    main()
