"""Android launcher icons + splash screens from build/icon.png and build/mark.png (needs Pillow)."""
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), '..')
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
BG = (11, 20, 26, 255)
tile = Image.open(os.path.join(ROOT, 'build', 'icon.png')).convert('RGBA')
mark = Image.open(os.path.join(ROOT, 'build', 'mark.png')).convert('RGBA')

def centered(size, scale, bg=None):
    img = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
    m = mark.resize((round(size * scale),) * 2, Image.LANCZOS)
    img.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return img

for d, k in {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
    out = os.path.join(RES, f'mipmap-{d}')
    s = round(48 * k)
    tile.resize((s, s), Image.LANCZOS).save(os.path.join(out, 'ic_launcher.png'))
    r = centered(s, 0.95, BG)
    mask = Image.new('L', (s, s), 0); ImageDraw.Draw(mask).ellipse((0, 0, s - 1, s - 1), fill=255)
    rr = Image.new('RGBA', (s, s), (0, 0, 0, 0)); rr.paste(r, (0, 0), mask)
    rr.save(os.path.join(out, 'ic_launcher_round.png'))
    f = round(108 * k)
    centered(f, 0.72).save(os.path.join(out, 'ic_launcher_foreground.png'))

with open(os.path.join(RES, 'values', 'ic_launcher_background.xml'), 'w') as fh:
    fh.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B141A</color>\n</resources>\n')

for d in os.listdir(RES):
    p = os.path.join(RES, d, 'splash.png')
    if d.startswith('drawable') and os.path.exists(p):
        w, h = Image.open(p).size
        img = Image.new('RGBA', (w, h), BG)
        m = mark.resize((round(min(w, h) * 0.32),) * 2, Image.LANCZOS)
        img.alpha_composite(m, ((w - m.width) // 2, (h - m.height) // 2))
        img.convert('RGB').save(p)
print('android icons and splash screens written')
