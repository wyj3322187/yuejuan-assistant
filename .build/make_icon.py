# 生成应用图标：深墨蓝底 + 鎏金“阅”字，与界面顶栏品牌标一致
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

S = 1024
W = S * 3
OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))

def base():
    grad = Image.new('RGB', (1, W))
    top, bot = (26, 52, 87), (7, 17, 31)
    for y in range(W):
        t = y / (W - 1)
        # 轻微提亮上半段，作出绸面反光
        k = t * t * (3 - 2 * t)
        grad.putpixel((0, y), lerp(top, bot, k))
    img = grad.resize((W, W)).convert('RGBA')
    mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.215), fill=255)
    img.putalpha(mask)

    d = ImageDraw.Draw(img, 'RGBA')
    inset = int(W * 0.052)
    r = int(W * 0.175)
    d.rounded_rectangle([inset, inset, W - inset, W - inset], radius=r,
                        outline=(200, 166, 106, 205), width=max(2, int(W * 0.0105)))
    inset2 = int(W * 0.078)
    d.rounded_rectangle([inset2, inset2, W - inset2, W - inset2], radius=int(r * 0.88),
                        outline=(200, 166, 106, 70), width=max(1, int(W * 0.0035)))

    # 中心柔光
    glow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W * 0.18, W * 0.14, W * 0.82, W * 0.86], fill=(200, 166, 106, 34))
    glow = glow.filter(ImageFilter.GaussianBlur(int(W * 0.09)))
    img.alpha_composite(glow)

    # 顶部高光
    hi = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hi)
    hd.ellipse([-W * 0.25, -W * 0.55, W * 1.25, W * 0.36], fill=(255, 255, 255, 16))
    hi = hi.filter(ImageFilter.GaussianBlur(int(W * 0.05)))
    img.alpha_composite(hi)
    return img

def draw_char(font_path, out_name):
    img = base()
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(font_path, int(W * 0.60))
    ch = '阅'
    box = d.textbbox((0, 0), ch, font=font)
    x = (W - (box[2] - box[0])) / 2 - box[0]
    y = (W - (box[3] - box[1])) / 2 - box[1] - W * 0.012
    # 投影
    sh = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.text((x, y + W * 0.014), ch, font=font, fill=(0, 0, 0, 120))
    sh = sh.filter(ImageFilter.GaussianBlur(int(W * 0.012)))
    img.alpha_composite(sh)
    # 金字：主色 + 顶部亮面
    d.text((x, y), ch, font=font, fill=(231, 199, 132, 255))
    d.text((x, y), ch, font=font, fill=(250, 234, 196, 70))
    out = img.resize((S, S), Image.LANCZOS)
    out.save(os.path.join(OUT, out_name))
    return out

def seal_variant():
    img = base()
    side = int(W * 0.655)
    x0 = (W - side) // 2
    box = [x0, x0, x0 + side, x0 + side]
    seal = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    sd = ImageDraw.Draw(seal)
    # 鎏金渐变
    g = Image.new('RGB', (1, side))
    for y in range(side):
        t = y / (side - 1)
        c = lerp((243, 227, 184), (169, 130, 63), t * t * (3 - 2 * t))
        g.putpixel((0, y), c)
    g = g.resize((side, side)).convert('RGBA')
    m = Image.new('L', (side, side), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, side - 1, side - 1], radius=int(side * 0.215), fill=255)
    g.putalpha(m)
    seal.alpha_composite(g)
    d2 = ImageDraw.Draw(seal, 'RGBA')
    d2.rounded_rectangle([1, 1, side - 2, side - 2], radius=int(side * 0.215),
                         outline=(255, 255, 255, 95), width=max(2, int(side * 0.008)))
    # 内阴影感
    d2.rounded_rectangle([side * 0.035, side * 0.035, side * 0.965, side * 0.965], radius=int(side * 0.19),
                         outline=(90, 60, 15, 60), width=max(1, int(side * 0.006)))
    sh = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    sdw = ImageDraw.Draw(sh)
    sdw.rounded_rectangle([x0, x0 + W * 0.012, x0 + side, x0 + side + W * 0.012], radius=int(side * 0.215), fill=(0, 0, 0, 120))
    sh = sh.filter(ImageFilter.GaussianBlur(int(W * 0.016)))
    img.alpha_composite(sh)
    img.alpha_composite(seal, (x0, x0))
    font = ImageFont.truetype(r'C:\Windows\Fonts\simkai.ttf', int(side * 0.62))
    ch = '阅'
    d = ImageDraw.Draw(img)
    box2 = d.textbbox((0, 0), ch, font=font)
    cx = x0 + (side - (box2[2] - box2[0])) / 2 - box2[0]
    cy = x0 + (side - (box2[3] - box2[1])) / 2 - box2[1] - side * 0.012
    d.text((cx, cy + side * 0.012), ch, font=font, fill=(0, 0, 0, 55))
    d.text((cx, cy), ch, font=font, fill=(21, 35, 58, 255))
    return img.resize((S, S), Image.LANCZOS)

a = draw_char(r'C:\Windows\Fonts\simkai.ttf', '.build/icon_kai.png')
c = seal_variant(); c.save(os.path.join(OUT, '.build/icon_seal.png'))

prev = Image.new('RGB', (S * 2 + 72, S + 48), (238, 242, 247))
prev.paste(a, (24, 24), a)
prev.paste(c, (S + 48, 24), c)
prev.resize((720, 372), Image.LANCZOS).save(os.path.join(OUT, '.build/icon_preview.png'))

sizes = [256, 128, 64, 48, 40, 32, 24, 20, 16]
c.save(os.path.join(OUT, 'app.ico'), sizes=[(x, x) for x in sizes])
# 小尺寸预览：放大看 16/24/32/48 是否还认得出
small = Image.new('RGB', (16 + 24 + 32 + 48 + 5 * 18 + 40, 48 + 40), (238, 242, 247))
x = 20
for sz in (16, 24, 32, 48):
    im = c.resize((sz, sz), Image.LANCZOS)
    y = 20 + (48 - sz) // 2
    small.paste(im, (x, y), im)
    x += sz + 18
small.resize((small.width * 3, small.height * 3), Image.NEAREST).save(os.path.join(OUT, '.build/icon_small.png'))
print('ok', os.path.getsize(os.path.join(OUT, 'app.ico')))
