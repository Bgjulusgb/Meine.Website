# Benjamin Gillmann Photography — Website

Statische Fotografen-Website (HTML/CSS/Vanilla-JS, **kein Build-Framework**).
Gehostet über **GitHub Pages**, Domain bei **Strato**, davor **Cloudflare**
(HTTPS, Security-Header, Caching, Web-Analytics). Live: <https://benni-photo.com>

---

## 1. Projektstruktur

```
Meine.Website-main/            ← Site-Root (genau dieser Ordner wird deployt)
├── index.html                 ← Startseite (Hero, Über mich, Leistungen, Presse,
│                                 Portfolio-Vorschau, Kontakt) – komplett self-contained
├── impressum.html · datenschutz.html · 404.html
├── manifest.json · robots.txt · sitemap.xml   ← sitemap wird generiert (s. u.)
├── .well-known/security.txt
├── leistung-*.jpg             ← Titelbilder der Leistungs-Kärtchen (siehe platzhalter-namen.md)
├── hero.jpg · Profil.jpg · Transparent_Logo.svg · favicons …
├── portfolio/
│   ├── images.json            ← AGGREGIERT (alle Kategorien) – speist die Startseiten-Vorschau
│   └── <kategorie>/           ← sport · konzert · event · red-carpet · meine-kunst · theater-und-musical
│       ├── index.html         ← Galerie-Seite (für alle Kategorien identisch, datengetrieben)
│       ├── images.json        ← Manifest NUR dieser Kategorie (generiert)
│       └── <bilder …>         ← die Fotos (meine-kunst hat zusätzlich Unter-Unterordner)
├── scripts/
│   ├── compress_images.py     ← Bilder web-tauglich komprimieren (in-place)
│   └── build_portfolio.py     ← images.json (alle) + sitemap.xml erzeugen
└── .github/workflows/portfolio-manifest.yml   ← baut images.json + sitemap bei jedem Push automatisch
```

> Hinweis: Der Ordner `das hier nicht benutzen/` (eine Ebene über dem Site-Root)
> wird **nicht** deployt; er enthält alte/zusätzliche Bilder und wird nur mitkomprimiert.

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
4. Committen & pushen. Die GitHub Action regeneriert `images.json`/`sitemap.xml`
   sowieso noch einmal automatisch und deployt neu.

Die Galerie-Seite der Kategorie und die Startseiten-Vorschau (3 zufällige Bilder
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
Benötigt **Pillow** (`pip install Pillow`). ⚠️ Überschreibt Originale – vorher sichern.

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
# im Site-Root (Meine.Website-main/) starten:
python -m http.server 8000
# dann http://localhost:8000 öffnen
```
Wichtig: über `http://` öffnen (nicht per Datei-Doppelklick) – sonst kann der
Browser die `images.json` per `fetch` nicht laden.

---

## 6. Deployment & Betrieb
- **GitHub Pages** deployt den Site-Root automatisch beim Push (`CNAME` = Domain).
- **Cloudflare** setzt Security-Header & Caching — siehe `CLOUDFLARE.md`.
- **SEO**-Einrichtung (Search Console, Sitemap einreichen …) — siehe `SEO.md`.
- Kontakt/Impressum/Datenschutz/`security.txt`: E-Mail `benjamin.gillmann@black.com`.

---

## 7. Wichtige Konventionen
- Eine **Galerie-Vorlage für alle**: `portfolio/<kategorie>/index.html` ist überall
  identisch und erkennt ihre Kategorie am Ordnerpfad. Änderungen am Layout in
  **einer** Datei vornehmen und mit denselben Inhalten in die anderen Ordner kopieren.
- Animationen sind GPU-schonend (nur `transform`/`opacity`) und respektieren
  `prefers-reduced-motion`; schwere Effekte sind auf Touch/Mobile deaktiviert.
