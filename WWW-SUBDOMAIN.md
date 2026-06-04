# `www.benni-photo.com` zeigt eine andere Seite – so behebst du es

## Warum passiert das?
Die Datei `CNAME` in diesem Repo enthält **nur** `benni-photo.com` (die *Apex*-Domain
ohne `www`). GitHub Pages liefert deine Seite dadurch unter `https://benni-photo.com`
aus. Die Subdomain **`www.benni-photo.com` ist ein eigener DNS-Eintrag** – und der
zeigt aktuell noch auf die **Strato-Standardseite** (Parking/„andere Website").

> Wichtig: Das lässt sich **nicht im Code/Repo** lösen, sondern nur im **DNS** (Cloudflare
> bzw. Strato). Dein Website-Code läuft auf `www` gar nicht erst – deshalb hilft kein
> JavaScript-Redirect.

---

## Variante A — DNS bei **Cloudflare** (empfohlen, ihr nutzt Cloudflare bereits)

1. Cloudflare-Dashboard → Domain `benni-photo.com` → **DNS → Records**.
2. Prüfen, dass der **Apex** korrekt ist (sollte schon stehen):
   - 4× `A` `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (Proxy **an**).
3. **`www`-Eintrag anlegen/ändern** auf den GitHub-Pages-Host:
   - Typ `CNAME`, Name `www`, Ziel **`<dein-github-user>.github.io`** (z. B. `benngillmann.github.io`), Proxy **an** (orange Wolke).
   - Falls schon ein alter `www`-Eintrag auf Strato/eine IP zeigt: **löschen** und durch den CNAME ersetzen.
4. **GitHub** → Repo → **Settings → Pages → Custom domain**: bleibt `benni-photo.com`.
   GitHub leitet `www` → Apex (oder umgekehrt) automatisch weiter, sobald beide auf Pages zeigen.
5. Optional sauberste Lösung per **Redirect Rule** (Cloudflare → **Rules → Redirect Rules**):
   - *Wenn* Hostname gleich `www.benni-photo.com` → **301** auf
     `https://benni-photo.com${uri.path}` („Preserve query string" an).
   - So landet jeder `www`-Aufruf garantiert auf deiner echten Seite.

## Variante B — DNS noch direkt bei **Strato** (falls Nameserver noch nicht auf Cloudflare)

1. Strato-Kundenbereich → **Domainverwaltung → DNS-Einstellungen** für `benni-photo.com`.
2. Beim Eintrag **`www`** die aktuelle Ziel-/Weiterleitung entfernen.
3. **`www` als `CNAME`** auf `<dein-github-user>.github.io` setzen.
   (Strato erlaubt CNAME auf Subdomains – Apex bleibt bei den GitHub-A-Records.)
4. Alternativ Stratos **Subdomain-Weiterleitung**: `www.benni-photo.com` → `https://benni-photo.com` (301).

---

## Danach prüfen
```bash
# Sollte 200 liefern oder sauber auf https://benni-photo.com weiterleiten:
curl -sI https://www.benni-photo.com | findstr /i "HTTP location"
```
DNS-Änderungen können **einige Minuten bis Stunden** dauern (TTL/Propagation).
Browser-Cache leeren bzw. im privaten Fenster testen.

> Den richtigen Wert für `<dein-github-user>.github.io` findest du in
> **GitHub → Repo → Settings → Pages** („Your site is published at …").
