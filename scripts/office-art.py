#!/usr/bin/env python3
"""Prepara el arte de la Oficina (public/office/) a partir de los dibujos hechos con fal.

Uso: python3 scripts/office-art.py <carpeta-de-origen> [carpeta-de-salida]

La carpeta de origen trae, en PNG o WebP y todos del mismo tamaño (16:9):
  salon            el salón con el escritorio de Claude Bot y la pizarra
  sala             la sala de un grupo, vacía
  sala-escritorio  la misma sala con un escritorio y su silla al centro
  jefe-mascara     máscara del escritorio de Claude Bot (blanco = escritorio) sobre «salon»
  escritorio-mascara, silla-mascara   máscaras del escritorio y la silla sobre «sala-escritorio»

Escribe salon.webp, sala.webp, jefe.webp, escritorio.webp, silla.webp y arte.json: el rectángulo de cada
recorte en coordenadas del mundo (2752 × 1536), que es como los ubica public/office.js.
Necesita Pillow.
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageFilter

WORLD = (2752, 1536)
NAMES = ["salon", "sala", "sala-escritorio", "jefe-mascara", "escritorio-mascara", "silla-mascara"]


def load(folder: Path, name: str) -> Image.Image:
    for ext in (".png", ".webp", ".jpg"):
        path = folder / f"{name}{ext}"
        if path.exists():
            return Image.open(path)
    raise SystemExit(f"Falta {name}.png (o .webp) en {folder}")


def alpha_from_mask(mask: Image.Image) -> Image.Image:
    """Luminancia de la máscara como alfa, limpiando el ruido de la compresión y suavizando el borde."""
    gray = mask.convert("L")
    clean = gray.point(lambda v: 0 if v < 24 else 255 if v > 232 else int((v - 24) * 255 / 208))
    return clean.filter(ImageFilter.GaussianBlur(radius=max(0.6, gray.width / 2752)))


def cutout(picture: Image.Image, mask: Image.Image, pad: int) -> tuple[Image.Image, list[int]]:
    alpha = alpha_from_mask(mask.resize(picture.size, Image.LANCZOS))
    rgba = picture.convert("RGB").copy()
    rgba.putalpha(alpha)
    box = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    if not box:
        raise SystemExit("La máscara está vacía.")
    left, top, right, bottom = box
    left, top = max(0, left - pad), max(0, top - pad)
    right, bottom = min(picture.width, right + pad), min(picture.height, bottom + pad)
    scale = WORLD[0] / picture.width
    rect = [round(left * scale), round(top * scale), round((right - left) * scale), round((bottom - top) * scale)]
    return rgba.crop((left, top, right, bottom)), rect


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    source = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "public" / "office"
    out.mkdir(parents=True, exist_ok=True)
    images = {name: load(source, name) for name in NAMES}
    width, height = images["salon"].size
    if abs(width / height - WORLD[0] / WORLD[1]) > 0.01:
        raise SystemExit(f"Los dibujos deben ser 16:9 como el mundo ({WORLD[0]}×{WORLD[1]}); salon mide {width}×{height}.")
    pad = max(2, round(width / 400))
    quality = 86 if width > 1600 else 92

    for name in ("salon", "sala"):
        images[name].convert("RGB").resize((width, height), Image.LANCZOS).save(out / f"{name}.webp", quality=quality, method=6)

    pieces = {
        "jefe": cutout(images["salon"], images["jefe-mascara"], pad),
        "escritorio": cutout(images["sala-escritorio"], images["escritorio-mascara"], pad),
        "silla": cutout(images["sala-escritorio"], images["silla-mascara"], pad),
    }
    manifest = {"world": list(WORLD), "source": [width, height], "pieces": {}}
    for name, (picture, rect) in pieces.items():
        picture.save(out / f"{name}.webp", quality=quality, method=6, exact=True)
        manifest["pieces"][name] = rect
    (out / "arte.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
