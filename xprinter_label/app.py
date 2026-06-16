import io
import json
import os
import threading

import qrcode
import usb.core
import usb.util
from flask import Flask, jsonify, request, send_file
from PIL import Image, ImageDraw, ImageFont


VENDOR_ID = 0x1FC9
PRODUCT_ID = 0x2016
WIDTH = 240
HEIGHT = 160
BYTES_PER_ROW = WIDTH // 8
FONT_PATH = "/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf"
OPTIONS_PATH = "/data/options.json"

app = Flask(__name__)
usb_lock = threading.Lock()


def load_options():
    try:
        with open(OPTIONS_PATH, "r", encoding="utf-8") as options_file:
            return json.load(options_file)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


OPTIONS = load_options()
API_KEY = str(OPTIONS.get("api_key", ""))
LABEL_HEIGHT_MM = float(OPTIONS.get("label_height_mm", 20.0))
GAP_MM = float(OPTIONS.get("gap_mm", 2.0))
IMAGE_OFFSET_DOTS = int(OPTIONS.get("image_offset_dots", 0))


def authorized():
    if not API_KEY:
        return True
    return request.headers.get("X-API-Key", "") == API_KEY


def make_qr(payload):
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=1,
    )
    qr.add_data(payload)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white").convert("1")
    return image.resize((144, 144), Image.Resampling.NEAREST)


def make_label(text, qr_payload):
    label = Image.new("1", (WIDTH, HEIGHT), 1)

    # Preserve the exact BMS logo from the supplied 30x20 mm PDF.
    template = Image.open("/template.png").convert("1")
    label.paste(template.crop((185, 0, WIDTH, HEIGHT)), (185, 0))
    label.paste(make_qr(qr_payload), (7, 8))

    font = ImageFont.truetype(FONT_PATH, 14)
    text_image = Image.new("1", (130, 22), 1)
    draw = ImageDraw.Draw(text_image)
    box = draw.textbbox((0, 0), text, font=font)
    text_width = box[2] - box[0]
    draw.text(
        ((130 - text_width) // 2, 2),
        text,
        fill=0,
        font=font,
    )
    vertical_text = text_image.rotate(90, expand=True)
    label.paste(vertical_text, (158, 15))

    if IMAGE_OFFSET_DOTS == 0:
        return label

    shifted = Image.new("1", (WIDTH, HEIGHT), 1)
    shifted.paste(label, (0, IMAGE_OFFSET_DOTS))
    return shifted


def apply_image_offset(image):
    if IMAGE_OFFSET_DOTS == 0:
        return image

    shifted = Image.new("1", (WIDTH, HEIGHT), 1)
    shifted.paste(image, (0, IMAGE_OFFSET_DOTS))
    return shifted


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


def make_text_label(text, font_size=22, align="center"):
    label = Image.new("1", (WIDTH, HEIGHT), 1)
    draw = ImageDraw.Draw(label)
    font = ImageFont.truetype(FONT_PATH, font_size)
    max_width = WIDTH - 20
    max_height = HEIGHT - 16
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
    y = max(0, (HEIGHT - total_height) // 2)

    for line, line_height in zip(lines, line_heights):
        line_width = draw.textlength(line, font=font)
        if align == "left":
            x = 10
        elif align == "right":
            x = WIDTH - 10 - line_width
        else:
            x = (WIDTH - line_width) // 2
        draw.text((x, y), line, fill=0, font=font)
        y += line_height + line_spacing

    return apply_image_offset(label)


def image_to_tspl(image, copies):
    monochrome = image.convert("1")
    bitmap = bytearray()

    for y in range(HEIGHT):
        for byte_x in range(BYTES_PER_ROW):
            value = 0
            for bit in range(8):
                x = byte_x * 8 + bit
                if monochrome.getpixel((x, y)) == 0:
                    value |= 1 << (7 - bit)
            bitmap.append(value)

    setup = (
        f"SIZE 30 mm,{LABEL_HEIGHT_MM:g} mm\r\n"
        f"GAP {GAP_MM:g} mm,0 mm\r\n"
        "DENSITY 8\r\n"
        "DIRECTION 1\r\n"
        "REFERENCE 0,0\r\n"
        "SET TEAR OFF\r\n"
    ).encode("ascii")
    label = (
        "CLS\r\n"
        f"BITMAP 0,0,{BYTES_PER_ROW},{HEIGHT},0,"
    ).encode("ascii") + bytes(bitmap) + b"\r\nPRINT 1,1\r\n"

    # GAP mode aligns each print to the sensor. HOME is intentionally omitted:
    # running it after PRINT has already advanced the media skips one label.
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


def parse_request():
    body = request.get_json(silent=True) or {}
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
    body = request.get_json(silent=True) or {}
    text = str(body.get("text", "")).strip()
    copies = int(body.get("copies", 1))
    font_size = int(body.get("font_size", 22))
    align = str(body.get("align", "center")).strip().lower()

    if not text:
        raise ValueError("text must not be empty")
    if len(text) > 300:
        raise ValueError("text must contain at most 300 characters")
    if not 1 <= copies <= 20:
        raise ValueError("copies must be between 1 and 20")
    if not 10 <= font_size <= 48:
        raise ValueError("font_size must be between 10 and 48")
    if align not in {"left", "center", "right"}:
        raise ValueError("align must be left, center, or right")

    return text, copies, font_size, align


@app.get("/health")
def health():
    connected = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID) is not None
    return jsonify(
        {
            "ok": True,
            "printer_connected": connected,
            "label_height_mm": LABEL_HEIGHT_MM,
            "gap_mm": GAP_MM,
            "image_offset_dots": IMAGE_OFFSET_DOTS,
        }
    )


@app.post("/preview")
def preview():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        text, qr_payload, _ = parse_request()
        image = make_label(text, qr_payload).convert("L")
        output = io.BytesIO()
        image.save(output, format="PNG")
        output.seek(0)
        return send_file(output, mimetype="image/png")
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400


@app.post("/preview-text")
def preview_text():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        text, _, font_size, align = parse_text_request()
        image = make_text_label(text, font_size, align).convert("L")
        output = io.BytesIO()
        image.save(output, format="PNG")
        output.seek(0)
        return send_file(output, mimetype="image/png")
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400


@app.post("/print")
def print_label():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        text, qr_payload, copies = parse_request()
        payload = image_to_tspl(make_label(text, qr_payload), copies)
        with usb_lock:
            send_usb(payload)
        return jsonify(
            {
                "ok": True,
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
        text, copies, font_size, align = parse_text_request()
        payload = image_to_tspl(make_text_label(text, font_size, align), copies)
        with usb_lock:
            send_usb(payload)
        return jsonify(
            {
                "ok": True,
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


@app.post("/calibrate")
def calibrate():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        # Calibrate once after loading a roll. Running this before every print
        # can advance an extra label.
        label_height_dots = round(LABEL_HEIGHT_MM * 8)
        gap_dots = round(GAP_MM * 8)
        payload = (
            f"GAPDETECT {label_height_dots},{gap_dots}\r\n"
            "HOME\r\n"
        ).encode("ascii")
        with usb_lock:
            send_usb(payload)
        return jsonify(
            {
                "ok": True,
                "label_length_dots": label_height_dots,
                "gap_dots": gap_dots,
            }
        )
    except (RuntimeError, usb.core.USBError) as error:
        return jsonify({"error": str(error)}), 503


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8099")))
