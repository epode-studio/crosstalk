# Chrome screenshots the whole window; trim the transparent margin around the card.
import sys
from PIL import Image

for p in sys.argv[1:]:
    im = Image.open(p).convert("RGBA")
    box = im.getchannel("A").getbbox()
    if box:
        im.crop(box).save(p)
