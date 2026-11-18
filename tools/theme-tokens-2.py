# -*- coding: utf-8 -*-
"""亮色主题第二轮：把"浅灰文字"统一成语义变量，避免白底上看不清。

- rgba(148,163,184,a) -> rgba(var(--muted-ink),a)
- rgba(203,213,225,a) / rgba(226,232,240,a) -> rgba(var(--text2-ink),a)
- 其余浅灰 hex：按亮度分成 --text-2（亮）与 --muted（暗）
"""
import io, re

FILES = ['src/renderer/settings/settings.css', 'src/renderer/bubble/bubble.css']

HEXES = [
    '#b8c3d4', '#b9c4d6', '#b9c6d8', '#c8d4e4', '#d8e6f5', '#d6e9f7',
    '#e5edf9', '#e7eef9', '#9aa8bd', '#9fadc2', '#9fb0c6', '#93a1b5',
    '#7c8ba1', '#7f93ab', '#75859c', '#6b7789', '#5a6779', '#64748b',
    '#cbd5e1', '#e2e8f0',
]

def brightness(hex_color):
    h = hex_color.lstrip('#')
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

def patch(path):
    css = io.open(path, encoding='utf-8').read()
    before = css
    css = re.sub(r'rgba\(\s*148\s*,\s*163\s*,\s*184\s*,', 'rgba(var(--muted-ink),', css)
    css = re.sub(r'rgba\(\s*203\s*,\s*213\s*,\s*225\s*,', 'rgba(var(--text2-ink),', css)
    css = re.sub(r'rgba\(\s*226\s*,\s*232\s*,\s*240\s*,', 'rgba(var(--text2-ink),', css)

    mapped = 0
    for hx in HEXES:
        var = '--text-2' if brightness(hx) >= 0.72 else '--muted'
        pattern = re.compile(re.escape(hx) + r'\b', re.IGNORECASE)
        css, n = pattern.subn('var(%s)' % var, css)
        mapped += n

    io.open(path, 'w', encoding='utf-8', newline='\n').write(css)
    print('%-42s mapped %d hex, %d bytes' % (path, mapped, len(before)))

for p in FILES:
    patch(p)
print('done')
