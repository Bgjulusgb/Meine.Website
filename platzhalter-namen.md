# Platzhalter-Bilder – Leistungs-Kärtchen

Die sechs Kärtchen im Abschnitt **„Leistungen"** auf der Startseite (`index.html`)
verwenden je ein Titelbild im Ordner **`images/`** (neben `index.html`).

Alle sechs Bilder **liegen jetzt in `images/`** (web-komprimiert). Drei davon sind nur
**Platzhalter** – eine Kopie eines passenden Portfolio-Fotos. Du kannst sie jederzeit
durch dein Wunschbild ersetzen (gleicher Dateiname genügt). Ein zusätzlicher
Notfall-Fallback im Code sorgt dafür, dass nie ein leeres Kärtchen erscheint.

| Karte | Dateiname (in `images/`) | Status | Quelle des Platzhalters |
|-------|---------------------------|--------|--------------------------|
| Sportfotografie    | `images/leistung-sportfotografie.jpg` | ✅ eigenes Bild | – |
| Musikfotografie    | `images/leistung-musikfotografie.jpg` | ✅ eigenes Bild | – |
| Eventfotografie    | `images/leistung-eventfotografie.jpg` | ✅ eigenes Bild | – |
| Red Carpet         | `images/leistung-red-carpet.jpg`      | 🟡 Platzhalter (ersetzbar) | Kopie von `portfolio/red-carpet/woodwalkers_2 (5).jpg` (Hochformat) |
| Meine Kunst        | `images/leistung-meine-kunst.jpg`     | 🟡 Platzhalter (ersetzbar) | Kopie von `portfolio/meine-kunst/choreo_said (3).jpg` (Hochformat) |
| Theater & Musical  | `images/leistung-theater-musical.jpg` | 🟡 Platzhalter (ersetzbar) | Kopie von `portfolio/theater-und-musical/Cavalluna_Wintershow_Kids (45 von 265).jpg` (neu gewählt) |

## So tauschst du ein Platzhalterbild aus
1. Wähle ein starkes, eher **hochformatiges** Foto der Kategorie.
2. Speichere es **mit exakt dem Dateinamen aus der Tabelle** im Ordner **`images/`**
   (z. B. `images/leistung-red-carpet.jpg`).
3. Empfohlene Maße: **ca. 1200 × 1500 px** (Hochformat) oder 1600 px lange Kante,
   JPEG, < 500 KB. Tipp: einfach durch `python scripts/compress_images.py <ordner>`
   schicken, dann ist die Größe automatisch web-tauglich.
4. Fertig – die Karte nutzt das Bild beim nächsten Laden automatisch.

> Die Zuordnung Karte → Dateiname steht in `index.html` im Abschnitt
> `<!-- ══ LEISTUNGEN ══ -->` (Attribut `src` der `.svc-bg`-Bilder; `data-fallback`
> ist das Notfallbild).
