"""Regenerates app-icon.png (1024x1024). Requires Pillow:  python3 tools/make-icon.py"""
import math, random
from PIL import Image, ImageDraw, ImageFilter

S = 2048            # draw at 2x, downsample for smooth edges
OUT = 1024
random.seed(7)

def radial(size, center, radius, color, alpha):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = layer.load()
    cx, cy = center
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy) / radius
            if d < 1:
                a = int(alpha * (1 - d) ** 1.6)
                px[x, y] = color + (a,)
    return layer

# --- background: deep navy + indigo / cyan glows (matches the app) ---
bg = Image.new("RGBA", (S, S), (11, 13, 20, 255))
small = 512  # compute glows at low res then scale up (fast)
g1 = radial(small, (int(small * .22), int(small * .15)), small * .85, (99, 102, 241), 235).resize((S, S), Image.BICUBIC)
g2 = radial(small, (int(small * .85), int(small * .92)), small * .8, (34, 211, 238), 215).resize((S, S), Image.BICUBIC)
g3 = radial(small, (int(small * .75), int(small * .2)), small * .45, (168, 85, 247), 120).resize((S, S), Image.BICUBIC)
bg = Image.alpha_composite(bg, g1); bg = Image.alpha_composite(bg, g2); bg = Image.alpha_composite(bg, g3)

# --- faint mesh of nodes in the background ---
mesh = Image.new("RGBA", (S, S), (0, 0, 0, 0)); md = ImageDraw.Draw(mesh)
pts = []
for _ in range(16):
    for _try in range(50):
        x, y = random.randint(120, S - 120), random.randint(120, S - 120)
        if math.hypot(x - S / 2, y - S / 2) > 560 and all(math.hypot(x - a, y - b) > 260 for a, b in pts):
            pts.append((x, y)); break
for i, a in enumerate(pts):
    for b in pts[i + 1:]:
        if math.hypot(a[0] - b[0], a[1] - b[1]) < 620:
            md.line([a, b], fill=(255, 255, 255, 38), width=6)
for x, y in pts:
    md.ellipse([x - 16, y - 16, x + 16, y + 16], fill=(255, 255, 255, 120))
bg = Image.alpha_composite(bg, mesh)

# --- the "M": thick rounded polyline with three nodes (peaks + valley) ---
def M_points(scale=1.0):
    cx, cy = S / 2, S / 2 + 40
    w, h = 560 * scale, 520 * scale
    L, R = cx - w / 2, cx + w / 2
    top, bot = cy - h / 2, cy + h / 2
    mid = (cx, cy + h * 0.14)
    return [(L, bot), (L, top), mid, (R, top), (R, bot)], mid, (L, top), (R, top)

pts_m, valley, lt, rt = M_points()
stroke = 150

def draw_m(draw, fill, width):
    draw.line(pts_m, fill=fill, width=width, joint="curve")
    for p in (pts_m[0], pts_m[-1]):
        draw.ellipse([p[0] - width / 2, p[1] - width / 2, p[0] + width / 2, p[1] + width / 2], fill=fill)
    for p in pts_m[1:-1]:
        draw.ellipse([p[0] - width / 2, p[1] - width / 2, p[0] + width / 2, p[1] + width / 2], fill=fill)

glow = Image.new("RGBA", (S, S), (0, 0, 0, 0)); gd = ImageDraw.Draw(glow)
draw_m(gd, (120, 140, 255, 255), stroke + 40)
glow = glow.filter(ImageFilter.GaussianBlur(70))
bg = Image.alpha_composite(bg, glow)

m = Image.new("RGBA", (S, S), (0, 0, 0, 0)); md2 = ImageDraw.Draw(m)
draw_m(md2, (255, 255, 255, 255), stroke)
# soft gradient tint over the white M (top-left cool white -> bottom-right cyan tint)
grad = Image.new("RGBA", (S, S), (0, 0, 0, 0)); gp = grad.load()
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * S)
        gp[x, y] = (int(255 - 70 * t), int(255 - 20 * t), 255, 255)
m_tinted = Image.composite(grad, Image.new("RGBA", (S, S), (0, 0, 0, 0)), m.split()[3])
bg = Image.alpha_composite(bg, m_tinted)

# node dots (dark ring + bright core) at the three vertices -> the "network" motif
d = ImageDraw.Draw(bg)
for (x, y), r in ((lt, 62), (rt, 62), (valley, 62)):
    d.ellipse([x - r - 22, y - r - 22, x + r + 22, y + r + 22], fill=(11, 13, 20, 255))
    d.ellipse([x - r, y - r, x + r, y + r], fill=(34, 211, 238, 255))
    d.ellipse([x - r * .45, y - r * .45, x + r * .45, y + r * .45], fill=(255, 255, 255, 255))

img = bg.resize((OUT, OUT), Image.LANCZOS).convert("RGBA")
img.save("app-icon.png", optimize=True)
print("wrote app-icon.png", img.size)
