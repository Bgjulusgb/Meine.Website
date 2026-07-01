#!/usr/bin/env python3
"""Erzeugt die Portfolio-Manifeste und die sitemap.xml automatisch aus den
Bildern in den Kategorie-Unterordnern von portfolio/.

Struktur:
    portfolio/
      <kategorie>/            z. B. sport, konzert, event, red-carpet,
        <bilder...>           meine-kunst, theater-und-musical
        images.json          <- pro Kategorie (von diesem Skript erzeugt)
      images.json            <- aggregiert über alle Kategorien (für die Startseite)

Aufruf:
    python scripts/build_portfolio.py             # Standard: portfolio/ + ./ (Site-Root)
    python scripts/build_portfolio.py <portfolio_dir> <site_root>

- Bildmaße werden via Pillow gelesen (ohne Pillow fehlen width/height -> kein CLS-Schutz).
- Jede Kategorie wird REKURSIV gescannt (z. B. meine-kunst/10-im-quadrat-bilder/<person>/).
- Neue Bilder einfach in den passenden Kategorieordner legen und committen – die GitHub
  Action ruft dieses Skript auf und aktualisiert alle images.json + sitemap.xml automatisch.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

try:
    from PIL import Image, ImageOps  # type: ignore
    _HAS_PIL = True
except Exception:  # pragma: no cover - Pillow optional
    _HAS_PIL = False

# ── Konfiguration ────────────────────────────────────────────────────────────
SITE_URL = "https://benni-photo.com"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".avif"}
DENYLIST = {"images.json", "index.html"}

# Thumbnail-Einstellungen: WebP-Vorschauen für das Grid (Vollbild nur in der Lightbox)
THUMB_EDGE = 640     # lange Kante in px
THUMB_QUALITY = 75   # WebP-Qualität

# Reihenfolge + Beschriftung der Kategorien. Schlüssel = Ordnername in portfolio/.
# "alt" ist eine Vorlage; {t} wird durch den aus dem Dateinamen abgeleiteten Titel ersetzt.
CATEGORIES: dict[str, dict] = {
    "sport":               dict(label="Sport",            title="Sport",
                                 alt="{t} – Sportfotografie von Benjamin Gillmann"),
    "konzert":             dict(label="Musik",            title="Konzert",
                                 alt="{t} – Konzert- & Musikfotografie von Benjamin Gillmann"),
    "event":               dict(label="Events",           title="Event",
                                 alt="{t} – Eventfotografie von Benjamin Gillmann"),
    "red-carpet":          dict(label="Red Carpet",       title="Red Carpet",
                                 alt="{t} – Red-Carpet-Fotografie von Benjamin Gillmann"),
    "meine-kunst":         dict(label="Meine Kunst",      title="Porträt",
                                 alt="{t} – künstlerische Porträtfotografie von Benjamin Gillmann"),
    "theater-und-musical": dict(label="Theater & Musical", title="Theater & Musical",
                                 alt="{t} – Theater- & Musicalfotografie von Benjamin Gillmann"),
}
CAT_ORDER = list(CATEGORIES.keys())

# Unlisted: bekommt ein eigenes images.json (für die direkte Galerie-URL),
# taucht aber NICHT in der aggregierten portfolio/images.json und nicht in
# der sitemap.xml auf. Nur per direktem Link teilen.
UNLISTED_CATEGORIES: dict[str, dict] = {
    "bewerbungs-portfolio": dict(label="Bewerbung",        title="Bewerbungsportfolio",
                                 alt="{t} – Konzert- & Musikfotografie von Benjamin Gillmann"),
    "sportfreunde-stiller": dict(label="Sportfreunde Stiller", title="Sportfreunde Stiller",
                                 alt="{t} – Sportfreunde Stiller live, Konzertfotografie von Benjamin Gillmann"),
    "magie-und-illusion":   dict(label="Magie & Illusion", title="Magie & Illusion",
                                 alt="{t} – Bühnenfotografie aus einer Magie- & Illusionsshow von Benjamin Gillmann"),
}


def prettify(stem: str) -> str:
    """Lesbaren Titel aus einem Dateinamen ableiten."""
    s = stem.replace("_", " ").replace("-", " ")
    s = re.sub(r"\(\s*\d+\s*(von\s*\d+)?\s*\)", "", s, flags=re.IGNORECASE)  # (14 von 265)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def dims(path: Path):
    if not _HAS_PIL:
        return (None, None)
    try:
        with Image.open(path) as im:
            return im.size  # (width, height)
    except Exception:
        return (None, None)


def make_thumb(src: Path, thumb_dir: Path) -> tuple:
    """Erzeugt ein WebP-Thumbnail. Gibt (rel_pfad, breite, hoehe) oder (None,None,None) zurück."""
    if not _HAS_PIL:
        return (None, None, None)
    try:
        thumb_name = src.stem + ".webp"
        thumb_path = thumb_dir / thumb_name
        # Überspringe wenn Thumbnail aktueller als Quelle
        if (thumb_path.exists()
                and thumb_path.stat().st_mtime >= src.stat().st_mtime):
            with Image.open(thumb_path) as _im:
                return ("thumbs/" + thumb_name, *_im.size)
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            w, h = im.size
            long_edge = max(w, h)
            if long_edge > THUMB_EDGE:
                scale = THUMB_EDGE / long_edge
                im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
            # RGBA → RGB für WebP ohne Transparenz
            if im.mode in ("RGBA", "LA", "P"):
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[-1])
                im = bg
            elif im.mode != "RGB":
                im = im.convert("RGB")
            thumb_dir.mkdir(exist_ok=True)
            im.save(thumb_path, format="WebP", quality=THUMB_QUALITY, method=4)
            return ("thumbs/" + thumb_name, im.width, im.height)
    except Exception:
        return (None, None, None)


def collect_category(cat_dir: Path, cat: str, cfg: dict) -> list[dict]:
    """Alle Bilder einer Kategorie REKURSIV sammeln. file = Pfad relativ zum Kategorieordner."""
    items: list[dict] = []
    thumb_dir = cat_dir / "thumbs"
    for p in sorted(cat_dir.rglob("*"), key=lambda x: str(x).lower()):
        if not p.is_file() or p.suffix.lower() not in IMAGE_EXTS:
            continue
        if p.name.lower() in DENYLIST:
            continue
        rel = p.relative_to(cat_dir).as_posix()
        # Generierte Thumbnails überspringen
        if rel.startswith("thumbs/"):
            continue
        # Sonderfall: »10 im Quadrat«-Porträtserie (gehört zum SZ-Ausstellungsartikel)
        if cat == "meine-kunst" and rel.lower().startswith("10-im-quadrat-bilder/"):
            parts = rel.split("/")
            person = parts[1].replace("_", " ").replace("-", " ").strip().title() if len(parts) > 2 else ""
            title = f"10 im Quadrat – {person}" if person else "10 im Quadrat"
            alt = (f"»10 im Quadrat« – Porträtserie mit {person}, Ausstellung München "
                   f"(Süddeutsche Zeitung) – Foto von Benjamin Gillmann") if person else \
                  "»10 im Quadrat« – Porträtausstellung München (Süddeutsche Zeitung) – Benjamin Gillmann"
        # Sonderfall: Magie & Illusion – „Generalprobe_017" / „Premiere_Teil_2_Nr_067" lesbar machen
        elif cat == "magie-und-illusion":
            ROMAN = {1:"I",2:"II",3:"III",4:"IV",5:"V"}
            m = re.match(r"^(Generalprobe|Premiere)(?:_Teil_(\d+))?(?:_Nr)?_(\d+)$", p.stem, re.IGNORECASE)
            if m:
                phase = m.group(1).capitalize()
                teil = int(m.group(2)) if m.group(2) else None
                num = int(m.group(3))
                title = f"{phase} · Akt {ROMAN.get(teil, teil)} · Nr. {num}" if teil else f"{phase} · Nr. {num}"
            else:
                title = prettify(p.stem) or cfg["title"]
            alt = cfg["alt"].format(t=title)
        else:
            title = prettify(p.stem) or cfg["title"]
            alt = cfg["alt"].format(t=title)
        item = {
            "file": rel,
            "title": title,
            "cat": cat,
            "catLabel": cfg["label"],
            "alt": alt,
        }
        w, h = dims(p)
        if w and h:
            item["width"] = w
            item["height"] = h
        # WebP-Thumbnail generieren (nur für direkte Kategorie-Dateien, keine Unterordner)
        if "/" not in rel:
            thumb_rel, tw, th = make_thumb(p, thumb_dir)
            if thumb_rel:
                item["thumb"] = thumb_rel
                item["tw"] = tw
                item["th"] = th
        items.append(item)
    return items


def detect_main_cat(stem: str) -> str:
    """Kategorie eines main-portfolio-Bildes aus dem Dateinamen ableiten.
    Beispiele: 'event (1)' -> 'event', 'konzert (3)' -> 'konzert',
    'red-carpet (2)' -> 'red-carpet'. Unbekannt -> '' (leer)."""
    base = re.sub(r"\s*\([^)]*\)", "", stem).strip().lower().replace(" ", "-")
    if base in CATEGORIES:
        return base
    for key in CATEGORIES:
        if base.startswith(key):
            return key
    return ""


def collect_main_portfolio(main_dir: Path) -> list[dict]:
    """Kuratierte Startseiten-Auswahl aus main-portfolio/ sammeln und sortieren.
    file = Dateiname relativ zu main-portfolio/ (im JS mit 'main-portfolio/' prefixed).
    Sortierung: nach Kategorie (CAT_ORDER), dann nach der Nummer im Namen."""
    items: list[dict] = []
    for p in sorted(main_dir.rglob("*"), key=lambda x: str(x).lower()):
        if not p.is_file() or p.suffix.lower() not in IMAGE_EXTS:
            continue
        if p.name.lower() in DENYLIST:
            continue
        cat = detect_main_cat(p.stem)
        cfg = CATEGORIES.get(cat)
        # Bei generischen Namen ("konzert (1)") den Kategorietitel verwenden,
        # bei sprechenden Namen den aufbereiteten Dateinamen.
        pretty = prettify(p.stem)
        generic = (not pretty) or pretty.strip().lower().replace(" ", "-") == cat
        title = (cfg["title"] if cfg else "Arbeit") if generic else pretty
        label = cfg["label"] if cfg else "Portfolio"
        alt = cfg["alt"].format(t=title) if cfg else f"{title} – Foto von Benjamin Gillmann"
        item = {
            "file": p.relative_to(main_dir).as_posix(),
            "title": title,
            "cat": cat,
            "catLabel": label,
            "alt": alt,
        }
        w, h = dims(p)
        if w and h:
            item["width"] = w
            item["height"] = h
        items.append(item)

    def sort_key(it: dict):
        ci = CAT_ORDER.index(it["cat"]) if it["cat"] in CAT_ORDER else len(CAT_ORDER)
        m = re.search(r"\((\d+)\)", it["file"])
        return (ci, int(m.group(1)) if m else 0, it["file"].lower())

    items.sort(key=sort_key)
    return items


def write_json(data, out: Path) -> None:
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def img_url(file_rel_to_portfolio: str) -> str:
    return f"{SITE_URL}/portfolio/" + quote(file_rel_to_portfolio, safe="/")


def write_sitemap(by_cat: dict[str, list[dict]], out: Path) -> None:
    from datetime import date
    today = date.today().isoformat()
    L = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
        '  <url>',
        f'    <loc>{SITE_URL}/</loc>',
        f'    <lastmod>{today}</lastmod>',
        '    <changefreq>weekly</changefreq>',
        '    <priority>1.0</priority>',
        '  </url>',
    ]
    for cat in CAT_ORDER:
        items = by_cat.get(cat, [])
        if not items:
            continue
        L += [
            '  <url>',
            f'    <loc>{SITE_URL}/portfolio/{cat}/</loc>',
            f'    <lastmod>{today}</lastmod>',
            '    <changefreq>monthly</changefreq>',
            '    <priority>0.8</priority>',
        ]
        for it in items:
            L.append('    <image:image>')
            L.append(f'      <image:loc>{img_url(cat + "/" + it["file"])}</image:loc>')
            L.append(f'      <image:caption>{escape(it["alt"])}</image:caption>')
            L.append('    </image:image>')
        L.append('  </url>')
    for page in ("impressum.html", "datenschutz.html"):
        L += [
            '  <url>',
            f'    <loc>{SITE_URL}/{page}</loc>',
            f'    <lastmod>{today}</lastmod>',
            '    <changefreq>yearly</changefreq>',
            '    <priority>0.3</priority>',
            '  </url>',
        ]
    L += ['</urlset>', '']
    out.write_text("\n".join(L), encoding="utf-8")


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    portfolio_dir = Path(argv[1]) if len(argv) > 1 else Path("portfolio")
    site_root = Path(argv[2]) if len(argv) > 2 else Path(".")
    if not portfolio_dir.is_dir():
        print(f"FEHLER: Portfolio-Ordner nicht gefunden: {portfolio_dir}", file=sys.stderr)
        return 1

    by_cat: dict[str, list[dict]] = {}
    aggregated: list[dict] = []
    total = 0

    for cat, cfg in CATEGORIES.items():
        cat_dir = portfolio_dir / cat
        if not cat_dir.is_dir():
            print(f"  (übersprungen: {cat}/ existiert nicht)")
            continue
        items = collect_category(cat_dir, cat, cfg)
        by_cat[cat] = items
        write_json(items, cat_dir / "images.json")
        # Aggregiert: file-Pfad relativ zu portfolio/ (z. B. "sport/foo.jpg")
        for it in items:
            agg = dict(it)
            agg["file"] = f"{cat}/{it['file']}"
            aggregated.append(agg)
        total += len(items)
        print(f"  ✓ {cat}: {len(items)} Bilder -> {cat_dir / 'images.json'}")

    write_json(aggregated, portfolio_dir / "images.json")
    write_sitemap(by_cat, site_root / "sitemap.xml")
    print(f"OK: {total} Bilder gesamt -> {portfolio_dir / 'images.json'} + {site_root / 'sitemap.xml'}")

    # Unlisted-Galerien: eigenes images.json erzeugen, aber NICHT in Aggregat/Sitemap aufnehmen.
    for cat, cfg in UNLISTED_CATEGORIES.items():
        cat_dir = portfolio_dir / cat
        if not cat_dir.is_dir():
            print(f"  (übersprungen: {cat}/ existiert nicht)")
            continue
        items = collect_category(cat_dir, cat, cfg)
        write_json(items, cat_dir / "images.json")
        print(f"  ✓ {cat} (unlisted): {len(items)} Bilder -> {cat_dir / 'images.json'}")

    # Kuratierte Startseiten-Auswahl (separater Ordner main-portfolio/, Geschwister von portfolio/).
    main_dir = site_root / "main-portfolio"
    if main_dir.is_dir():
        main_items = collect_main_portfolio(main_dir)
        write_json(main_items, main_dir / "images.json")
        print(f"  ✓ main-portfolio: {len(main_items)} Bilder -> {main_dir / 'images.json'}")
    else:
        print("  (übersprungen: main-portfolio/ existiert nicht)")
    if not _HAS_PIL:
        print("Hinweis: Pillow nicht installiert -> width/height fehlen (kein CLS-Schutz).",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
