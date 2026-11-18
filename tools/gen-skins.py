"""从素材目录生成内置悬浮球皮肤（WebP base64，内联进 src/shared/art.ts）。

用法：
    python tools/gen-skins.py [素材目录]

素材是透明背景的角色抠图，生成的皮肤**保留透明通道**：悬浮球上角色浮在游戏画面上，
只有角色本身可见，圆内其余区域完全透明。
注意：角色只铺到画布的 88%，头顶部件不会被切；球上另外做底部渐隐，避免素材的裁断边露出来。
设置页的预览和色板会在图片下面垫一层深色底盘，所以那边看起来是完整的圆形徽章。
"""
import base64
import io
import sys
from pathlib import Path

from PIL import Image

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"C:\Users\jiangchengrui\Desktop\ai")
OUT = Path(__file__).resolve().parent.parent / "src" / "shared" / "art.ts"
SIZE = 512
QUALITY = 82

# 文件名 → id（保持稳定，避免用户配置失效）
IDS = {
    "大小姐": "daxiaojie",
    "大肥鱼": "dafiyu",
    "极其猫": "jiqimao",
    "龙女仆": "longnvpu",
}
# 展示顺序：默认皮肤排第一位
ORDER = ["大肥鱼", "大小姐", "极其猫", "龙女仆"]
DEFAULT_ID = "builtin:dafiyu"


def fit_art(art: Image.Image, size: int) -> Image.Image:
    """按不透明区域把角色居中放大，铺满整张画布。"""
    alpha = art.getchannel("A")
    bbox = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    if bbox:
        art = art.crop(bbox)
    w, h = art.size
    # 铺到画布的 88%：留出边距，耳朵/呆毛不会被圆形边界切到
    target = size * 0.88
    scale = min(target / w, target / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    art = art.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(art, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def main() -> None:
    files = sorted(p for p in SRC.glob("*.png"))
    if not files:
        raise SystemExit(f"没有找到素材：{SRC}")
    weight = {name: i for i, name in enumerate(ORDER)}
    files.sort(key=lambda p: (weight.get(p.stem, 99), p.stem))

    disc = None
    entries = []
    for path in files:
        label = path.stem
        slug = IDS.get(label)
        if not slug:
            raise SystemExit(f"未知素材名：{label}（请在脚本的 IDS 里补一个 id）")
        art = Image.open(path).convert("RGBA")
        # 原图整张缩到 512：悬浮球上角色铺满球体，和最初的效果一致。
        # 在预乘 alpha 下缩放，避免透明区的彩色 RGB 混到可见边缘。
        art = art.convert("RGBa").resize((SIZE, SIZE), Image.LANCZOS).convert("RGBA")
        buf = io.BytesIO()
        # 保留透明通道：悬浮球上要能看到后面的游戏画面
        art.save(buf, format="WEBP", quality=QUALITY, method=6, lossless=False, alpha_quality=95)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        entries.append({"id": f"builtin:{slug}", "label": label, "b64": b64})
        print(f"  {label}: {len(buf.getvalue()) / 1024:.0f} KB -> builtin:{slug}")

    lines = [
        "/* 内置悬浮球皮肤（由 tools/gen-skins.py 从素材生成，勿手改） */",
        "",
        "export interface BuiltinSkin {",
        "  id: string",
        "  label: string",
        "}",
        "",
        f"export const DEFAULT_SKIN = '{DEFAULT_ID}'",
        "",
        "const RAW: { id: string; label: string; b64: string }[] = [",
    ]
    for e in entries:
        lines.append("  {")
        lines.append(f"    id: '{e['id']}',")
        lines.append(f"    label: '{e['label']}',")
        lines.append(f"    b64: '{e['b64']}'")
        lines.append("  },")
    lines += [
        "]",
        "",
        "export const BUILTIN_SKINS: BuiltinSkin[] = RAW.map((s) => ({ id: s.id, label: s.label }))",
        "",
        "const DATA: Record<string, string> = Object.fromEntries(RAW.map((s) => [s.id, s.b64]))",
        "",
        "/** 皮肤 id → 可直接用于 background-image 的 data URL */",
        "export function builtinSkinUrl(id: string): string {",
        f"  const b64 = DATA[id] ?? DATA[DEFAULT_SKIN]",
        "  return `data:image/webp;base64,${b64}`",
        "}",
        "",
        "export function resolveBallImage(image: string): string {",
        "  if (!image) return builtinSkinUrl(DEFAULT_SKIN)",
        "  if (image.startsWith('builtin:')) return builtinSkinUrl(image)",
        "  return image",
        "}",
        "",
    ]
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"写入 {OUT}（{OUT.stat().st_size / 1024:.0f} KB）")


if __name__ == "__main__":
    main()
