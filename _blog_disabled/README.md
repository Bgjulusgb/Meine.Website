# Blog – So schreibst du einen Beitrag

Der Blog wird **automatisch** aus Markdown erzeugt. Du schreibst nur eine
`index.md` – die fertige HTML-Seite, die Übersicht, der RSS-Feed und die
Sitemap entstehen von selbst (lokal per Skript oder automatisch per GitHub
Action beim Push).

## Neuen Beitrag anlegen

1. Lege einen Ordner mit einem **kurzen, deutschen Slug** an (Kleinbuchstaben,
   Bindestriche statt Leerzeichen), z. B.:

   ```
   blog/mein-neuer-beitrag/
   ```

2. Lege darin eine Datei `index.md` mit Front-Matter + Text an:

   ```markdown
   ---
   title: "Mein Titel"                 # Pflicht
   description: "1–2 Sätze für Google & Social Media."   # optional
   date: 2026-06-20                    # Pflicht (Veröffentlichung)
   updated: 2026-06-21                 # optional
   tags: [Konzert, Technik]           # optional (Filter auf der Übersicht)
   category: Musik                    # optional
   cover: cover.jpg                   # optional (Bild im selben Ordner)
   cover_alt: "Bildbeschreibung"      # optional (wichtig für SEO/Barrierefreiheit)
   draft: false                       # true = wird NICHT veröffentlicht
   related: [konzert, event]          # optional: verlinkt passende Portfolios
   ---

   Dein Text als **Markdown**. Bilder so einbinden:

   ![Bildbeschreibung](./bild-1.jpg)

   ## Zwischenüberschrift
   Absätze, Listen, > Zitate, Links – alles ganz normal in Markdown.
   ```

3. Lege **Bilder** in denselben Ordner und referenziere sie relativ
   (`./bild.jpg`). Tipp: Vorher mit `python scripts/compress_images.py`
   verkleinern (max. 2048 px).

## Veröffentlichen

- **Automatisch:** Ordner + Bilder committen und pushen – die GitHub Action
  `.github/workflows/blog.yml` baut alles und committet die generierten Dateien
  zurück. GitHub Pages deployt anschließend.
- **Lokal testen:**

  ```bash
  pip install Pillow markdown pyyaml
  python scripts/build_blog.py blog .
  python -m http.server      # dann http://localhost:8000/blog/ öffnen
  ```

## Was wird generiert? (NICHT von Hand bearbeiten)

- `blog/<slug>/index.html` – die fertige Beitragsseite (volles SEO)
- `blog/index.html` – die Übersicht mit Tag-Filter
- `blog/posts.json` – Manifest (speist u. a. „Neueste Beiträge" auf der Startseite)
- `blog/feed.xml` – RSS-Feed
- `blog/sitemap.xml` – Blog-Sitemap (in `robots.txt` verlinkt)

Bearbeite nur `index.md` und die Bilder – der Rest wird überschrieben.
