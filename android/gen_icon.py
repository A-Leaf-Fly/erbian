# -*- coding: utf-8 -*-
"""生成耳边 APP 图标：紫底白色耳机，输出各密度 + 自适应前景。"""
from PIL import Image, ImageDraw
import os

BRAND = (83, 74, 183)
BRAND2 = (110, 101, 220)
WHITE = (255, 255, 255)
S = 1024

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'res')


def gradient(size):
    img = Image.new('RGB', (size, size), BRAND)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        c = tuple(int(BRAND[i] + (BRAND2[i] - BRAND[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=c)
    return img


def draw_glyph(img, scale=1.0):
    size = img.size[0]
    d = ImageDraw.Draw(img)
    cx, cy = size / 2.0, size * 0.505
    R = size * 0.275 * scale
    stroke = int(size * 0.086 * scale)
    d.arc([cx - R, cy - R, cx + R, cy + R], 180, 360, fill=WHITE, width=stroke)
    cw = int(stroke * 1.42)
    ch = int(R * 0.82)
    top = cy - stroke * 0.55
    for x0 in (cx - R, cx + R):
        d.rounded_rectangle([x0 - cw / 2, top, x0 + cw / 2, top + ch],
                            radius=cw / 2.35, fill=WHITE)


def rounded(img, radius_ratio=0.225):
    size = img.size[0]
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1],
                                           radius=int(size * radius_ratio), fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def save(img, path, px):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.resize((px, px), Image.LANCZOS).save(path, 'PNG')


def main():
    full = rounded(gradient(S))
    draw_glyph(full, 1.0)

    fg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    draw_glyph(fg, 0.80)

    for name, px in [('mipmap-mdpi', 48), ('mipmap-hdpi', 72), ('mipmap-xhdpi', 96),
                     ('mipmap-xxhdpi', 144), ('mipmap-xxxhdpi', 192)]:
        save(full, os.path.join(BASE, name, 'ic_launcher.png'), px)

    for name, px in [('mipmap-mdpi', 108), ('mipmap-hdpi', 162), ('mipmap-xhdpi', 216),
                     ('mipmap-xxhdpi', 324), ('mipmap-xxxhdpi', 432)]:
        save(fg, os.path.join(BASE, name, 'ic_launcher_fg.png'), px)

    # 预览用（不打包）
    full.resize((256, 256), Image.LANCZOS).save(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon_preview.png'))
    print('icons ok')


if __name__ == '__main__':
    main()
