# -*- coding: utf-8 -*-
"""把三个渲染层的 CSS 改造成可切换主题：
1) rgba(255,255,255,a) -> rgba(var(--ink),a)
2) 少量写死的浅色文字 -> 语义变量（--text-main / --accent-text / --ok-text / --danger-text / --warn-text / --accent2-text / --text-strong）
3) 气泡的卡片底色 -> --card-1 / --card-2
不改动的：纯装饰的深色阴影 rgba(0,0,0,x)、品牌色高亮色值（#67e8f9 等）
"""
import io, re, sys

FILES = [
    'src/renderer/settings/settings.css',
    'src/renderer/bubble/bubble.css',
    'src/renderer/menu/menu.css',
]

SIMPLE = {
    '#e8edf7': 'var(--text-main)',
    '#eef3fb': 'var(--text-main)',
    '#e8fbff': 'var(--accent-text)',
    '#e6feff': 'var(--accent-text)',
    '#d7fbff': 'var(--accent-text)',
    '#e9feff': 'var(--accent-text)',
    '#cffafe': 'var(--accent-text)',
    '#bbf7d0': 'var(--ok-text)',
    '#fecdd3': 'var(--danger-text)',
    '#fde68a': 'var(--warn-text)',
    '#fcd34d': 'var(--warn-text)',
    '#fbbf24': 'var(--warn-text)',
    '#ddd6fe': 'var(--accent2-text)',
    '#fff': 'var(--text-strong)',
    '#ffffff': 'var(--text-strong)',
}

BUBBLE_EXTRA = {
    'rgba(22, 26, 40, 0.93)': 'var(--card-1)',
    'rgba(12, 15, 24, 0.95)': 'var(--card-2)',
}

def patch(path):
    with io.open(path, encoding='utf-8') as f:
        css = f.read()
    before = css

    css = re.sub(r'rgba\(\s*255\s*,\s*255\s*,\s*255\s*,', 'rgba(var(--ink),', css)
    for k, v in SIMPLE.items():
        css = re.sub(r'#' + k[1:] + r'\b', v, css, flags=re.IGNORECASE)
    if path.endswith('bubble.css'):
        for k, v in BUBBLE_EXTRA.items():
            css = css.replace(k, v)

    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(css)
    print('%-42s %6d -> %6d bytes, ink=%d' % (path, len(before), len(css), css.count('var(--ink)')))

for p in FILES:
    patch(p)
print('done')
