// Explicit, fixed public sources only. No user account information is sent.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { createHash } = require('node:crypto');
const dir = path.join(__dirname, '../assets/icons');
async function main() {
  await fs.mkdir(dir, { recursive: true });
  const response = await fetch('https://api.github.com/repos/cellier/bank-icon-cn/contents/png/72');
  if (!response.ok) throw Error();
  const banks = await response.json();
  const names = [
    '中国工商银行',
    '中国农业银行',
    '中国建设银行',
    '中国银行',
    '交通银行',
    '招商银行',
    '中信银行',
    '中国光大银行',
    '中国民生银行',
    '兴业银行',
    '平安银行',
    '上海浦东发展银行',
    '广发银行',
    '华夏银行',
    '北京银行',
    '上海银行',
    '浙商银行',
  ];
  const sources = names.map((name) => ({
    name,
    source: banks.find((b) => b.name === name + '@3x.png')?.download_url,
  }));
  sources.push(
    { name: '支付宝', source: 'https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/alipay.svg' },
    { name: '微信', source: 'https://res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico' },
    { name: '京东金融', source: 'https://jr.jd.com/logo.png' },
  );
  const manifest = [];
  for (const item of sources) {
    if (!item.source) throw Error('Missing catalog source');
    const res = await fetch(item.source, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw Error('Public icon download failed');
    const raw = Buffer.from(await res.arrayBuffer());
    // Alipay's catalog SVG is an inverse mark. Mask within the glyph bounds to omit its frame.
    const glyphPath = item.name === '支付宝' ? raw.toString().match(/<path d="([^"]+)"/)[1] : '';
    const rasterSource = item.name === '支付宝' ? Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><mask id="glyph"><rect x="1.5" y="3.17" width="22.3" height="17" fill="white"/><path d="${glyphPath}" fill="black"/></mask></defs><rect width="24" height="24" fill="#1677ff" mask="url(#glyph)"/></svg>`) : raw;
    const file =
      String(manifest.length + 1).padStart(2, '0') +
      (item.source.endsWith('.ico') ? '.ico' : '.png');
    if (file.endsWith('.ico')) await fs.writeFile(path.join(dir, file), raw);
    else
      await fs.writeFile(
        path.join(dir, file),
        await sharp(rasterSource, { density: 768 })
          .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer(),
      );
    manifest.push({
      ...item,
      file: file.replace('.ico', '.png'),
      sha256: createHash('sha256').update(raw).digest('hex'),
    });
  }
  await fs.writeFile(path.join(dir, 'sources.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Downloaded ${manifest.length} public icons; convert ICO sources before seeding.`);
}
main().catch(() => {
  console.error('Icon source download failed; existing database icons were not changed.');
  process.exitCode = 1;
});
