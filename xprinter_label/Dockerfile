ARG BUILD_FROM=ghcr.io/home-assistant/base:3.23
FROM ${BUILD_FROM}

RUN apk add --no-cache \
    python3 \
    py3-pip \
    libusb \
    ttf-dejavu \
    && pip3 install --no-cache-dir --break-system-packages \
        Flask==3.1.1 \
        Pillow==11.2.1 \
        PyUSB==1.3.1 \
        qrcode==8.2

COPY app.py /app.py
COPY template.png /template.png

CMD ["python3", "/app.py"]
