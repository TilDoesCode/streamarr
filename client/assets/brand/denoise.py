# Replaces Chromium's gradient dither with a smooth background (logo and wordmark kept); PNGs shrink ~8x.
import sys
from PIL import Image, ImageChops, ImageFilter

def background(img, mask, block):
    # Smooth background from pixels outside `mask` (L, 255 = foreground).
    w, h = img.size
    sw, sh = max(1, round(w / block)), max(1, round(h / block))
    rgba = img.convert('RGBA')
    rgba.putalpha(ImageChops.invert(mask))
    small = rgba.resize((sw, sh), Image.BOX)
    px = small.load()
    # Fill blocks without background by averaging filled neighbours until none are left.
    while True:
        empty = [(x, y) for y in range(sh) for x in range(sw) if px[x, y][3] < 64]
        if not empty: break
        updates = {}
        for x, y in empty:
            acc = [0, 0, 0, 0]
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < sw and 0 <= ny < sh and px[nx, ny][3] >= 64:
                        r, g, b, a = px[nx, ny]; acc[0] += r; acc[1] += g; acc[2] += b; acc[3] += 1
            if acc[3]: updates[(x, y)] = (acc[0] // acc[3], acc[1] // acc[3], acc[2] // acc[3], 255)
        if not updates: break
        for k, v in updates.items(): px[k] = v
    small = small.convert('RGB')
    return small.resize((w, h), Image.BICUBIC)

def foreground(img, bg, threshold, grow):
    diff = ImageChops.difference(img, bg).convert('RGB')
    r, g, b = diff.split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v > threshold else 0)
    return m.filter(ImageFilter.MaxFilter(grow * 2 + 1)) if grow else m

def denoise(src, dst, block, threshold=4, grow=3):
    img = Image.open(src).convert('RGB')
    mask = Image.new('L', img.size, 0)
    bg = background(img, mask, block)
    for _ in range(2):
        mask = foreground(img, bg, threshold, grow + 3)
        bg = background(img, mask, block)
    mask = foreground(img, bg, threshold, grow)
    out = Image.composite(img, bg, mask)
    out.save(dst, optimize=True, compress_level=9)


if __name__ == '__main__':
    for path in sys.argv[1:]:
        denoise(path, path, 4)
