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
GAP_DOTS = 16
FONT_PATH = "/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf"
OPTIONS_PATH = "/data/options.json"

app = Flask(__name__)
usb_lock = threading.Lock()


def load_api_key():
    try:
        with open(OPTIONS_PATH, "r", encoding="utf-8") as options_file:
            return str(json.load(options_file).get("api_key", ""))
    except (FileNotFoundError, json.JSONDecodeError):
        return ""


API_KEY = load_api_key()


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
    return label


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
        "SIZE 30 mm,20 mm\r\n"
        "GAP 2 mm,0 mm\r\n"
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


@app.get("/health")
def health():
    connected = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID) is not None
    return jsonify({"ok": True, "printer_connected": connected})


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


@app.post("/calibrate")
def calibrate():
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401
    try:
        # Calibrate once after loading a roll. Running this before every print
        # can advance an extra label.
        payload = (
            f"GAPDETECT {HEIGHT},{GAP_DOTS}\r\n"
            "HOME\r\n"
        ).encode("ascii")
        with usb_lock:
            send_usb(payload)
        return jsonify(
            {
                "ok": True,
                "label_length_dots": HEIGHT,
                "gap_dots": GAP_DOTS,
            }
        )
    except (RuntimeError, usb.core.USBError) as error:
        return jsonify({"error": str(error)}), 503


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8099")))
