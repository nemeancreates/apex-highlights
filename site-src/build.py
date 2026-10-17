# Builds public/*.html from site-src/pages/*.html with the shared header,
# footer and leaf symbols. Run: python site-src/build.py
import os, re, sys
B=os.path.dirname(os.path.abspath(__file__))
OUT=os.path.join(B,'..','public')
DISCORD='https://discord.gg/HRepEcKWpM'
NAV=[('/#how','How it works','home-how'),('/browse','Browse sessions','browse'),('/mobile','Mobile','mobile'),('/guide','Guide','guide'),('/pricing','Pricing','pricing')]
def header(active):
    links=''.join(f'<a href="{h}"{" aria-current=\"page\"" if k==active else ""}>{t}</a>' for h,t,k in NAV)
    return f'''<header class="site-header"><div class="wrap">
<a class="brand" href="/" aria-label="Peakabu home"><span class="peek" aria-hidden="true"><span class="peek-in"><img class="peek-a" src="/site/img/badge-see-no-evil.png" alt="" width="40" height="40"><img class="peek-b" src="/site/img/badge-open.png" alt="" width="40" height="40"></span></span><span class="brand-name">Peakabu</span></a>
<nav class="nav-links" aria-label="Main">{links}</nav>
<div class="nav-actions"><a class="discord-link" href="{DISCORD}" target="_blank" rel="noopener">Discord</a><a class="btn btn-glow" href="/account" data-signin>Sign in</a><a class="btn btn-outline" href="/guide" data-download>Download</a></div>
</div></header>'''
FOOTER=f'''<footer class="site-footer"><div class="wrap">
<span class="brand-name" style="font-size:20px;color:var(--text)">Peakabu</span><span>We see the play, not you. · Patent pending · Peak-Abu LLC</span>
<nav aria-label="Footer"><a class="discord-link" href="{DISCORD}" target="_blank" rel="noopener">Discord</a><a href="/guide">Guide</a><a href="/pricing">Pricing</a><a href="/account">Account</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:peakabullc@gmail.com">Contact</a></nav>
</div></footer>'''
import json, re
_js=open(os.path.join(OUT,'site','site.js'), encoding='utf-8').read()
_sym=_js[_js.index("var SYMBOLS =")+len("var SYMBOLS ="):_js.index(";\n\n  function addSymbols")]
SYMBOLS='<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'+''.join(re.findall(r"'([^']*)'",_sym))+'</defs></svg>'
def head(title, desc, extra=''):
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="https://peakabu.app/site/img/badge-open.png">
<meta name="theme-color" content="#061009">
<link rel="icon" type="image/png" href="/site/img/badge-see-no-evil.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&amp;family=Work+Sans:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@400;600&amp;display=swap">
<link rel="stylesheet" href="/site/site.css">
{extra}
</head>'''
for fn in sorted(os.listdir(os.path.join(B,'pages'))):
    src=open(os.path.join(B,'pages',fn), encoding='utf-8').read()
    m=re.match(r'<!--\s*title:(.*?)\|desc:(.*?)\|active:(.*?)\s*-->\n',src,re.S)
    title,desc,active=[x.strip() for x in m.groups()]
    body=src[m.end():]
    extra=''
    em=re.search(r'<!--HEAD-->(.*?)<!--/HEAD-->',body,re.S)
    if em: extra=em.group(1).strip(); body=body[:em.start()]+body[em.end():]
    body=body.replace('{{HEADER}}',header(active)).replace('{{FOOTER}}',FOOTER)
    body=body.strip()
    # site.js first, so page scripts can use window.paAuth straight away
    tag='<script src="/site/site.js"></script>'
    i=body.find('<script')
    body=(body[:i]+tag+'\n'+body[i:]) if i>=0 else body+'\n'+tag
    out=head(title,desc,extra)+'\n<body>\n'+SYMBOLS+'\n'+body+'\n</body>\n</html>\n'
    open(os.path.join(OUT,fn),'w', encoding='utf-8', newline='\n').write(out); print('built',fn,len(out))
