"""Fetch public brand icons from the listed official websites; keep existing catalog."""
import hashlib, io, json, re, sys, urllib.request, urllib.parse
from pathlib import Path
from PIL import Image
folder = Path(__file__).resolve().parent.parent / 'assets' / 'icons'
catalog = json.loads((folder / 'sources.json').read_text(encoding='utf-8'))
brands = [('汇丰香港', 'https://www.hsbc.com.hk'), ('恒生银行', 'https://www.hangseng.com'), ('中银香港', 'https://www.bochk.com/en'), ('渣打香港', 'https://www.sc.com/hk'), ('东亚银行', 'https://www.hkbea.com'), ('星展香港', 'https://www.dbs.com.hk'), ('花旗香港', 'https://www.citibank.com.hk'), ('币安 Binance', 'https://www.binance.com'), ('Gate', 'https://www.gate.com'), ('Bybit', 'https://www.bybit.com'), ('Bitget', 'https://www.bitget.com')]
brands += [('ZA BANK 众安银行', 'https://bank.za.group'), ('大象银行 EleBank', 'https://www.elebank.com'), ('微众银行 WeBank', 'https://www.webank.com')]
if len(sys.argv) > 1:
    brands = [item for item in brands if item[0] in sys.argv[1:]]

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=20).read()
failed = []
for name, site in brands:
    if any(v['name'] == name for v in catalog): continue
    urls = {'币安 Binance': ['https://bin.bnbstatic.com/static/images/common/favicon.ico', 'https://bin.bnbstatic.com/static/images/common/favicon.png'], '中银香港': ['https://www.bochk.com/dam/bochk/desktop/top/favicon.ico', 'https://www.bochk.com/favicon.ico'], '大象银行 EleBank': ['https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/d4/bc/60/d4bc6004-3898-c9c3-3571-f3ffe4b46b48/Bank-Airstar-0-0-1x_U007epad-0-1-sRGB-85-220.png/512x512bb.jpg']}.get(name, [])
    if name == '微众银行 WeBank':
        try:
            script = get('https://tctp.tctpwebankcdn.net/owb-res/owb-res/assets/mainGenerator.811f2078.js').decode('utf-8')
            logo = re.search(r'Tr="(data:image/png;base64,[^"]+)"', script)
            if logo: urls.insert(0, logo.group(1))
        except Exception: pass
    try:
        html = get(site).decode('utf-8', errors='replace')
        for tag in re.findall(r'<link\b[^>]*>', html, re.I):
            attrs = dict(re.findall(r'([\w-]+)=["\']([^"\']*)["\']', tag))
            if 'icon' in attrs.get('rel', '').lower() and attrs.get('href'): urls.append(urllib.parse.urljoin(site + '/', attrs['href']))
    except Exception: pass
    urls += [urllib.parse.urljoin(site + '/', '/favicon.ico'), urllib.parse.urljoin(site + '/', '/favicon.png')]
    for url in dict.fromkeys(urls):
        try:
            raw = get(url)
            im = Image.open(io.BytesIO(raw)).convert('RGBA')
            im.thumbnail((256,256))
            out = io.BytesIO(); im.save(out, 'PNG'); png = out.getvalue()
            file = str(len(catalog) + 1).zfill(2) + '.png'
            (folder / file).write_bytes(png)
            catalog.append({'name':name,'source':site if url.startswith('data:') else url,'file':file,'sha256':hashlib.sha256(raw).hexdigest()})
            print('Added:', name)
            break
        except Exception: continue
    else: failed.append(name)
(folder / 'sources.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
if failed: print('Unavailable:', ', '.join(failed)); raise SystemExit(1)
