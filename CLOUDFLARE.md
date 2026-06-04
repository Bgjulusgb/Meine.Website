# Cloudflare-Setup für benni-photo.com

**Ausgangslage:** Die Seite wird über **GitHub Pages** gehostet (Datei `CNAME` =
`benni-photo.com`), die Domain liegt bei **Strato**. GitHub Pages kann **keine eigenen
HTTP-Header, Redirects oder Cache-Regeln** setzen – die `.htaccess` in diesem Repo wird von
GitHub Pages **ignoriert** (sie ist nur eine Referenz für die gewünschten Header). Deshalb
übernimmt **Cloudflare** Security-Header, Caching und HTTPS.

Im Code ist bereits vorbereitet:
- Eine **CSP-Baseline** als `<meta http-equiv="Content-Security-Policy">` in `index.html`
  (funktioniert hostunabhängig).
- Das **Cloudflare-Web-Analytics-Beacon** in `index.html` (Platzhalter-Token, siehe Schritt 5).

---

## 1. Domain in Cloudflare aufnehmen
1. Kostenlosen Cloudflare-Account anlegen → **Add a site** → `benni-photo.com`.
2. Cloudflare scannt die bestehenden DNS-Einträge. Übernehmen/prüfen:
   - **Apex (`benni-photo.com`)**: vier A-Records auf die GitHub-Pages-IPs
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
     – **Proxy aktiv (orange Wolke)**.
   - **`www`** (optional): CNAME auf `<github-user>.github.io` – Proxy aktiv.
3. Cloudflare zeigt **zwei Nameserver** an (z. B. `xxx.ns.cloudflare.com`).

## 2. Nameserver bei Strato umstellen
1. Im Strato-Kundenbereich unter **Domainverwaltung → Nameserver** die beiden
   Cloudflare-Nameserver eintragen (Strato-Standard-Nameserver ersetzen).
2. Umstellung kann einige Stunden dauern. Status in Cloudflare prüfen (Site wird „Active“).
3. In GitHub: **Settings → Pages → Custom domain** bleibt `benni-photo.com`; „Enforce HTTPS“
   aktivieren, sobald GitHub das Zertifikat ausgestellt hat.

## 3. HTTPS erzwingen
**SSL/TLS → Overview**: Modus **Full** (nicht „Flexible“).
**SSL/TLS → Edge Certificates**: **Always Use HTTPS** = ON, **Automatic HTTPS Rewrites** = ON.

## 4. Security-Header (Transform Rules → HTTP Response Headers)
GitHub Pages setzt diese nicht – in Cloudflare unter **Rules → Transform Rules →
Modify Response Header** je eine Regel „Set static“ anlegen (Match: alle Anfragen):

| Header | Wert |
|--------|------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=()` |
| `Strict-Transport-Security` | `max-age=31536000` |

> `frame-ancestors`/Framing wird zusätzlich über `X-Frame-Options: DENY` abgedeckt.
> Eine vollständige CSP kann hier ebenfalls als Header gesetzt werden (Inhalt aus dem
> `<meta>`-Tag in `index.html` übernehmen); der `<meta>`-Tag bleibt als Fallback bestehen.

## 5. Web Analytics (cookielos, DSGVO-freundlich)
1. Cloudflare **Analytics & Logs → Web Analytics → Add a site** → `benni-photo.com`.
2. Den angezeigten **Token** kopieren.
3. In `index.html` den Platzhalter ersetzen:
   ```html
   data-cf-beacon='{"token": "DEIN_CLOUDFLARE_ANALYTICS_TOKEN"}'
   ```
   → echten Token statt `DEIN_CLOUDFLARE_ANALYTICS_TOKEN` eintragen.
   (Der Beacon-Host `static.cloudflareinsights.com` ist in der CSP bereits erlaubt.)

## 6. Caching (Cache Rules)
Unter **Caching → Cache Rules** (oder **Rules → Cache Rules**):
- **HTML kurz halten:** Match `URI Path ends with "/"` ODER `.html` → *Edge TTL: 0 / Respect
  origin* bzw. kurze TTL, damit Inhaltsänderungen schnell sichtbar sind.
- **Statische Assets lange cachen:** Match Dateiendung `jpg|jpeg|png|webp|svg|css|js|woff2`
  → *Edge TTL: 1 Jahr*, *Browser TTL: 1 Jahr*. (Entspricht der `.htaccess`-Logik.)
  Erfasst automatisch auch die Bilder in `portfolio/<kategorie>/…`.
- **Manifeste kurz halten:** Die `images.json` (Site-Root-Aggregat **und** je Kategorie)
  ändern sich bei neuen Bildern – Match Dateiendung `json` → *kurze TTL / Respect origin*,
  damit neue Fotos schnell erscheinen. (Das Frontend lädt sie ohnehin mit `cache:'no-cache'`.)
- Die Portfolio-Galerieseiten enden auf `/` und fallen damit unter die HTML-Regel oben.
- Optional **Tiered Cache** und **Brotli** (Speed → Optimization) aktivieren.

## 7. Nach dem Deploy prüfen
```bash
curl -I https://benni-photo.com
```
Erwartet: `HTTP/2 200`, `strict-transport-security`, `x-content-type-options: nosniff`,
`x-frame-options: DENY`, `cf-cache-status` vorhanden. Web-Analytics-Beacon lädt
(`static.cloudflareinsights.com/beacon.min.js`) und Daten erscheinen im Cloudflare-Dashboard.

---

### Hinweis zur `.htaccess`
Bleibt als Referenz im Repo, hat auf GitHub Pages aber **keine Wirkung**. Falls die Seite
jemals auf klassisches Apache-Hosting (z. B. direkt bei Strato) umzieht, greifen die dort
definierten Header/Caching-Regeln automatisch.
