# Xprinter XP-365B for Home Assistant Green

Local Home Assistant add-on for printing 30x20 mm labels through USB.

Russian API documentation for integrators:
[INTEGRATION_RU.md](INTEGRATION_RU.md).

The printer is selected by its stable USB ID:

- Vendor: `1fc9`
- Product: `2016`

## Installation

1. Open **Settings > Apps > App store** in Home Assistant.
2. Open the menu in the upper-right corner and select **Repositories**.
3. Add:

   ```text
   https://github.com/optomtr/xprinter-homeassistant-addon
   ```

4. Find and install **Xprinter Label**.
5. Start the app and enable **Start on boot**.
6. Open `http://HOME_ASSISTANT_IP:8099/health` and verify that
   `printer_connected` is `true`.

This is a Home Assistant app/add-on repository, not a HACS integration.

## Home Assistant configuration

Add this to `configuration.yaml`, replacing the IP address:

```yaml
rest_command:
  xprinter_label:
    url: "http://HOME_ASSISTANT_IP:8099/print"
    method: POST
    content_type: "application/json"
    payload: >-
      {
        "text": {{ text | tojson }},
        "qr": {{ qr | tojson }},
        "copies": {{ copies | default(1) | int }}
      }
  xprinter_calibrate:
    url: "http://HOME_ASSISTANT_IP:8099/calibrate"
    method: POST
  xprinter_text:
    url: "http://HOME_ASSISTANT_IP:8099/print-text"
    method: POST
    content_type: "application/json"
    payload: >-
      {
        "text": {{ text | tojson }},
        "profile": {{ profile | default("small_30x20") | tojson }},
        "copies": {{ copies | default(1) | int }},
        "font_size": {{ font_size | default(22) | int }},
        "align": {{ align | default("center") | tojson }}
      }
  xprinter_template:
    url: "http://HOME_ASSISTANT_IP:8099/print-template"
    method: POST
    content_type: "application/json"
    payload: >-
      {
        "template": {{ template | tojson }},
        "copies": {{ copies | default(1) | int }}
      }
```

Restart Home Assistant after changing `configuration.yaml`.

Run calibration once after loading or replacing a label roll:

```yaml
action: rest_command.xprinter_calibrate
```

The printer will feed several labels while detecting the 20 mm label length
and 2 mm gap. Do not run calibration before every print.

Example action:

```yaml
action: rest_command.xprinter_label
data:
  text: "ID:ASD-1294"
  qr: "ASD-1294"
  copies: 1
```

Starting with version `1.0.4`, gap sensing remains enabled while tear mode is
disabled. The next label stays aligned with the printhead without feeding an
extra blank label.

## Manual media adjustment

Open the add-on **Configuration** tab and adjust:

- `default_profile`: used when a request does not send `profile`.
- `label_height_mm`: physical label length in the feed direction. Default `20`.
- `gap_mm`: physical gap between labels. Default `2`.
- `image_offset_dots`: moves the complete design inside the label. Positive
  values move it down, negative values move it up. At 203 DPI, 8 dots are
  approximately 1 mm.
- `large_label_height_mm`: large label height. Default `100`.
- `large_gap_mm`: large label gap. Default `4`.
- `large_margin_mm`: large label printable margin. Default `4`.
- `large_image_offset_dots`: vertical offset for large labels.

Save and restart the add-on after changing a value. For cumulative drift, tune
`gap_mm` first in steps of `0.1` mm. Use `image_offset_dots` only when every
label has the same fixed displacement.

The preview endpoint accepts the same JSON:

```bash
curl -X POST http://HOME_ASSISTANT_IP:8099/preview \
  -H 'Content-Type: application/json' \
  -d '{"text":"ID:ASD-1294","qr":"ASD-1294"}' \
  --output preview.png
```

Print a free-form text label:

```yaml
action: rest_command.xprinter_text
data:
  text: "Door opened"
  profile: "small_30x20"
  copies: 1
  font_size: 22
  align: "center"
```

`/print-text` supports Cyrillic and English text because the label is rendered
as an image before printing. Maximum text length is 300 characters.

Print text on the 60x100 mm label:

```yaml
action: rest_command.xprinter_text
data:
  text: "Service report\nApartment 24\nCompleted"
  profile: "large_60x100"
  copies: 1
  font_size: 42
  align: "left"
```

Print a built-in 60x100 mm BMS label:

```yaml
action: rest_command.xprinter_template
data:
  template: "sensor_panel"
  copies: 1
```

Built-in templates:

- `sensor_panel`: Питание сенсорной панели
- `curtain`: Питание электрокарниза
- `speaker`: Колонка
- `thermostat`: Питание терморегулятора
- `yandex_station`: Питание Яндекс Станции
- `amplifier`: Усилитель
- `motion_sensor`: Питание датчика движения/присутствия

Preview a built-in label:

```bash
curl -X POST http://HOME_ASSISTANT_IP:8099/preview-template \
  -H 'Content-Type: application/json' \
  -d '{"template":"sensor_panel"}' \
  --output sensor-panel-preview.png
```

Preview and print uploaded files:

```bash
curl -X POST http://HOME_ASSISTANT_IP:8099/preview-file \
  -F profile=large_60x100 \
  -F fit=contain \
  -F file=@document.pdf \
  --output preview.png

curl -X POST http://HOME_ASSISTANT_IP:8099/print-file \
  -F profile=large_60x100 \
  -F fit=contain \
  -F copies=1 \
  -F file=@document.pdf
```

Supported upload formats: PDF first page, PNG, JPEG, WebP, and other formats
that Pillow can read. The 30x20 QR label keeps its legacy color behavior; the
60x100 profile previews and prints with normal black-on-white polarity.
