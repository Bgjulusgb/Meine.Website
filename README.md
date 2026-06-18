# Benjamin Gillmann Photography — Website

Statische Fotografen-Website (HTML / CSS / Vanilla-JS, **kein Build-Framework, kein npm**).
Gehostet über **Cloudflare Pages** (Auto-Deploy bei jedem Push auf `main`),
Domain bei **Strato**, vorgeschaltet sind **Cloudflare** Security-Header, Caching
und Web-Analytics. Live: <https://benni-photo.com>

---

## 1. Projektstruktur

```
Meine.Website/                 ← Site-Root (genau dieser Ordner wird deployt)
├── index.html                 ← Startseite: Hero, Über mich, Leistungen, Presse,
│                                Portfolio-Vorschau, (Blog – aktuell aus), Kontakt
├── impressum.html · datenschutz.html · 404.html
├── manifest.json · robots.txt · sitemap.xml   ← Sitemap wird generiert (s. u.)
├── _headers · CNAME                            ← Cloudflare-Header + Domain
├── .well-known/security.txt
│
├── assets/                    ← geteilte CSS-/Font-Bundles
│   ├── blog.css · portfolio.css
│   ├── fonts.css · fonts/      (selbst-gehostete Schriften)
│   └── fontawesome/            (Icons, lokal eingebunden)
│
├── images/                    ← Leistungs-Kärtchen-Titelbilder
│   └── leistung-*.jpg
├── hero.jpg · Profil.jpg · Transparent_Logo.svg · logo.svg · favicons …
│
├── portfolio/                 ← öffentliche Galerien
│   ├── images.json            ← AGGREGIERT (alle Kategorien) – speist die Startseiten-Vorschau
│   └── <kategorie>/           ← sport · konzert · event · red-carpet ·
│       ├── index.html         ←   meine-kunst · theater-und-musical
│       ├── images.json        ← Manifest NUR dieser Kategorie (generiert)
│       └── <bilder …>
│
├── main-portfolio/            ← Bestand für „Bewerbungs-Portfolio“ (intern)
├── _blog_disabled/            ← Blog vorerst deaktiviert (siehe Abschnitt 8)
│
├── scripts/
│   ├── compress_images.py     ← Bilder web-tauglich komprimieren (in-place)
│   ├── build_portfolio.py     ← images.json (alle) + sitemap.xml erzeugen
│   ├── build_blog.py          ← Blog-Beiträge aus Markdown rendern (aktuell ungenutzt)
│   └── templates/             ← HTML-Vorlagen für den Blog-Generator
│
└── .github/workflows/
    ├── deploy.yml             ← Auto-Deploy zu Cloudflare Pages
    ├── portfolio-manifest.yml ← baut images.json + sitemap.xml bei Push
    └── blog.yml               ← Blog-Build (zurzeit ohne Effekt, Blog ist aus)
```

### Die 6 Portfolio-Kategorien
| Ordner | Anzeigename | Leistungs-Kärtchen |
|--------|-------------|--------------------|
| `sport` | Sport | Sportfotografie |
| `konzert` | Musik | Musikfotografie |
| `event` | Events | Eventfotografie |
| `red-carpet` | Red Carpet | Red Carpet |
| `meine-kunst` | Meine Kunst | Meine Kunst |
| `theater-und-musical` | Theater & Musical | Theater & Musical |

---

## 2. Neue Bilder hinzufügen (der normale Arbeitsablauf)

1. Foto(s) in den passenden Ordner legen: `portfolio/<kategorie>/`
   (Dateiname = später der Titel im Hover; sprechende Namen helfen dem SEO).
2. **Komprimieren** (Pflicht, sonst werden die Dateien zu groß):
   ```bash
   python scripts/compress_images.py
   ```
3. **Manifeste + Sitemap erzeugen:**
   ```bash
   python scripts/build_portfolio.py
   ```
4. Committen & pushen. Die GitHub Action regeneriert `images.json` /
   `sitemap.xml` automatisch noch einmal und deployt neu.

Die Galerie-Seite der Kategorie und die Startseiten-Vorschau (zufällige Bilder
pro Kategorie) ziehen sich die neuen Bilder danach automatisch.

