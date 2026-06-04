# SEO & Auffindbarkeit — Setup-Anleitung (benni-photo.com)

Die Technik on-page ist erledigt (Titel/Description, Canonical, hreflang, Open Graph/Twitter,
JSON-LD `ProfessionalService`/`WebSite`, Bild-Sitemap mit Captions, `robots.txt`, mobile,
HTTPS, schnelle Ladezeit). Damit die Seite bei **allen** Suchmaschinen und international
gefunden wird, fehlt vor allem das **Einreichen** bei den Webmaster-Tools. Schritt für Schritt:

## 1. Google Search Console (Pflicht)
1. https://search.google.com/search-console → Property `https://benni-photo.com/` (URL-Präfix).
2. Verifizieren – am einfachsten per **DNS-TXT** (über Cloudflare hinzufügen) oder per
   HTML-Meta-Tag im `<head>` von `index.html`.
3. Unter **Sitemaps** `https://benni-photo.com/sitemap.xml` einreichen.
4. „URL-Prüfung“ → Startseite „Indexierung beantragen“.

## 2. Bing Webmaster Tools (deckt Bing, Yahoo, DuckDuckGo, Ecosia ab)
1. https://www.bing.com/webmasters → Site hinzufügen.
2. **Tipp:** „Aus Google Search Console importieren“ spart die erneute Verifizierung.
3. Sitemap `https://benni-photo.com/sitemap.xml` einreichen.

## 3. Yandex Webmaster (Osteuropa/RU-Raum)
1. https://webmaster.yandex.com → Site hinzufügen, per DNS/Meta verifizieren.
2. Sitemap einreichen.

## 4. IndexNow (sofortige Indexierung bei Bing, Yandex, Seznam) — optional
1. Einen API-Key wählen (z. B. 32-stellige Zufalls-Hex-Zeichenkette).
2. Datei `https://benni-photo.com/<key>.txt` mit genau diesem Key als Inhalt anlegen
   (im Site-Root committen).
3. Bei jeder Änderung eine GET-Anfrage senden:
   `https://api.indexnow.org/indexnow?url=https://benni-photo.com/&key=<key>`
   (lässt sich später in die bestehende GitHub Action einbauen).

## 5. Internationale Auffindbarkeit
- Inhalt ist aktuell **Deutsch** → realistische Reichweite ist primär DACH. `hreflang="de"` +
  `x-default` sind gesetzt; das ist für eine einsprachige Seite korrekt.
- Für echte internationale Sichtbarkeit später eine **englische Version** (`/en/`) mit eigenem
  `hreflang="en"` ergänzen — erst dann ranke ich sinnvoll in EN-Märkten.
- **Bilder-SEO** (wichtig für eine Fotografen-Seite, auch international): Die `sitemap.xml`
  enthält bereits alle Portfolio-Bilder mit deutschsprachigen Captions → erscheint in der
  Google-/Bing-Bildersuche. Aussagekräftige Dateinamen + `alt`-Texte beibehalten.

## 6. Portfolio-Kategorieseiten (neue Struktur)
Seit der Umstellung gibt es sechs eigene Galerie-Seiten, die in der `sitemap.xml` mit
allen Bildern (Captions) enthalten sind und so in der Bildersuche ranken:
`/portfolio/sport/`, `/portfolio/konzert/`, `/portfolio/event/`, `/portfolio/red-carpet/`,
`/portfolio/meine-kunst/`, `/portfolio/theater-und-musical/`.
- Titel/Description/Canonical/Open-Graph **und** `ImageGallery`-JSON-LD werden pro Seite
  per JavaScript aus der Kategorie gesetzt (eine identische Vorlage für alle Ordner).
  Modernes Googlebot/Bingbot rendert JS und liest diese Werte; die statische Bild-Sitemap
  sorgt zusätzlich für verlässliche Indexierung auch ohne JS.
- Sprechende Dateinamen + Kategorie liefern automatisch `alt`/Captions (siehe
  `scripts/build_portfolio.py`).

## 7. Laufend
- Nach Inhaltsänderungen werden `sitemap.xml`/`images.json` automatisch von der GitHub Action
  aktualisiert; Sitemap muss nur einmal eingereicht werden.
- Backlinks (Vereins-/Veranstalter-Seiten, Presse, Instagram-Bio-Link) verbessern das Ranking
  am stärksten.
- Performance/Lighthouse regelmäßig prüfen (Core Web Vitals fließen ins Ranking ein).

## Hinweis Verifizierungs-Tags
Wenn du ein Meta-Verifizierungs-Tag brauchst, kommt es in den `<head>` von `index.html`, z. B.:
`<meta name="google-site-verification" content="DEIN_TOKEN">` —
bewusst NICHT vorab als Platzhalter eingebaut (leere Tokens können Verwirrung stiften).
