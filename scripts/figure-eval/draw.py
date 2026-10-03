import json, subprocess, sys, os
from PIL import Image, ImageDraw
D = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(f'{D}/compare.json'))
def render(file, page):
    base = f'{D}/_pg'
    subprocess.run(['pdftoppm', '-r', '72', '-f', str(page), '-l', str(page), '-png', '-singlefile', f'{D}/{file}', base], check=True)
    return Image.open(base + '.png').convert('RGB')
def draw(im, figs, title):
    im = im.copy(); d = ImageDraw.Draw(im)
    for f in figs:
        b = f['box']; lab = f['label']
        color = (220, 30, 30) if not lab else ((30, 90, 220) if lab['kind'] == 'figure' else (20, 150, 60))
        d.rectangle([b['left'], b['top'], b['right'], b['bottom']], outline=color, width=3)
        d.rectangle([b['left'], b['top'] - 12, b['left'] + 60, b['top']], fill=color)
        d.text((b['left'] + 3, b['top'] - 12), f"{lab['kind'][:3]} {lab['number']}" if lab else 'unnamed', fill=(255, 255, 255))
    d.rectangle([0, 0, 200, 14], fill=(0, 0, 0)); d.text((4, 2), title, fill=(255, 255, 0))
    return im
def sheet(entries, out, mode='both'):
    tiles = []
    for e in entries:
        im = render(e['file'], e['page'])
        key = f"{e['file']} p{e['page']}"
        if mode in ('both', 'rule'): tiles.append(draw(im, e['ruleBased'], f'RULE {key}'))
        if mode in ('both', 'hybrid'): tiles.append(draw(im, e['hybrid'], f'HYBRID {key}'))
    w = sum(t.width for t in tiles); h = max(t.height for t in tiles)
    s = Image.new('RGB', (w, h), 'white'); x = 0
    for t in tiles: s.paste(t, (x, 0)); x += t.width
    s.save(out)
if __name__ == '__main__':
    keys = sys.argv[2:]
    entries = [e for e in data if f"{e['file']}:{e['page']}" in keys]
    sheet(entries, sys.argv[1])
