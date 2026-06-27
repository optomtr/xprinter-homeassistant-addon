import base64
import io
import json
import os
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

import qrcode
import usb.core
import usb.util
from flask import Flask, jsonify, request, send_file
from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError


VENDOR_ID = 0x1FC9
PRODUCT_ID = 0x2016
DPI = 203
# XP-365B is a 203 DPI printer. In TSPL media settings it is more stable to
# use the practical 8 dots/mm pitch: 30x20 -> 240x160, 60x100 -> 480x800.
DOTS_PER_MM = 8
FONT_PATH = "/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf"
OPTIONS_PATH = "/data/options.json"
SMALL_TEMPLATE_PATH = "/template.png"
BUILTIN_TEMPLATE_DIR = Path("/templates")

app = Flask(__name__)
usb_lock = threading.Lock()


@dataclass(frozen=True)
class LabelProfile:
    name: str
    width_mm: float
    height_mm: float
    gap_mm: float
    margin_mm: float
    image_offset_dots: int
    black_pixel_bit: int
    density: int
    speed: float

    @property
    def width_dots(self):
        return round(self.width_mm * DOTS_PER_MM)

    @property
    def height_dots(self):
        return round(self.height_mm * DOTS_PER_MM)

    @property
    def gap_dots(self):
        return round(self.gap_mm * DOTS_PER_MM)

    @property
    def margin_dots(self):
        return round(self.margin_mm * DOTS_PER_MM)

    @property
    def bytes_per_row(self):
        return (self.width_dots + 7) // 8


def load_options():
    try:
        with open(OPTIONS_PATH, "r", encoding="utf-8") as options_file:
            return json.load(options_file)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


OPTIONS = load_options()
API_KEY = str(OPTIONS.get("api_key", ""))
DEFAULT_PROFILE = str(OPTIONS.get("default_profile", "small_30x20"))


def build_profiles():
    return {
        "small_30x20": LabelProfile(
            name="small_30x20",
            width_mm=30.0,
            height_mm=float(OPTIONS.get("label_height_mm", 20.0)),
            gap_mm=float(OPTIONS.get("gap_mm", 2.0)),
            margin_mm=0.0,
            image_offset_dots=int(OPTIONS.get("image_offset_dots", 0)),
            # Legacy mode: keep the old 30x20 bitmap polarity untouched.
            black_pixel_bit=1,
            density=int(OPTIONS.get("small_density", 8)),
            speed=float(OPTIONS.get("small_speed", 4.0)),
        ),
        "large_60x100": LabelProfile(
            name="large_60x100",
            width_mm=60.0,
            height_mm=float(OPTIONS.get("large_label_height_mm", 100.0)),
            gap_mm=float(OPTIONS.get("large_gap_mm", 4.0)),
            margin_mm=float(OPTIONS.get("large_margin_mm", 4.0)),
            image_offset_dots=int(OPTIONS.get("large_image_offset_dots", 0)),
            # New large labels use normal preview polarity: black preview prints black.
            black_pixel_bit=0,
            density=int(OPTIONS.get("large_density", 15)),
            speed=float(OPTIONS.get("large_speed", 2.0)),
        ),
    }


PROFILES = build_profiles()
BUILTIN_TEMPLATES = {
    "sensor_panel": {
        "title": "Питание сенсорной панели",
        "filename": "sensor_panel.jpg",
    },
    "curtain": {
        "title": "Питание электрокарниза",
        "filename": "curtain.jpg",
    },
    "speaker": {
        "title": "Колонка",
        "filename": "speaker.jpg",
    },
    "thermostat": {
        "title": "Питание терморегулятора",
        "filename": "thermostat.jpg",
    },
    "yandex_station": {
        "title": "Питание Яндекс Станции",
        "filename": "yandex_station.jpg",
    },
    "amplifier": {
        "title": "Усилитель",
        "filename": "amplifier.jpg",
    },
    "motion_sensor": {
        "title": "Питание датчика движения/присутствия",
        "filename": "motion_sensor.jpg",
    },
}


def authorized():
    if not API_KEY:
        return True
    return request.headers.get("X-API-Key", "") == API_KEY


