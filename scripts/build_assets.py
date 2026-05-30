from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from io import BytesIO
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from rembg import new_session, remove


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "public" / "assets"
RAW_DIR = ROOT / "asset_sources" / "raw"
MANIFEST_PATH = ASSET_DIR / "blocks.json"


PEOPLE = [
    {
        "id": "person-sam",
        "name": "Sam Altman",
        "url": "https://commons.wikimedia.org/wiki/Special:Redirect/file/Sam_Altman_November_2022.jpg?width=900",
        "file": "person-sam.jpg",
        "displayHeight": 146,
    },
    {
        "id": "person-jensen",
        "name": "Jensen Huang",
        "url": "https://commons.wikimedia.org/wiki/Special:Redirect/file/Nvidia_CEO_Jensen_Huang_gestikuliert.jpg?width=900",
        "file": "person-jensen.jpg",
        "displayHeight": 158,
    },
    {
        "id": "person-elon",
        "name": "Elon Musk",
        "url": "https://i.kym-cdn.com/photos/images/newsfeed/002/919/325/e79.png",
        "file": "person-elon.png",
        "crop": [360, 105, 703, 562],
        "displayHeight": 190,
    },
    {
        "id": "person-demis",
        "name": "Demis Hassabis",
        "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/b/bd/Demis_Hassabis_Royal_Society.jpg/500px-Demis_Hassabis_Royal_Society.jpg",
        "file": "person-demis.jpg",
        "displayHeight": 158,
    },
    {
        "id": "person-dario",
        "name": "Dario Amodei",
        "url": "https://commons.wikimedia.org/wiki/Special:Redirect/file/Dario_Amodei_at_TechCrunch_Disrupt_2023_02.jpg?width=900",
        "file": "person-dario.jpg",
        "displayHeight": 162,
    },
    {
        "id": "person-andrej",
        "name": "Andrej Karpathy",
        "url": "https://commons.wikimedia.org/wiki/Special:Redirect/file/Andrej_Karpathy%2C_OpenAI.png?width=900",
        "file": "person-andrej.png",
        "displayHeight": 166,
    },
    {
        "id": "person-yann",
        "name": "Yann LeCun",
        "url": "https://commons.wikimedia.org/wiki/Special:Redirect/file/Yann_Lecun_during_a_talk_at_EPFL.jpg?width=900",
        "file": "person-yann.jpg",
        "displayHeight": 160,
    },
    {
        "id": "person-ilya",
        "name": "Ilya Sutskever",
        "url": "https://commons.wikimedia.org/wiki/Special:Redirect/file/Democratizing_Deep_Learning_with_Nervana_and_Google_Brain_%2815105407149%29_%28cropped%29.jpg?width=900",
        "file": "person-ilya.jpg",
        "displayHeight": 172,
    },
    {
        "id": "person-ray",
        "name": "Ray Kurzweil",
        "url": "https://commons.wikimedia.org/wiki/Special:Redirect/file/Ray-Kurzweil-at-SXSW_2024_5.jpg?width=900",
        "file": "person-ray.jpg",
        "displayHeight": 164,
    },
    {
        "id": "person-hinton",
        "name": "Geoffrey Hinton",
        "url": "https://commons.wikimedia.org/wiki/Special:Redirect/file/Geoffrey_Hinton_at_2024_Nobel_Prize_Conference_5.jpg?width=900",
        "file": "person-hinton.jpg",
        "displayHeight": 160,
    },
]

LOGOS = [
    {"id": "logo-openai", "name": "OpenAI", "file": "logo-openai.png", "displayHeight": 132},
    {"id": "logo-gemini", "name": "Gemini", "file": "logo-gemini.png", "displayHeight": 126},
    {"id": "logo-grok", "name": "Grok", "file": "logo-grok.png", "displayHeight": 134},
    {"id": "logo-claude", "name": "Claude", "file": "logo-claude.png", "displayHeight": 136},
    {"id": "logo-deepseek", "name": "DeepSeek", "file": "logo-deepseek.png", "displayHeight": 136},
]


def run_curl(url: str, out_path: Path) -> None:
    if out_path.exists() and out_path.stat().st_size > 8000:
        return
    args = [
        "curl.exe" if os.name == "nt" else "curl",
        "-L",
        "--retry",
        "2",
        "--max-time",
        "60",
        "-s",
        "-o",
        str(out_path),
        url,
    ]
    subprocess.run(args, check=True)
    if not out_path.exists() or out_path.stat().st_size < 1000:
        raise RuntimeError(f"download failed or too small: {url}")


def resize_for_cutout(image: Image.Image, max_side: int = 840) -> Image.Image:
    image = image.convert("RGBA")
    scale = min(1.0, max_side / max(image.size))
    if scale < 1.0:
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    return image


def trim_alpha(image: Image.Image, padding: int = 12) -> Image.Image:
    rgba = np.array(image.convert("RGBA"))
    alpha = rgba[:, :, 3]
    ys, xs = np.where(alpha > 14)
    if not len(xs):
        return image
    left = max(0, int(xs.min()) - padding)
    top = max(0, int(ys.min()) - padding)
    right = min(image.width, int(xs.max()) + padding + 1)
    bottom = min(image.height, int(ys.max()) + padding + 1)
    return image.crop((left, top, right, bottom))