---

## 3. Bilder komprimieren — `scripts/compress_images.py`

Verkleinert **in-place** (Dateinamen & Ordner bleiben gleich) auf max. **2048 px**
lange Kante, JPEG-Qualität **82**. Idempotent: bereits kleine Bilder werden
übersprungen, ein Ergebnis wird nie größer als das Original geschrieben.

```bash
python scripts/compress_images.py --dry-run   # nur anzeigen, was passieren würde
python scripts/compress_images.py             # portfolio/ + 'das hier nicht benutzen'
python scripts/compress_images.py <ordner>    # eigener Ordner
```
Benötigt **Pillow** (`pip install Pillow`). Überschreibt Originale — vorher sichern.

---

## 4. Manifeste & Sitemap — `scripts/build_portfolio.py`

Scannt jede Kategorie (rekursiv) und schreibt:
- `portfolio/<kategorie>/images.json` — pro Kategorie (für die Galerie-Seite),
- `portfolio/images.json` — aggregiert (für die Startseiten-Vorschau),
- `sitemap.xml` — mit allen Bildern (Bild-SEO) + den 6 Galerie-Seiten.

```bash
python scripts/build_portfolio.py
```
Läuft auch automatisch via GitHub Action bei jeder Änderung unter `portfolio/`.

---

## 5. Lokal testen

```bash
# im Site-Root starten:
python -m http.server 8000
# dann http://localhost:8000 öffnen
```
Wichtig: über `http://` öffnen (nicht per Datei-Doppelklick) — sonst kann der
Browser die `images.json` per `fetch` nicht laden.

---

## 6. Deployment & Betrieb
- **Cloudflare Pages** deployt den Site-Root automatisch beim Push auf `main`.
- **Cloudflare** setzt Security-Header & Caching — siehe `_headers` und `CLOUDFLARE.md`.
- **SEO**-Einrichtung (Search Console, Sitemap einreichen …) — siehe `SEO.md`.
- **WWW-Subdomain** Setup — siehe `WWW-SUBDOMAIN.md`.
- Kontakt / Impressum / Datenschutz / `security.txt`: E-Mail `b.b@black.com`.

---

## 7. Wichtige Konventionen
- Eine **Galerie-Vorlage für alle**: `portfolio/<kategorie>/index.html` ist überall
  identisch und erkennt ihre Kategorie am Ordnerpfad. Änderungen am Layout in
  **einer** Datei vornehmen und mit denselben Inhalten in die anderen Ordner kopieren.
- Animationen sind GPU-schonend (nur `transform` / `opacity`) und respektieren
  `prefers-reduced-motion`; schwere Effekte sind auf Touch/Mobile deaktiviert.
- Bilder werden mit `loading="lazy"` und `decoding="async"` ausgeliefert; in der
  Lightbox wird das nächste/vorherige Bild vorab geladen.

---

## 8. Blog vorübergehend deaktiviert

Der Blog ist aktuell weder auf der Startseite verlinkt noch unter `/blog/`
erreichbar. Folgende Änderungen sind dafür aktiv:

| Ort | Was wurde geändert |
|-----|--------------------|
| `index.html` (Hauptnavigation) | Blog-Link auskommentiert |
| `index.html` (Sektion „Neueste Beiträge“ + Loader-Script) | komplett auskommentiert |
| `index.html` (Footer-Navigation) | Blog-Link auskommentiert |
| `blog/` → `_blog_disabled/` | Ordner umbenannt, daher liefert `/blog/`, `/blog/posts.json`, `/blog/feed.xml`, `/blog/sitemap.xml` und jeder Artikel jetzt **404** |
| `robots.txt` | `Sitemap: …/blog/sitemap.xml`-Zeile auskommentiert |

### Blog wieder aktivieren

1. Ordner zurück­benennen: `git mv _blog_disabled blog`
2. In `index.html` die drei Blog-Blöcke (Nav-Link, Sektion „Neueste Beiträge“
   inkl. Script, Footer-Link) wieder entkommentieren.
3. In `robots.txt` die Blog-Sitemap-Zeile wieder aktivieren.
4. Committen & pushen — Cloudflare Pages deployt automatisch.
