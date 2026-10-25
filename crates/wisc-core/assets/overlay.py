"""Draw measured/model positions on the unfiltered base image, without plotting libraries."""
import h5py
from PIL import Image, ImageDraw

image = Image.open("base.png").convert("RGB")
draw = ImageDraw.Draw(image)
with h5py.File("calibration.h5", "r") as f:
    for star in f["selected_stars"][:]:
        measured = (float(star[5] - 1), float(star[4] - 1))
        model = (float(star[10] - 1), float(star[9] - 1))
        draw.line([measured, model], fill="yellow", width=1)
        for (x, y), color in [(measured, "cyan"), (model, "orange")]:
            draw.ellipse((x - 4, y - 4, x + 4, y + 4), outline=color, width=1)
image.save("overlay.png")