def clean_visual_alpha(image: Image.Image) -> Image.Image:
    rgba = np.array(image.convert("RGBA"))
    alpha = rgba[:, :, 3]
    _, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > 8).astype(np.uint8), 8)
    cleaned = np.zeros_like(alpha)
    total_area = alpha.shape[0] * alpha.shape[1]
    min_area = max(18, int(total_area * 0.00018))
    for label in range(1, stats.shape[0]):
        if stats[label, cv2.CC_STAT_AREA] >= min_area:
            cleaned[labels == label] = alpha[labels == label]
    rgba[:, :, 3] = cleaned
    return Image.fromarray(rgba, "RGBA")


def stable_outline(image: Image.Image, max_vertices: int = 24) -> list[dict[str, float]]:
    rgba = np.array(image.convert("RGBA"))
    alpha = rgba[:, :, 3]
    mask = (alpha > 28).astype(np.uint8) * 255
    short_side = max(1, min(mask.shape[:2]))
    kernel_size = max(3, int(short_side * 0.018) | 1)
    kernel = np.ones((kernel_size, kernel_size), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    mask = cv2.dilate(mask, kernel, iterations=1)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        w, h = image.size
        return [
            {"x": w * 0.2, "y": h * 0.2},
            {"x": w * 0.8, "y": h * 0.2},
            {"x": w * 0.8, "y": h * 0.8},
            {"x": w * 0.2, "y": h * 0.8},
        ]

    contour = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(contour, True)
    epsilon = max(1.4, perimeter * 0.012)
    approx = cv2.approxPolyDP(contour, epsilon, True)
    while len(approx) > max_vertices:
        epsilon *= 1.18
        approx = cv2.approxPolyDP(contour, epsilon, True)

    points = approx.reshape(-1, 2).astype(float)
    if len(points) < 5:
        hull = cv2.convexHull(contour)
        points = cv2.approxPolyDP(hull, max(1.0, perimeter * 0.01), True).reshape(-1, 2).astype(float)

    # Remove microscopic zigzags that can make Matter.js decomposition jittery.
    cleaned: list[np.ndarray] = []
    min_dist = max(5.0, short_side * 0.025)
    for p in points:
        if not cleaned or np.linalg.norm(p - cleaned[-1]) >= min_dist:
            cleaned.append(p)
    if len(cleaned) > 2 and np.linalg.norm(cleaned[0] - cleaned[-1]) < min_dist:
        cleaned.pop()
    points = np.array(cleaned if len(cleaned) >= 5 else points)

    return [{"x": round(float(x), 2), "y": round(float(y), 2)} for x, y in points]


def process_person(item: dict, session) -> dict:
    raw_path = RAW_DIR / item["file"]
    run_curl(item["url"], raw_path)
    image = Image.open(raw_path).convert("RGBA")
    if "crop" in item:
        image = image.crop(tuple(item["crop"]))
    image = resize_for_cutout(image)
    buf = BytesIO()
    image.save(buf, format="PNG")
    cutout = Image.open(BytesIO(remove(buf.getvalue(), session=session))).convert("RGBA")
    cutout = clean_visual_alpha(trim_alpha(cutout))
    cutout = trim_alpha(cutout)
    out_path = ASSET_DIR / f"{item['id']}.png"
    cutout.save(out_path)
    return {
        "id": item["id"],
        "name": item["name"],
        "type": "person",
        "src": f"/assets/{item['id']}.png",
        "width": cutout.width,
        "height": cutout.height,
        "displayHeight": item["displayHeight"],
        "vertices": stable_outline(cutout),
    }


def process_logo(item: dict) -> dict:
    raw_path = RAW_DIR / item["file"]
    if not raw_path.exists():
        raise FileNotFoundError(f"run scripts/generate_logos.mjs first: {raw_path}")
    image = Image.open(raw_path).convert("RGBA")
    image = clean_visual_alpha(trim_alpha(image, padding=18))
    out_path = ASSET_DIR / f"{item['id']}.png"
    image.save(out_path)
    return {
        "id": item["id"],
        "name": item["name"],
        "type": "logo",
        "src": f"/assets/{item['id']}.png",
        "width": image.width,
        "height": image.height,
        "displayHeight": item["displayHeight"],
        "vertices": stable_outline(image, max_vertices=18),
    }


def write_assets_doc(items: list[dict]) -> None:
    lines = [
        "# Assets",
        "",
        "Local transparent PNG cutouts live in `public/assets`. Physics polygons are generated from each PNG alpha channel and stored in `public/assets/blocks.json`.",
        "",
        "## People",
    ]
    for item in PEOPLE:
        lines.append(f"- {item['name']}: {item['url']}")
    lines.extend(["", "## Logos", ""])
    lines.extend(
        [
            "- OpenAI symbol: https://commons.wikimedia.org/wiki/File:OpenAI_logo_2025_(symbol).svg",
            "- Gemini mark: Simple Icons Google Gemini, source https://gemini.google.com",
            "- Grok mark without text: https://unpkg.com/@lobehub/icons-static-svg@latest/icons/grok.svg",
            "- Claude mark: Simple Icons Claude, source https://claude.ai",
            "- DeepSeek mark: Simple Icons DeepSeek, source https://www.deepseek.com",
        ]
    )
    (ROOT / "ASSETS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    session = new_session("u2net_human_seg")
    blocks = []
    for item in PEOPLE:
        print(f"person: {item['name']}")
        blocks.append(process_person(item, session))
    for item in LOGOS:
        print(f"logo: {item['name']}")
        blocks.append(process_logo(item))
    MANIFEST_PATH.write_text(json.dumps(blocks, ensure_ascii=False, indent=2), encoding="utf-8")
    write_assets_doc(blocks)


if __name__ == "__main__":
    main()
