# Regenerate the OG link-preview cards (1200x630) from brand.json:
#   og.png                         — main site card
#   printshop-app/printshop-og.png — print shop card
#
#   pip install pillow && python3 scripts/make-og.py
#
# Colors, text and the mascot all come from brand.json, so a brand
# swap only needs this re-run (brand.yml does it automatically).

import json, os, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
brand = json.load(open(os.path.join(ROOT, "brand.json")))
T, OG = brand["theme"], brand["og"]

BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
mono = MONO if os.path.exists(MONO) else BOLD
random.seed(42)

def hexrgb(h):
    n = int(h[1:], 16)
    return ((n >> 16) & 255, (n >> 8) & 255, n & 255)

INK, CARD, ACCENT = hexrgb(T["bg"]), hexrgb(T["card"]), hexrgb(T["accent"])
ACCENT2, SUB, TEXT = hexrgb(T["accent2"]), hexrgb(T["sub"]), hexrgb(T["ink"])

mascot = Image.open(os.path.join(ROOT, brand["ai"]["baseImage"])).convert("RGB")

def matrix_bg(w, h):
    img = Image.new("RGB", (w, h), INK)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(mono, 22)
    glyphs = "01ｱｲｳｴｵｶｷｸ$<>#"
    for col in range(0, w, 24):
        y = random.randint(-40, h)
        for i in range(random.randint(4, 16)):
            a = max(20, 110 - i * 8) / 255
            tint = tuple(int(c * a * 1.6) for c in ACCENT)
            d.text((col, (y + i * 24) % h), random.choice(glyphs), font=f, fill=tint)
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    dim = tuple(int(c * 0.24) for c in ACCENT)
    dimmer = tuple(int(c * 0.15) for c in ACCENT)
    gd.ellipse([w * 0.55, -150, w * 1.15, 320], fill=dim)
    gd.ellipse([-200, h - 260, 380, h + 180], fill=dimmer)
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    img = ImageChops.add(img, glow)
    d = ImageDraw.Draw(img)
    for y in range(0, h, 4):
        d.line([(0, y), (w, y)], fill=(0, 0, 0), width=1)
    return img

def card(headline, sub1, sub2, badge, prompt, out):
    W, H = 1200, 630
    img = matrix_bg(W, H)
    m = mascot.resize((430, 430), Image.LANCZOS)
    fr = Image.new("RGB", (442, 442), ACCENT)
    fr.paste(m, (6, 6))
    img.paste(fr, (W - 442 - 70, (H - 442) // 2))
    f_head = ImageFont.truetype(BOLD, 110)
    f_sub = ImageFont.truetype(BOLD, 40)
    f_tag = ImageFont.truetype(mono, 30)
    f_badge = ImageFont.truetype(mono, 28)
    x = 70
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.text((x, 150), headline, font=f_head, fill=tuple(int(c * 0.55) for c in ACCENT))
    glow = glow.filter(ImageFilter.GaussianBlur(18))
    img = ImageChops.add(img, glow)
    d = ImageDraw.Draw(img)
    d.text((x, 150), headline, font=f_head, fill=ACCENT)
    d.text((x, 290), sub1, font=f_sub, fill=TEXT)
    d.text((x, 355), sub2, font=f_tag, fill=SUB)
    tw = d.textlength(badge, font=f_badge)
    d.rounded_rectangle([x, 450, x + tw + 44, 508], radius=10, fill=CARD, outline=ACCENT, width=3)
    d.text((x + 22, 464), badge, font=f_badge, fill=ACCENT)
    d.text((x, 545), prompt, font=f_tag, fill=ACCENT2)
    img.save(out, optimize=True)
    print("wrote", os.path.relpath(out, ROOT), os.path.getsize(out), "bytes")

card(OG["headline"], OG["sub1"], OG["sub2"], OG["badge"], OG["prompt"],
     os.path.join(ROOT, "og.png"))
card(OG["headline"], OG["printSub1"], OG["printSub2"], OG["printBadge"], OG["prompt"],
     os.path.join(ROOT, "printshop-app", "printshop-og.png"))
