# Platzhalter-Bilder – Leistungs-Kärtchen

Die sechs Kärtchen im Abschnitt **„Leistungen"** auf der Startseite (`index.html`)
verwenden je ein Titelbild im **Site-Root** (also neben `index.html`).

Alle sechs Bilder **existieren jetzt** (web-komprimiert). Drei davon sind nur
**Platzhalter** – eine Kopie eines passenden Portfolio-Fotos. Du kannst sie jederzeit
durch dein Wunschbild ersetzen (gleicher Dateiname genügt). Ein zusätzlicher
Notfall-Fallback im Code sorgt dafür, dass nie ein leeres Kärtchen erscheint.

| Karte | Dateiname (Site-Root) | Status | Quelle des Platzhalters |
|-------|------------------------|--------|--------------------------|
| Sportfotografie    | `leistung-sportfotografie.jpg` | ✅ eigenes Bild | – |
| Musikfotografie    | `leistung-musikfotografie.jpg` | ✅ eigenes Bild | – |
| Eventfotografie    | `leistung-eventfotografie.jpg` | ✅ eigenes Bild | – |
| Red Carpet         | `leistung-red-carpet.jpg`      | 🟡 Platzhalter (ersetzbar) | Kopie von `portfolio/red-carpet/47-_DSC1715.jpg` |
| Meine Kunst        | `leistung-meine-kunst.jpg`     | 🟡 Platzhalter (ersetzbar) | Kopie von `portfolio/meine-kunst/choreo_said (1).jpg` |
| Theater & Musical  | `leistung-theater-musical.jpg` | 🟡 Platzhalter (ersetzbar) | Kopie von `portfolio/theater-und-musical/Cavalluna_Wintershow_Kids (14 von 1).jpg` |

## So tauschst du ein Platzhalterbild aus
1. Wähle ein starkes, eher **hochformatiges** Foto der Kategorie.
2. Speichere es **mit exakt dem Dateinamen aus der Tabelle** in den Site-Root
   (`Meine.Website-main/`, dort wo auch `index.html` liegt).
3. Empfohlene Maße: **ca. 1200 × 1500 px** (Hochformat) oder 1600 px lange Kante,
   JPEG, < 500 KB. Tipp: einfach durch `python scripts/compress_images.py <ordner>`
   schicken, dann ist die Größe automatisch web-tauglich.
4. Fertig – die Karte nutzt das Bild beim nächsten Laden automatisch.

> Die Zuordnung Karte → Dateiname steht in `index.html` im Abschnitt
> `<!-- ══ LEISTUNGEN ══ -->` (Attribut `src` der `.svc-bg`-Bilder; `data-fallback`
> ist das Notfallbild).
