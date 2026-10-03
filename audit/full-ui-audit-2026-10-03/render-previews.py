"""Paint production ANSI frames, preserving the host theme's foreground/background."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json, re, unicodedata, html
root = Path(__file__).parent
frames = json.loads((root/'rendered-frames.json').read_text())
font_path = '/nix/store/b7ybgcl00ak8q66bc0w15vfnyly4g13k-hack-font-3.003/share/fonts/truetype/Hack-Regular.ttf'
font = ImageFont.truetype(font_path, 14)
cell, line_height = round(font.getlength('M')), 21
ansi = re.compile(r'\x1b\[([0-9;]*)m')

def segments(line, appearance):
    fg_default = '#dfe3ed' if appearance == 'dark' else '#242938'
    fg, bg = fg_default, None
    cursor = 0
    for match in ansi.finditer(line):
        yield line[cursor:match.start()], fg, bg
        codes = [int(x or 0) for x in match[1].split(';')]
        index = 0
        while index < len(codes):
            code = codes[index]
            if code == 0: fg, bg = fg_default, None
            elif code == 39: fg = fg_default
            elif code == 49: bg = None
            elif code in (38, 48) and index + 4 < len(codes) and codes[index + 1] == 2:
                color = '#%02x%02x%02x' % tuple(codes[index + 2:index + 5])
                if code == 38: fg = color
                else: bg = color
                index += 4
            index += 1
        cursor = match.end()
    yield line[cursor:], fg, bg

def paint(draw, frame, x, y):
    background = '#11151e' if frame['theme'] == 'dark' else '#f7f8fc'
    draw.rectangle((x, y, x+frame['width']*cell+24, y+(len(frame['lines'])+2)*line_height), fill=background)
    for row, line in enumerate(frame['lines']):
        col = 0
        for text, foreground, bg in segments(line, frame['theme']):
            for char in text:
                cells = 0 if unicodedata.combining(char) or char in ('\ufe0f', '\u200d') else 2 if unicodedata.east_asian_width(char) in ('W','F') else 1
                left, top = x+12+col*cell, y+12+row*line_height
                if bg: draw.rectangle((left, top, left+cells*cell, top+line_height), fill=bg)
                draw.text((left, top), char, font=font, fill=foreground)
                col += cells

def sheet(name, specs):
    selected = [next(f for f in frames if (f['key'],f['theme'],f['width']) == spec) for spec in specs]
    slot_w = max(f['width'] for f in selected)*cell+64
    slot_h = max(len(f['lines']) for f in selected)*line_height+84
    image = Image.new('RGB', (slot_w*2, slot_h*((len(selected)+1)//2)), '#252d3a')
    draw = ImageDraw.Draw(image)
    for index, frame in enumerate(selected):
        x,y = (index%2)*slot_w+16, (index//2)*slot_h+12
        draw.text((x,y), f"{frame['key']} | {frame['theme']} | {frame['width']} cols", font=font, fill='#ffffff')
        paint(draw, frame, x, y+28)
    image.save(root/name)
sheet('settings-and-review.png', [(key,'dark',80) for key in ['settings-auditor','settings-search','fallback-picker','fallback-order','draft-start','draft-consent']])
sheet('narrow-and-light.png', [('settings-auditor','dark',40),('settings-other','dark',40),('settings-auditor','light',60),('settings-auditor-details','light',60),('draft-consent','dark',40),('draft-end','light',60)])
sheet('lifecycle-cards.png', [(key,'dark',80) for key in ['working','paused','blocked','supervisor-frozen','audit-starting','audit-running','audit-settling','audit-recovery-pending','completed','aborted','queue-only','loop-active','loop-cadence','loop-held','workers','empty']])
blocks=[]
for frame in frames:
    output=[]
    for line in frame['lines']:
        output.append(''.join(f'<span style="color:{fg};'+(f'background:{bg};' if bg else '')+'">'+html.escape(text)+'</span>' for text,fg,bg in segments(line,frame['theme'])))
    bg='#11151e' if frame['theme']=='dark' else '#f7f8fc'
    blocks.append(f'<section><h2>{frame["key"]} · {frame["theme"]} · {frame["width"]} columns</h2><pre style="background:{bg};width:{frame["width"]}ch">'+ '\n'.join(output)+'</pre></section>')
(root/'rendered-gallery.html').write_text('<!doctype html><meta charset="utf-8"><title>GLLA UI audit</title><style>body{background:#252d3a;color:#fff;font:14px monospace;margin:24px}section{margin-bottom:32px}pre{padding:12px;line-height:1.5;overflow:auto}h2{font-size:16px}</style>'+''.join(blocks))
print(f'Painted {len(frames)} production frames, three contact sheets, and an HTML gallery.')
