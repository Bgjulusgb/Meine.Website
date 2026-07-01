#!/usr/bin/env python3
"""Erzeugt den Blog aus Markdown-Quellen.

Struktur:
    blog/
      <slug>/
        index.md      <- QUELLE: YAML-Front-Matter + Markdown (du schreibst nur das)
        index.html    <- GENERIERT aus index.md
        cover.jpg     <- Cover-/Beitragsbilder (relativ referenziert: ./bild.jpg)
      index.html      <- GENERIERT: Übersicht (Karten + Tag-Filter)
      posts.json      <- GENERIERT: Manifest (für Startseiten-Widget & Wiederverwendung)
      feed.xml        <- GENERIERT: RSS-2.0-Feed
      sitemap.xml     <- GENERIERT: Blog-Sitemap (Übersicht + Beiträge + Cover-Bilder)

Aufruf:
    python scripts/build_blog.py             # Standard: blog/ + ./ (Site-Root)
    python scripts/build_blog.py <blog_dir> <site_root>

Abhängigkeiten (in der GitHub Action via pip installiert, wie Pillow):
    pip install Pillow markdown pyyaml
- markdown/pyyaml sind PFLICHT (Markdown -> HTML, Front-Matter parsen).
- Pillow ist optional (liefert Bildmaße für og:image/Karten -> CLS-Schutz).

Front-Matter (in blog/<slug>/index.md):
    ---
    title: "..."                # Pflicht
    description: "..."          # optional (sonst aus 1. Absatz)
    date: 2026-06-10            # Pflicht (Veröffentlichung)
    updated: 2026-06-12         # optional (sonst = date)
    tags: [Konzert, Technik]    # optional
    category: Musik             # optional
    cover: cover.jpg            # optional (Datei im Beitragsordner)
    cover_alt: "..."            # optional
    draft: false               # true -> wird NICHT veröffentlicht
    related: [konzert]          # optional: Portfolio-Kategorien zum Verlinken
    ---
    ## Markdown ...
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date, datetime
from html import escape as h
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape as xescape

try:
    import yaml  # type: ignore
except Exception:
    print("FEHLER: pyyaml fehlt -> 'pip install pyyaml'", file=sys.stderr)
    raise

try:
    import markdown as md_lib  # type: ignore
except Exception:
    print("FEHLER: markdown fehlt -> 'pip install markdown'", file=sys.stderr)
    raise

try:
    from PIL import Image  # type: ignore
    _HAS_PIL = True
except Exception:  # pragma: no cover - Pillow optional
    _HAS_PIL = False

# ── Konfiguration ────────────────────────────────────────────────────────────
SITE_URL = "https://benni-photo.com"
AUTHOR = "Benjamin Gillmann"
AUTHOR_SAMEAS = "https://www.instagram.com/benjamin_gillmann/"
BUSINESS_ID = f"{SITE_URL}/#business"
DEFAULT_OG_IMAGE = f"{SITE_URL}/url_preview.jpg"
WORDS_PER_MINUTE = 200
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".avif"}

# Portfolio-Kategorien für interne "related"-Verlinkung (Label + URL).
PORTFOLIO_CATS = {
    "sport": "Sport", "konzert": "Konzert & Musik", "event": "Events",
    "red-carpet": "Red Carpet", "meine-kunst": "Meine Kunst",
    "theater-und-musical": "Theater & Musical",
}

MONTHS_DE = ["", "Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
             "August", "September", "Oktober", "November", "Dezember"]

TEMPLATES = Path(__file__).resolve().parent / "templates"


# ── Helfer ───────────────────────────────────────────────────────────────────
def to_date(v) -> date:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, str):
        return datetime.fromisoformat(v.strip()[:10]).date()
    raise ValueError(f"Ungültiges Datum: {v!r}")


def human_date(d: date) -> str:
    return f"{d.day}. {MONTHS_DE[d.month]} {d.year}"


def dims(path: Path):
    if not _HAS_PIL or not path.is_file():
        return (None, None)
    try:
        with Image.open(path) as im:
            return im.size
    except Exception:
        return (None, None)


def split_front_matter(text: str):
    """Trennt YAML-Front-Matter (zwischen ---) vom Markdown-Body."""
    if text.startswith("﻿"):
        text = text[1:]
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.DOTALL)
    if not m:
        return {}, text
    meta = yaml.safe_load(m.group(1)) or {}
    if not isinstance(meta, dict):
        meta = {}
    return meta, m.group(2)


def strip_html(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


def make_excerpt(description: str, body_html: str, limit: int = 180) -> str:
    txt = description.strip() if description else ""
    if not txt:
        m = re.search(r"<p>(.*?)</p>", body_html, re.DOTALL)
        txt = strip_html(m.group(1)) if m else strip_html(body_html)
    if len(txt) > limit:
        txt = txt[:limit].rsplit(" ", 1)[0].rstrip(",.;:–- ") + " …"
    return txt


def render_markdown(body: str) -> str:
    # Kein roher HTML-Input (Standard von python-markdown escaped -> XSS-arm).
    mdp = md_lib.Markdown(extensions=["extra", "sane_lists", "smarty", "toc"],
                          output_format="html5")
    return mdp.convert(body)


# ── Beitrag lesen ─────────────────────────────────────────────────────────────
def read_post(post_dir: Path):
    md_file = post_dir / "index.md"
    meta, body = split_front_matter(md_file.read_text(encoding="utf-8"))
    if meta.get("draft") is True:
        return None
    title = str(meta.get("title") or "").strip()
    if not title:
        print(f"  (übersprungen: {post_dir.name}/ ohne title)", file=sys.stderr)
        return None

    d = to_date(meta.get("date") or date.today())
    upd = to_date(meta["updated"]) if meta.get("updated") else d
    tags = [str(t).strip() for t in (meta.get("tags") or []) if str(t).strip()]
    category = str(meta.get("category") or "").strip()
    related = [str(r).strip() for r in (meta.get("related") or []) if str(r).strip()]

    body_html = render_markdown(body)
    words = len(strip_html(body_html).split())
    reading_time = max(1, round(words / WORDS_PER_MINUTE))
    description = str(meta.get("description") or "").strip()
    excerpt = make_excerpt(description, body_html)
    if not description:
        description = excerpt

    slug = post_dir.name
    cover = str(meta.get("cover") or "").strip()
    cover_alt = str(meta.get("cover_alt") or title).strip()
    cover_w = cover_h = None
    if cover:
        cover_w, cover_h = dims(post_dir / cover)

    return {
        "slug": slug,
        "url": f"{SITE_URL}/blog/{slug}/",
        "title": title,
        "description": description,
        "excerpt": excerpt,
        "date": d,
        "updated": upd,
        "tags": tags,
        "category": category,
        "related": related,
        "cover": cover,
        "cover_alt": cover_alt,
        "cover_w": cover_w,
        "cover_h": cover_h,
        "body_html": body_html,
        "reading_time": reading_time,
    }


# ── SEO-Head pro Beitrag ──────────────────────────────────────────────────────
def cover_abs(post) -> str:
    if not post["cover"]:
        return DEFAULT_OG_IMAGE
    return f"{SITE_URL}/blog/{post['slug']}/" + quote(post["cover"], safe="/")


def seo_head(post) -> str:
    img = cover_abs(post)
    pub = post["date"].isoformat()
    mod = post["updated"].isoformat()
    lines = [
        '    <meta property="og:type" content="article">',
        '    <meta property="og:site_name" content="Benjamin Gillmann Photography">',
        f'    <meta property="og:title" content="{h(post["title"])}">',
        f'    <meta property="og:description" content="{h(post["description"])}">',
        f'    <meta property="og:url" content="{post["url"]}">',
        f'    <meta property="og:image" content="{img}">',
        f'    <meta property="og:image:alt" content="{h(post["cover_alt"])}">',
        '    <meta property="og:locale" content="de_DE">',
        f'    <meta property="article:published_time" content="{pub}">',
        f'    <meta property="article:modified_time" content="{mod}">',
        f'    <meta property="article:author" content="{AUTHOR}">',
    ]
    if post["cover_w"] and post["cover_h"]:
        lines.insert(7, f'    <meta property="og:image:width" content="{post["cover_w"]}">')
        lines.insert(8, f'    <meta property="og:image:height" content="{post["cover_h"]}">')
    for t in post["tags"]:
        lines.append(f'    <meta property="article:tag" content="{h(t)}">')
    lines += [
        f'    <meta name="twitter:card" content="summary_large_image">',
        f'    <meta name="twitter:title" content="{h(post["title"])}">',
        f'    <meta name="twitter:description" content="{h(post["description"])}">',
        f'    <meta name="twitter:image" content="{img}">',
    ]

    blogposting = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": post["title"],
        "description": post["description"],
        "image": [img],
        "datePublished": pub,
        "dateModified": mod,
        "author": {"@type": "Person", "name": AUTHOR, "url": SITE_URL + "/",
                   "sameAs": [AUTHOR_SAMEAS]},
        "publisher": {"@id": BUSINESS_ID},
        "mainEntityOfPage": {"@type": "WebPage", "@id": post["url"]},
        "inLanguage": "de-DE",
    }
    if post["tags"]:
        blogposting["keywords"] = ", ".join(post["tags"])

    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Start", "item": SITE_URL + "/"},
            {"@type": "ListItem", "position": 2, "name": "Blog", "item": SITE_URL + "/blog/"},
            {"@type": "ListItem", "position": 3, "name": post["title"], "item": post["url"]},
        ],
    }
    for obj in (blogposting, breadcrumb):
        lines.append('    <script type="application/ld+json">'
                     + json.dumps(obj, ensure_ascii=False) + '</script>')
    return "\n".join(lines)


# ── Sichtbare Bausteine ───────────────────────────────────────────────────────
def tags_html(post, prefix: str = "../") -> str:
    if not post["tags"]:
        return ""
    return "".join(
        f'<a class="post-tag" href="{prefix}?tag={quote(t)}" data-nav>#{h(t)}</a>'
        for t in post["tags"]
    )


def cover_html(post) -> str:
    if not post["cover"]:
        return ""
    dim = (f' width="{post["cover_w"]}" height="{post["cover_h"]}"'
           if post["cover_w"] and post["cover_h"] else "")
    src = quote(post["cover"], safe="/")
    return (f'<figure class="post-cover reveal">'
            f'<img src="{src}" alt="{h(post["cover_alt"])}"{dim} '
            f'loading="eager" fetchpriority="high" decoding="async">'
            f'</figure>')


def category_html(post) -> str:
    return f'<div class="post-cat">{h(post["category"])}</div>' if post["category"] else ""


def related_html(post) -> str:
    cats = [c for c in post["related"] if c in PORTFOLIO_CATS]
    if not cats:
        return ""
    links = "".join(
        f'<a class="rel-link" href="../../portfolio/{c}/" data-nav>'
        f'<i class="fa-solid fa-arrow-right" aria-hidden="true"></i> {h(PORTFOLIO_CATS[c])}</a>'
        for c in cats
    )
    return (f'<aside class="post-related reveal">'
            f'<div class="rel-h">Passende Portfolios</div>'
            f'<div class="rel-links">{links}</div></aside>')


def fill(template: str, mapping: dict) -> str:
    for k, v in mapping.items():
        template = template.replace("{{" + k + "}}", v)
    return template


# ── Artikelseite ──────────────────────────────────────────────────────────────
def render_article(post, tpl: str) -> str:
    return fill(tpl, {
        "TITLE": h(post["title"]),
        "DESCRIPTION": h(post["description"]),
        "CANONICAL": post["url"],
        "SEO_HEAD": seo_head(post),
        "CRUMB_TITLE": h(post["title"]),
        "CATEGORY_HTML": category_html(post),
        "DATE_ISO": post["date"].isoformat(),
        "DATE_HUMAN": human_date(post["date"]),
        "READING_TIME": str(post["reading_time"]),
        "TAGS_HTML": tags_html(post),
        "COVER_HTML": cover_html(post),
        "BODY": post["body_html"],
        "RELATED_HTML": related_html(post),
    })


# ── Übersichtsseite ───────────────────────────────────────────────────────────
def card_html(post) -> str:
    media = ""
    if post["cover"]:
        dim = (f' width="{post["cover_w"]}" height="{post["cover_h"]}"'
               if post["cover_w"] and post["cover_h"] else "")
        src = post["slug"] + "/" + quote(post["cover"], safe="/")
        media = (f'<div class="blog-card-media"><img src="{src}" '
                 f'alt="{h(post["cover_alt"])}"{dim} loading="lazy" decoding="async"></div>')
    cat = f'<div class="blog-card-cat">{h(post["category"])}</div>' if post["category"] else ""
    tags_attr = h("|".join(post["tags"]))
    return f'''        <article class="blog-card reveal" data-tags="{tags_attr}">
            <a class="blog-card-link" href="{post["slug"]}/" data-nav>
                {media}
                <div class="blog-card-body">
                    {cat}
                    <h2 class="blog-card-title">{h(post["title"])}</h2>
                    <p class="blog-card-excerpt">{h(post["excerpt"])}</p>
                    <div class="blog-card-meta">
                        <time datetime="{post["date"].isoformat()}">{human_date(post["date"])}</time>
                        <span aria-hidden="true">·</span>
                        <span>{post["reading_time"]} Min. Lesezeit</span>
                    </div>
                </div>
            </a>
        </article>'''


def index_seo_head(posts) -> str:
    blog = {
        "@context": "https://schema.org",
        "@type": "Blog",
        "name": "Blog – Benjamin Gillmann Photography",
        "url": SITE_URL + "/blog/",
        "inLanguage": "de-DE",
        "publisher": {"@id": BUSINESS_ID},
        "blogPost": [
            {"@type": "BlogPosting", "headline": p["title"], "url": p["url"],
             "datePublished": p["date"].isoformat(), "image": cover_abs(p)}
            for p in posts
        ],
    }
    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Start", "item": SITE_URL + "/"},
            {"@type": "ListItem", "position": 2, "name": "Blog", "item": SITE_URL + "/blog/"},
        ],
    }
    return "\n".join(
        '    <script type="application/ld+json">' + json.dumps(o, ensure_ascii=False) + '</script>'
        for o in (blog, breadcrumb)
    )


def render_index(posts, tpl: str) -> str:
    all_tags = []
    for p in posts:
        for t in p["tags"]:
            if t not in all_tags:
                all_tags.append(t)
    chips = ['<button type="button" class="blog-chip is-active" data-tag="*" aria-pressed="true">Alle</button>']
    chips += [f'<button type="button" class="blog-chip" data-tag="{h(t)}" aria-pressed="false">{h(t)}</button>'
              for t in sorted(all_tags, key=str.lower)]
    cards = "\n".join(card_html(p) for p in posts) or \
        '        <p class="pf-empty">Noch keine Beiträge – bald geht es los.</p>'
    count = f"{len(posts)} " + ("Beitrag" if len(posts) == 1 else "Beiträge")
    return fill(tpl, {
        "SEO_HEAD": index_seo_head(posts),
        "COUNT": count,
        "TAG_CHIPS": "".join(chips) if all_tags else "",
        "CARDS": cards,
    })


# ── Manifest / Feed / Sitemap ─────────────────────────────────────────────────
def write_posts_json(posts, out: Path) -> None:
    data = [{
        "slug": p["slug"],
        "url": f"/blog/{p['slug']}/",
        "title": p["title"],
        "description": p["description"],
        "excerpt": p["excerpt"],
        "date": p["date"].isoformat(),
        "dateHuman": human_date(p["date"]),
        "updated": p["updated"].isoformat(),
        "tags": p["tags"],
        "category": p["category"],
        "readingTime": p["reading_time"],
        "cover": (f"/blog/{p['slug']}/" + quote(p["cover"], safe="/")) if p["cover"] else "",
        "coverAlt": p["cover_alt"],
    } for p in posts]
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def rfc822(d: date) -> str:
    return datetime(d.year, d.month, d.day, 12, 0, 0).strftime("%a, %d %b %Y %H:%M:%S +0000")


def write_feed(posts, out: Path) -> None:
    now = rfc822(posts[0]["date"]) if posts else rfc822(date.today())
    L = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        '  <channel>',
        '    <title>Blog – Benjamin Gillmann Photography</title>',
        f'    <link>{SITE_URL}/blog/</link>',
        '    <description>Geschichten, Technik und Einblicke aus der Fotografie von Benjamin Gillmann.</description>',
        '    <language>de-DE</language>',
        f'    <lastBuildDate>{now}</lastBuildDate>',
        f'    <atom:link href="{SITE_URL}/blog/feed.xml" rel="self" type="application/rss+xml"/>',
    ]
    for p in posts:
        L += [
            '    <item>',
            f'      <title>{xescape(p["title"])}</title>',
            f'      <link>{p["url"]}</link>',
            f'      <guid isPermaLink="true">{p["url"]}</guid>',
            f'      <pubDate>{rfc822(p["date"])}</pubDate>',
            f'      <description>{xescape(p["excerpt"])}</description>',
        ]
        for t in p["tags"]:
            L.append(f'      <category>{xescape(t)}</category>')
        L.append('    </item>')
    L += ['  </channel>', '</rss>', '']
    out.write_text("\n".join(L), encoding="utf-8")


def write_blog_sitemap(posts, out: Path) -> None:
    last = max((p["updated"] for p in posts), default=date.today()).isoformat()
    L = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
        '  <url>',
        f'    <loc>{SITE_URL}/blog/</loc>',
        f'    <lastmod>{last}</lastmod>',
        '    <changefreq>weekly</changefreq>',
        '    <priority>0.7</priority>',
        '  </url>',
    ]
    for p in posts:
        L += [
            '  <url>',
            f'    <loc>{p["url"]}</loc>',
            f'    <lastmod>{p["updated"].isoformat()}</lastmod>',
            '    <changefreq>monthly</changefreq>',
            '    <priority>0.6</priority>',
        ]
        if p["cover"]:
            L += [
                '    <image:image>',
                f'      <image:loc>{cover_abs(p)}</image:loc>',
                f'      <image:caption>{xescape(p["cover_alt"])}</image:caption>',
                '    </image:image>',
            ]
        L.append('  </url>')
    L += ['</urlset>', '']
    out.write_text("\n".join(L), encoding="utf-8")


# ── main ──────────────────────────────────────────────────────────────────────
def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    blog_dir = Path(argv[1]) if len(argv) > 1 else Path("blog")
    site_root = Path(argv[2]) if len(argv) > 2 else Path(".")
    if not blog_dir.is_dir():
        print(f"FEHLER: Blog-Ordner nicht gefunden: {blog_dir}", file=sys.stderr)
        return 1

    art_tpl = (TEMPLATES / "blog_article.html").read_text(encoding="utf-8")
    idx_tpl = (TEMPLATES / "blog_index.html").read_text(encoding="utf-8")

    posts = []
    for d in sorted(blog_dir.iterdir()):
        if not d.is_dir() or not (d / "index.md").is_file():
            continue
        try:
            post = read_post(d)
        except Exception as e:
            print(f"  FEHLER in {d.name}/: {e}", file=sys.stderr)
            continue
        if post is None:
            continue
        posts.append(post)

    # Neueste zuerst
    posts.sort(key=lambda p: (p["date"], p["slug"]), reverse=True)

    for post in posts:
        (blog_dir / post["slug"] / "index.html").write_text(
            render_article(post, art_tpl), encoding="utf-8")
        print(f"  ✓ Beitrag: {post['slug']} ({post['reading_time']} Min.)")

    (blog_dir / "index.html").write_text(render_index(posts, idx_tpl), encoding="utf-8")
    write_posts_json(posts, blog_dir / "posts.json")
    write_feed(posts, blog_dir / "feed.xml")
    write_blog_sitemap(posts, blog_dir / "sitemap.xml")

    print(f"OK: {len(posts)} Beiträge -> {blog_dir}/index.html, posts.json, feed.xml, sitemap.xml")
    if not _HAS_PIL:
        print("Hinweis: Pillow nicht installiert -> Cover-Maße fehlen (kein CLS-Schutz).",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
