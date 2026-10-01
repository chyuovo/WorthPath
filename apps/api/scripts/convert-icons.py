"""Optional catalog maintenance: convert downloaded ICO files using Pillow.

Normal installs use the committed PNG assets and do not need Python.
Run after download-icons.cjs, before icons:seed.
"""
from pathlib import Path
from PIL import Image

folder = Path(__file__).resolve().parent.parent / 'assets' / 'icons'
for source in folder.glob('*.ico'):
    with Image.open(source) as image:
        image.convert('RGBA').save(source.with_suffix('.png'))
    source.unlink()
print('Catalog ICO sources converted to PNG.')
