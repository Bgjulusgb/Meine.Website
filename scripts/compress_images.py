#!/usr/bin/env python3
"""Komprimiert alle Portfolio-Bilder web-tauglich – in-place, ohne Dateien
umzubenennen oder zu verschieben.

Standard-Verhalten:
- Lange Kante auf max. MAX_EDGE px verkleinern (kleinere Bilder bleiben unverändert groß).
- JPEG mit Qualität QUALITY neu speichern (progressiv, optimiert, EXIF entfernt).
- PNG bleibt PNG (verlustfrei optimiert, ggf. verkleinert) -> Dateiname/Endung bleiben gleich.
- EXIF-Orientierung wird vor dem Verkleinern angewendet (Bild bleibt korrekt gedreht).

Idempotent: Bilder, die bereits klein genug sind (<= MAX_EDGE UND < SKIP_BYTES),
werden übersprungen. Außerdem wird ein Ergebnis nie geschrieben, wenn es größer
wäre als das Original -> mehrfaches Ausführen schadet nicht.

Aufruf:
    python scripts/compress_images.py --dry-run      # nur anzeigen, was passieren würde
    python scripts/compress_images.py                # echt komprimieren (Standard-Ordner)
    python scripts/compress_images.py <ordner> ...   # eigene Ordner angeben
"""
from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from PIL import Image, ImageOps

# ── Konfiguration ────────────────────────────────────────────────────────────
MAX_EDGE = 2048          # lange Kante in px (Web-optimiert)
QUALITY = 82             # JPEG-Qualität
SKIP_BYTES = 600 * 1024  # Bilder kleiner als das + bereits <= MAX_EDGE -> überspringen
JPEG_EXTS = {".jpg", ".jpeg"}
PNG_EXTS = {".png"}
IMAGE_EXTS = JPEG_EXTS | PNG_EXTS
# Ordner, die beim Standard-Lauf nie durchsucht werden (Git, Build-Tools, Templates etc.).
EXCLUDE_DIRS = {".git", ".github", "node_modules", "scripts", "__pycache__", ".venv", "venv"}


def _human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} GB"


def default_roots() -> list[Path]:
    """Gesamtes Repo (Site-Root) + 'das hier nicht benutzen' (eine Ebene darüber).

    Unterordner aus EXCLUDE_DIRS werden in iter_images() ausgefiltert."""
    site_root = Path(__file__).resolve().parent.parent  # .../Meine.Website
    roots = [site_root, site_root.parent / "das hier nicht benutzen"]
    return [r for r in roots if r.is_dir()]


def encode(img: Image.Image, ext: str) -> bytes:
    """Bild in Bytes kodieren (JPEG bzw. PNG) – ohne auf Platte zu schreiben."""
    buf = io.BytesIO()
    if ext in JPEG_EXTS:
        out = img
        if out.mode in ("RGBA", "LA", "P"):
            out = out.convert("RGBA")
            bg = Image.new("RGB", out.size, (255, 255, 255))
            bg.paste(out, mask=out.split()[-1])
            out = bg
        elif out.mode != "RGB":
            out = out.convert("RGB")
        out.save(buf, format="JPEG", quality=QUALITY, optimize=True, progressive=True)
    else:  # PNG
        img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def process_file(path: Path, dry_run: bool) -> tuple[int, int, bool]:
    """Gibt (alte_groesse, neue_groesse, geaendert) zurück."""
    old_size = path.stat().st_size
    ext = path.suffix.lower()

    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)  # Orientierung anwenden
        w, h = im.size
        long_edge = max(w, h)

        # Schon klein genug -> nichts tun
        if long_edge <= MAX_EDGE and old_size < SKIP_BYTES:
            return old_size, old_size, False

        if long_edge > MAX_EDGE:
            scale = MAX_EDGE / long_edge
            im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)

        data = encode(im, ext)

    new_size = len(data)
    # Nie vergrößern (z. B. bereits optimal komprimierte Datei)
    if new_size >= old_size:
        return old_size, old_size, False

    if not dry_run:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)  # atomar ersetzen, Dateiname bleibt exakt gleich
    return old_size, new_size, True


def iter_images(roots: list[Path]):
    for root in roots:
        for p in sorted(root.rglob("*")):
            if not (p.is_file() and p.suffix.lower() in IMAGE_EXTS):
                continue
            # Pfade unterhalb ausgeschlossener Ordner (relativ zum jeweiligen Root) skippen.
            try:
                rel_parts = p.relative_to(root).parts
            except ValueError:
                rel_parts = p.parts
            if any(part in EXCLUDE_DIRS for part in rel_parts[:-1]):
                continue
            yield p


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Portfolio-Bilder web-tauglich komprimieren.")
    ap.add_argument("roots", nargs="*", help="Zu verarbeitende Ordner (Standard: portfolio + 'das hier nicht benutzen').")
    ap.add_argument("--dry-run", action="store_true", help="Nur anzeigen, nichts schreiben.")
    args = ap.parse_args(argv[1:])

    # Windows-Konsole (cp1252) verträgt keine Unicode-Symbole -> UTF-8 erzwingen.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    roots = [Path(r) for r in args.roots] if args.roots else default_roots()
    roots = [r for r in roots if r.is_dir()]
    if not roots:
        print("FEHLER: Keine gültigen Ordner gefunden.", file=sys.stderr)
        return 1

    print(f"{'DRY-RUN' if args.dry_run else 'KOMPRIMIERE'} | max {MAX_EDGE}px | JPEG q{QUALITY}")
    for r in roots:
        print(f"  • {r}")

    total_old = total_new = 0
    changed = skipped = errors = 0
    for p in iter_images(roots):
        try:
            old, new, did = process_file(p, args.dry_run)
        except Exception as e:  # eine kaputte Datei stoppt nicht den ganzen Lauf
            errors += 1
            print(f"  ! FEHLER {p}: {e}", file=sys.stderr)
            continue
        total_old += old
        total_new += new
        if did:
            changed += 1
            print(f"  ✓ {_human(old)} -> {_human(new)}  {p.name}")
        else:
            skipped += 1

    saved = total_old - total_new
    pct = (saved / total_old * 100) if total_old else 0
    print("\n── Zusammenfassung ──")
    print(f"  Verarbeitet: {changed} | Übersprungen: {skipped} | Fehler: {errors}")
    print(f"  Vorher: {_human(total_old)}  Nachher: {_human(total_new)}  Ersparnis: {_human(saved)} ({pct:.1f}%)")
    if args.dry_run:
        print("  (Dry-Run – es wurde nichts geschrieben.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
