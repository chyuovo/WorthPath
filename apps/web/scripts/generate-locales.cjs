const fs = require('node:fs');
const path = require('node:path');
const OpenCC = require('opencc-js');
const folder = path.join(__dirname, '../src/locales');
const english = JSON.parse(fs.readFileSync(path.join(folder, 'en.json'), 'utf8'));
const convert = OpenCC.Converter({ from: 'cn', to: 'tw' });
const traditional = Object.fromEntries(
  Object.keys(english).map((key) => [key, key === '确定清空' ? key : convert(key)]),
);
fs.writeFileSync(path.join(folder, 'zh-Hant.json'), JSON.stringify(traditional, null, 2) + '\n');
console.log(`Generated ${Object.keys(traditional).length} Traditional Chinese phrases.`);