def bool_param(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def get_request_data():
    if request.is_json:
        return request.get_json(silent=True) or {}
    return request.form.to_dict()


def get_profile(name=None):
    profile_name = str(name or DEFAULT_PROFILE or "small_30x20").strip()
    if profile_name not in PROFILES:
        raise ValueError(
            f"profile must be one of: {', '.join(sorted(PROFILES.keys()))}"
        )
    return PROFILES[profile_name]


def apply_image_offset(image, profile):
    if profile.image_offset_dots == 0:
        return image

    shifted = Image.new("1", image.size, 1)
    shifted.paste(image, (0, profile.image_offset_dots))
    return shifted


def make_qr(payload, size):
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=1,
    )
    qr.add_data(payload)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white").convert("1")
    return image.resize((size, size), Image.Resampling.NEAREST)


def make_small_qr_label(text, qr_payload):
    profile = PROFILES["small_30x20"]
    label = Image.new("1", (profile.width_dots, profile.height_dots), 1)

    # Preserve the exact BMS logo area from the supplied 30x20 mm PDF.
    template = Image.open(SMALL_TEMPLATE_PATH).convert("1")
    label.paste(template.crop((185, 0, profile.width_dots, profile.height_dots)), (185, 0))
    label.paste(make_qr(qr_payload, 144), (7, 8))

    font = ImageFont.truetype(FONT_PATH, 14)
    text_image = Image.new("1", (130, 22), 1)
    draw = ImageDraw.Draw(text_image)
    box = draw.textbbox((0, 0), text, font=font)
    text_width = box[2] - box[0]
    draw.text(((130 - text_width) // 2, 2), text, fill=0, font=font)
    vertical_text = text_image.rotate(90, expand=True)
    label.paste(vertical_text, (158, 15))

    return apply_image_offset(label, profile)


def wrap_text(draw, text, font, max_width):
    lines = []

    def split_long_word(word):
        chunks = []
        current = ""
        for char in word:
            candidate = f"{current}{char}"
            if draw.textlength(candidate, font=font) <= max_width:
                current = candidate
                continue
            if current:
                chunks.append(current)
            current = char
        if current:
            chunks.append(current)
        return chunks

    for paragraph in text.splitlines() or [""]:
        words = paragraph.split()
        if not words:
            lines.append("")
            continue

        current = ""
        for word in words:
            candidate = word if not current else f"{current} {word}"
            if draw.textlength(candidate, font=font) <= max_width:
                current = candidate
                continue

            if current:
                lines.append(current)
            if draw.textlength(word, font=font) <= max_width:
                current = word
            else:
                wrapped_word = split_long_word(word)
                lines.extend(wrapped_word[:-1])
                current = wrapped_word[-1] if wrapped_word else ""

        if current:
            lines.append(current)

    return lines


def make_text_label(text, profile, font_size=22, align="center"):
    label = Image.new("1", (profile.width_dots, profile.height_dots), 1)
    draw = ImageDraw.Draw(label)
    margin = max(profile.margin_dots, 10)
    max_width = profile.width_dots - margin * 2
    max_height = profile.height_dots - margin * 2
    font = ImageFont.truetype(FONT_PATH, font_size)
    line_spacing = max(3, font_size // 5)

    lines = wrap_text(draw, text, font, max_width)
    while font_size > 10:
        line_heights = [
            draw.textbbox((0, 0), line or " ", font=font)[3]
            - draw.textbbox((0, 0), line or " ", font=font)[1]
            for line in lines
        ]
        total_height = sum(line_heights) + line_spacing * max(0, len(lines) - 1)
        widest = max((draw.textlength(line, font=font) for line in lines), default=0)
        if total_height <= max_height and widest <= max_width:
            break
        font_size -= 1
        font = ImageFont.truetype(FONT_PATH, font_size)
        line_spacing = max(3, font_size // 5)
        lines = wrap_text(draw, text, font, max_width)

    line_heights = [
        draw.textbbox((0, 0), line or " ", font=font)[3]
        - draw.textbbox((0, 0), line or " ", font=font)[1]
        for line in lines
    ]
    total_height = sum(line_heights) + line_spacing * max(0, len(lines) - 1)
    y = max(margin, (profile.height_dots - total_height) // 2)

    for line, line_height in zip(lines, line_heights):
        line_width = draw.textlength(line, font=font)
        if align == "left":
            x = margin
        elif align == "right":
            x = profile.width_dots - margin - line_width
        else:
            x = (profile.width_dots - line_width) // 2
        draw.text((x, y), line, fill=0, font=font)
        y += line_height + line_spacing

    return apply_image_offset(label, profile)


def to_monochrome(image, invert_image=False, threshold=180):
    image = ImageOps.exif_transpose(image)
    if image.mode in {"RGBA", "LA"}:
        background = Image.new("RGBA", image.size, "white")
        background.alpha_composite(image.convert("RGBA"))
        image = background.convert("RGB")
    image = ImageOps.autocontrast(image.convert("L"))
    if invert_image:
        image = ImageOps.invert(image)
    return image.point(lambda pixel: 0 if pixel < threshold else 255, "1")


def render_pdf_first_page(data, target_width, target_height):
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = Path(tmpdir) / "upload.pdf"
        output_prefix = Path(tmpdir) / "page"
        pdf_path.write_bytes(data)
        subprocess.run(
            [
                "pdftoppm",
                "-f",
                "1",
                "-singlefile",
                "-r",
                str(DPI),
                "-png",
                str(pdf_path),
                str(output_prefix),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        image_path = Path(f"{output_prefix}.png")
        image = Image.open(image_path)
        image.load()
        return image


def load_uploaded_image(data, filename="", content_type=""):
    suffix = Path(filename or "").suffix.lower()
    content_type = (content_type or "").lower()
    if suffix == ".pdf" or content_type == "application/pdf":
        return render_pdf_first_page(data, 1, 1)

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        return image
    except UnidentifiedImageError as error:
        raise ValueError("file must be an image or a PDF") from error


def fit_image_to_box(image, box_width, box_height, fit):
    if fit == "stretch":
        return image.resize((box_width, box_height), Image.Resampling.LANCZOS)

    source_width, source_height = image.size
    if source_width <= 0 or source_height <= 0:
        raise ValueError("file image has invalid dimensions")

    if fit == "cover":
        scale = max(box_width / source_width, box_height / source_height)
    else:
        scale = min(box_width / source_width, box_height / source_height)

    new_size = (
        max(1, round(source_width * scale)),
        max(1, round(source_height * scale)),
    )
    resized = image.resize(new_size, Image.Resampling.LANCZOS)

    if fit == "cover":
        left = max(0, (resized.width - box_width) // 2)
        top = max(0, (resized.height - box_height) // 2)
        return resized.crop((left, top, left + box_width, top + box_height))

    return resized


def make_file_label(
    data,
    filename,
    content_type,
    profile,
    fit="contain",
    invert_image=False,
    full_bleed=False,
    threshold=180,
):
    if fit not in {"contain", "cover", "stretch"}:
        raise ValueError("fit must be contain, cover, or stretch")

    source = load_uploaded_image(data, filename, content_type)
    source = to_monochrome(source, invert_image, threshold)

    label = Image.new("1", (profile.width_dots, profile.height_dots), 1)
    margin = 0 if full_bleed else profile.margin_dots
    box_width = profile.width_dots - margin * 2
    box_height = profile.height_dots - margin * 2
    fitted = fit_image_to_box(source, box_width, box_height, fit)
    x = margin + (box_width - fitted.width) // 2
    y = margin + (box_height - fitted.height) // 2
    label.paste(fitted, (x, y))

    return apply_image_offset(label, profile)


def get_builtin_template(template_id):
    template_id = str(template_id or "").strip()
    if template_id not in BUILTIN_TEMPLATES:
        raise ValueError(
            f"template must be one of: {', '.join(sorted(BUILTIN_TEMPLATES.keys()))}"
        )
    return template_id, BUILTIN_TEMPLATES[template_id]


def make_builtin_template_label(template_id):
    template_id, template = get_builtin_template(template_id)
    profile = PROFILES["large_60x100"]
    image_path = BUILTIN_TEMPLATE_DIR / template["filename"]
    if not image_path.exists():
        raise ValueError(f"template asset is missing: {template_id}")

    source = Image.open(image_path)
    source.load()
    source = to_monochrome(source, False, 180)
    label = Image.new("1", (profile.width_dots, profile.height_dots), 1)
    fitted = fit_image_to_box(
        source,
        profile.width_dots,
        profile.height_dots,
        "stretch",
    )
    label.paste(fitted, (0, 0))
    return apply_image_offset(label, profile)


def image_to_tspl(image, profile, copies):
    monochrome = image.convert("1")
    bitmap = bytearray()

    for y in range(profile.height_dots):
        for byte_x in range(profile.bytes_per_row):
            value = 0
            for bit in range(8):
                x = byte_x * 8 + bit
                if x >= profile.width_dots:
                    continue
                black_pixel = monochrome.getpixel((x, y)) == 0
                bit_is_one = black_pixel if profile.black_pixel_bit == 1 else not black_pixel
                if bit_is_one:
                    value |= 1 << (7 - bit)
            bitmap.append(value)

    setup = (
        f"SIZE {profile.width_mm:g} mm,{profile.height_mm:g} mm\r\n"
        f"GAP {profile.gap_mm:g} mm,0 mm\r\n"
        f"DENSITY {profile.density}\r\n"
        f"SPEED {profile.speed:g}\r\n"
        "DIRECTION 1\r\n"
        "REFERENCE 0,0\r\n"
        "SET TEAR OFF\r\n"
    ).encode("ascii")
    label = (
        "CLS\r\n"
        f"BITMAP 0,0,{profile.bytes_per_row},{profile.height_dots},0,"
    ).encode("ascii") + bytes(bitmap) + b"\r\nPRINT 1,1\r\n"

    return setup + label * copies


def send_usb(payload):
    device = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)
    if device is None:
        raise RuntimeError("Xprinter 1fc9:2016 is not connected")

    interface_number = 0
    detached = False

    try:
        if device.is_kernel_driver_active(interface_number):
            device.detach_kernel_driver(interface_number)
            detached = True

        device.set_configuration()
        configuration = device.get_active_configuration()
        interface = configuration[(interface_number, 0)]
        endpoint = usb.util.find_descriptor(
            interface,
            custom_match=lambda item: (
                usb.util.endpoint_direction(item.bEndpointAddress)
                == usb.util.ENDPOINT_OUT
            ),
        )
        if endpoint is None:
            raise RuntimeError("USB printer output endpoint was not found")

        usb.util.claim_interface(device, interface_number)
        endpoint.write(payload, timeout=10000)
    finally:
        try:
            usb.util.release_interface(device, interface_number)
        except usb.core.USBError:
            pass
        usb.util.dispose_resources(device)
        if detached:
            try:
                device.attach_kernel_driver(interface_number)
            except usb.core.USBError:
                pass


def parse_qr_request():
    body = get_request_data()
    text = str(body.get("text", "ID:ASD-1294")).strip()
    qr_payload = str(body.get("qr", "ASD-1294")).strip()
    copies = int(body.get("copies", 1))

    if not text or not qr_payload:
        raise ValueError("text and qr must not be empty")
    if len(text) > 18:
        raise ValueError("text must contain at most 18 characters")
    if not 1 <= copies <= 20:
        raise ValueError("copies must be between 1 and 20")

    return text, qr_payload, copies


def parse_text_request():
    body = get_request_data()
    text = str(body.get("text", "")).strip()
    copies = int(body.get("copies", 1))
    font_size = int(body.get("font_size", 22))
    align = str(body.get("align", "center")).strip().lower()
    profile = get_profile(body.get("profile"))

    if not text:
        raise ValueError("text must not be empty")
    if len(text) > 2000:
        raise ValueError("text must contain at most 2000 characters")
    if profile.name == "small_30x20" and len(text) > 300:
        raise ValueError("text must contain at most 300 characters for small_30x20")
    if not 1 <= copies <= 20:
        raise ValueError("copies must be between 1 and 20")
    if not 10 <= font_size <= 96:
        raise ValueError("font_size must be between 10 and 96")
    if align not in {"left", "center", "right"}:
        raise ValueError("align must be left, center, or right")

    return text, copies, font_size, align, profile


def parse_file_request():
    body = get_request_data()
    profile = get_profile(body.get("profile"))
    copies = int(body.get("copies", 1))
    fit = str(body.get("fit", "contain")).strip().lower()
    invert_image = bool_param(body.get("invert"), False)
    full_bleed = bool_param(body.get("full_bleed"), False)
    threshold = int(body.get("threshold", 180))

    if not 1 <= copies <= 20:
        raise ValueError("copies must be between 1 and 20")
    if fit not in {"contain", "cover", "stretch"}:
        raise ValueError("fit must be contain, cover, or stretch")
    if not 1 <= threshold <= 254:
        raise ValueError("threshold must be between 1 and 254")

    uploaded = request.files.get("file")
    if uploaded:
        data = uploaded.read()
        filename = uploaded.filename or "upload"
        content_type = uploaded.content_type or ""
    else:
        data_b64 = str(body.get("file_base64", "")).strip()
        if not data_b64:
            raise ValueError("file or file_base64 is required")
        try:
            data = base64.b64decode(data_b64, validate=True)
        except ValueError as error:
            raise ValueError("file_base64 is not valid base64") from error
        filename = str(body.get("filename", "upload")).strip() or "upload"
        content_type = str(body.get("content_type", "")).strip()

    if not data:
        raise ValueError("file must not be empty")
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("file must be at most 8 MB")

    return data, filename, content_type, profile, copies, fit, invert_image, full_bleed, threshold


def parse_template_request():
    body = get_request_data()
    template_id = str(body.get("template", body.get("template_id", ""))).strip()
    copies = int(body.get("copies", 1))

    if not 1 <= copies <= 20:
        raise ValueError("copies must be between 1 and 20")

    template_id, template = get_builtin_template(template_id)
    return template_id, template, copies


def png_response(image):
    output = io.BytesIO()
    image.convert("L").save(output, format="PNG")
    output.seek(0)
    return send_file(output, mimetype="image/png")


@app.get("/")
def index():
    template_options = "\n".join(
        f'<option value="{template_id}">{template["title"]}</option>'
        for template_id, template in BUILTIN_TEMPLATES.items()
    )
    return """
<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<title>Xprinter Label</title>
<body style="font-family: system-ui, sans-serif; max-width: 760px; margin: 32px auto;">
  <h1>Xprinter Label</h1>
  <p>Use this page for quick file previews and manual file printing. The API is intended for automation.</p>
  <form action="/preview-template" method="post">
    <h2>Preview default label</h2>
    <label>Template:
      <select name="template">
        __TEMPLATE_OPTIONS__
      </select>
    </label>
    <p><button type="submit">Preview</button></p>
  </form>
  <form action="/print-template" method="post">
    <h2>Print default label</h2>
    <label>Template:
      <select name="template">
        __TEMPLATE_OPTIONS__
      </select>
    </label>
    <label>Copies:
      <input name="copies" type="number" value="1" min="1" max="20">
    </label>
    <p><button type="submit">Print</button></p>
  </form>
  <form action="/preview-file" method="post" enctype="multipart/form-data">
    <h2>Preview uploaded file</h2>
    <label>Profile:
      <select name="profile">
        <option value="small_30x20">30x20 mm</option>
        <option value="large_60x100" selected>60x100 mm</option>
      </select>
    </label>
    <label>Fit:
      <select name="fit">
        <option value="contain" selected>contain</option>
        <option value="cover">cover</option>
        <option value="stretch">stretch</option>
      </select>
    </label>
    <label><input type="checkbox" name="full_bleed" value="true"> Full bleed</label>
    <p><input type="file" name="file" required></p>
    <p><button type="submit">Preview</button></p>
  </form>
  <form action="/print-file" method="post" enctype="multipart/form-data">
    <h2>Print uploaded file</h2>
    <label>Profile:
      <select name="profile">
        <option value="small_30x20">30x20 mm</option>
        <option value="large_60x100" selected>60x100 mm</option>
      </select>
    </label>
    <label>Fit:
      <select name="fit">
        <option value="contain" selected>contain</option>
        <option value="cover">cover</option>
        <option value="stretch">stretch</option>
      </select>
    </label>
    <label><input type="checkbox" name="full_bleed" value="true"> Full bleed</label>
    <label>Copies:
      <input name="copies" type="number" value="1" min="1" max="20">
    </label>
    <p><input type="file" name="file" required></p>
    <p><button type="submit">Print</button></p>
  </form>
</body>
</html>
""".replace("__TEMPLATE_OPTIONS__", template_options)


@app.get("/health")
def health():
    connected = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID) is not None
    return jsonify(
        {
            "ok": True,
            "printer_connected": connected,
            "default_profile": DEFAULT_PROFILE,
            "profiles": {
                name: {
                    "width_mm": profile.width_mm,
                    "height_mm": profile.height_mm,
                    "gap_mm": profile.gap_mm,
                    "margin_mm": profile.margin_mm,
                    "image_offset_dots": profile.image_offset_dots,
                    "density": profile.density,
                    "speed": profile.speed,
                    "width_dots": profile.width_dots,
                    "height_dots": profile.height_dots,
                }
                for name, profile in PROFILES.items()
            },
            "templates": {
                template_id: {"title": template["title"]}
                for template_id, template in BUILTIN_TEMPLATES.items()
            },
        }
    )


@app.get("/templates")
def templates():
    return jsonify(
        {
            "templates": {
                template_id: {
                    "title": template["title"],
                    "profile": "large_60x100",
                    "width_mm": PROFILES["large_60x100"].width_mm,
                    "height_mm": PROFILES["large_60x100"].height_mm,
                }
                for template_id, template in BUILTIN_TEMPLATES.items()
            }
        }
    )


@app.post("/preview")
def preview():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        text, qr_payload, _ = parse_qr_request()
        return png_response(make_small_qr_label(text, qr_payload))
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400


@app.post("/preview-text")
def preview_text():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        text, _, font_size, align, profile = parse_text_request()
        return png_response(make_text_label(text, profile, font_size, align))
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400


@app.post("/preview-file")
def preview_file():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        (
            data,
            filename,
            content_type,
            profile,
            _,
            fit,
            invert_image,
            full_bleed,
            threshold,
        ) = parse_file_request()
        return png_response(
            make_file_label(
                data,
                filename,
                content_type,
                profile,
                fit,
                invert_image,
                full_bleed,
                threshold,
            )
        )
    except (TypeError, ValueError, subprocess.CalledProcessError) as error:
        return jsonify({"error": str(error)}), 400


@app.post("/preview-template")
def preview_template():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        template_id, _, _ = parse_template_request()
        return png_response(make_builtin_template_label(template_id))
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400


@app.post("/print")
def print_label():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        text, qr_payload, copies = parse_qr_request()
        profile = PROFILES["small_30x20"]
        payload = image_to_tspl(make_small_qr_label(text, qr_payload), profile, copies)
        with usb_lock:
            send_usb(payload)
        return jsonify(
            {
                "ok": True,
                "profile": profile.name,
                "text": text,
                "qr": qr_payload,
                "copies": copies,
            }
        )
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400
    except (RuntimeError, usb.core.USBError) as error:
        return jsonify({"error": str(error)}), 503


@app.post("/print-text")
def print_text():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        text, copies, font_size, align, profile = parse_text_request()
        payload = image_to_tspl(
            make_text_label(text, profile, font_size, align), profile, copies
        )
        with usb_lock:
            send_usb(payload)
        return jsonify(
            {
                "ok": True,
                "profile": profile.name,
                "text": text,
                "copies": copies,
                "font_size": font_size,
                "align": align,
            }
        )
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400
    except (RuntimeError, usb.core.USBError) as error:
        return jsonify({"error": str(error)}), 503


@app.post("/print-file")
def print_file():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        (
            data,
            filename,
            content_type,
            profile,
            copies,
            fit,
            invert_image,
            full_bleed,
            threshold,
        ) = parse_file_request()
        payload = image_to_tspl(
            make_file_label(
                data,
                filename,
                content_type,
                profile,
                fit,
                invert_image,
                full_bleed,
                threshold,
            ),
            profile,
            copies,
        )
        with usb_lock:
            send_usb(payload)
        return jsonify(
            {
                "ok": True,
                "profile": profile.name,
                "filename": filename,
                "copies": copies,
                "fit": fit,
                "invert": invert_image,
                "full_bleed": full_bleed,
                "threshold": threshold,
            }
        )
    except (TypeError, ValueError, subprocess.CalledProcessError) as error:
        return jsonify({"error": str(error)}), 400
    except (RuntimeError, usb.core.USBError) as error:
        return jsonify({"error": str(error)}), 503


@app.post("/print-template")
def print_template():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        template_id, template, copies = parse_template_request()
        profile = PROFILES["large_60x100"]
        payload = image_to_tspl(
            make_builtin_template_label(template_id),
            profile,
            copies,
        )
        with usb_lock:
            send_usb(payload)
        return jsonify(
            {
                "ok": True,
                "profile": profile.name,
                "template": template_id,
                "title": template["title"],
                "copies": copies,
            }
        )
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400
    except (RuntimeError, usb.core.USBError) as error:
        return jsonify({"error": str(error)}), 503


@app.post("/calibrate")
def calibrate():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        profile = get_profile(get_request_data().get("profile"))
        payload = (
            f"GAPDETECT {profile.height_dots},{profile.gap_dots}\r\n"
            "HOME\r\n"
        ).encode("ascii")
        with usb_lock:
            send_usb(payload)
        return jsonify(
            {
                "ok": True,
                "profile": profile.name,
                "label_length_dots": profile.height_dots,
                "gap_dots": profile.gap_dots,
            }
        )
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400
    except (RuntimeError, usb.core.USBError) as error:
        return jsonify({"error": str(error)}), 503


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8099")))
