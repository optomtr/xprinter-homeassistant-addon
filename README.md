# BMS Home Assistant Apps

This repository contains three independent Home Assistant apps:

- **Xprinter Label** prints labels on the USB Xprinter XP-365B. See [printer integration](INTEGRATION_RU.md).
- **Mail Code Inbox** creates email addresses on `bmssmart.uz`, receives verification emails and exposes a server-side API for BMS ERP. The [Russian PDF guide](output/pdf/Mail_Code_Inbox_guide_RU.pdf) now covers delivery without a public IP; see also [mail integration details](MAIL_INTEGRATION_RU.md).
- **BMS Plan Editor** edits building plans, electrical installation points and coverage maps. Its application code remains in the separate private `optomtr/bms-planspec` repository. Configure a read-only GitHub token and the ERP signing secret in the app settings. Updates are fetched on restart; projects and bug reports remain in persistent storage. See setup below.

## Xprinter Label

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

4. Install **Xprinter Label**, **Mail Code Inbox** and/or **BMS Plan Editor** from the same repository. Existing installations can reload the app store to see the new editor.
5. For Mail Code Inbox, set its admin password and ERP API key in the app configuration, then enable automatic updates in its app details. To receive mail without a public IP, configure the optional relay key and follow the [mail setup](MAIL_INTEGRATION_RU.md).
6. For Xprinter Label, start the app and open `http://HOME_ASSISTANT_IP:8099/health` to verify `printer_connected` is `true`.
7. For BMS Plan Editor, configure `github_token` with read-only Contents access to `optomtr/bms-planspec` and a `plan_editor_secret` of at least 32 characters. Start it, then open `http://HOME_ASSISTANT_IP:4174/`. The first start downloads and builds the editor, so allow several minutes. Check `/api/health` after the build. For ERP-linked storage, open the editor through the ERP's signed launch link, not directly through Home Assistant.

This is a Home Assistant app/add-on repository, not a HACS integration.

## BMS Plan Editor setup

In GitHub, create a **fine-grained personal access token**, select only
`optomtr/bms-planspec`, and grant **Contents: Read-only**. Save it as
`github_token` in the Home Assistant app configuration. Do not paste it into
the repository URL, source code, ERP frontend or Cloudflare configuration.

Generate a separate random signing secret (for example, with
`openssl rand -hex 32`). Save it as `plan_editor_secret` in this app and as
the editor signing secret in ERP's server-side configuration. The keys must
match. This is not the printer or email API key.

The editor serves on port **4174** and has its own `/data` directory. Projects,
uploaded bug-report photos/videos and cached editor releases survive restarts
and app updates. Back up this app's data with Home Assistant; backups also
contain its configured secrets. Do not uninstall without a backup.

For remote access, point an existing Cloudflare Tunnel hostname, such as
`plans.bmssmart.uz`, to `http://HOME_ASSISTANT_IP:4174`, and set that HTTPS URL
in ERP's editor configuration. No public IP or router port forwarding is needed
when using the tunnel. Open a project's editor using **Редактор чертежей** in
ERP: the signed launch link supplies the project and access rights. Opening the
Home Assistant web UI directly uses standalone/local project mode instead.
Home Assistant ingress is intentionally not enabled; it is separate from ERP
authentication and the editor does not allow iframe embedding.

`source_branch: main` + `update_on_start: true` fetches changes from the editor
repository on **restart**, not while somebody is editing. Set `update_on_start`
to `false` to keep the cached version, or choose a tag to pin a version. A first
installation still needs GitHub access. A failed download, test or build leaves
the previous working release active. Check the app log for the installed commit
and `http://HOME_ASSISTANT_IP:4174/api/health` for readiness. The first build
needs Internet access and sufficient memory (allow approximately 2 GB free).

Bug reports opened through ERP are stored privately on the editor server;
they are not automatically sent to a Codex chat. The server's report API
requires an ERP-signed administrator ticket. Standalone reports download as
a ZIP that can be attached to the support conversation.

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
        "copies": {{ copies | default(1) | int }}{% if speed is defined %},
        "speed": {{ speed | float }}{% endif %}{% if pause_every is defined %},
        "pause_every": {{ pause_every | int }}{% endif %}{% if pause_seconds is defined %},
        "pause_seconds": {{ pause_seconds | float }}{% endif %}
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
        "align": {{ align | default("center") | tojson }}{% if speed is defined %},
        "speed": {{ speed | float }}{% endif %}{% if pause_every is defined %},
        "pause_every": {{ pause_every | int }}{% endif %}{% if pause_seconds is defined %},
        "pause_seconds": {{ pause_seconds | float }}{% endif %}
      }
  xprinter_template:
    url: "http://HOME_ASSISTANT_IP:8099/print-template"
    method: POST
    content_type: "application/json"
    payload: >-
      {
        "template": {{ template | tojson }},
        "copies": {{ copies | default(1) | int }}{% if speed is defined %},
        "speed": {{ speed | float }}{% endif %}{% if pause_every is defined %},
        "pause_every": {{ pause_every | int }}{% endif %}{% if pause_seconds is defined %},
        "pause_seconds": {{ pause_seconds | float }}{% endif %}
      }
  xprinter_relay:
    url: "http://HOME_ASSISTANT_IP:8099/print-relay"
    method: POST
    content_type: "application/json"
    payload: >-
      {
        "relays": {{ relays | tojson }},
        "copies": {{ copies | default(1) | int }}{% if speed is defined %},
        "speed": {{ speed | float }}{% endif %}{% if pause_every is defined %},
        "pause_every": {{ pause_every | int }}{% endif %}{% if pause_seconds is defined %},
        "pause_seconds": {{ pause_seconds | float }}{% endif %}
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
- `large_density`: heat density for large labels. Default `15`.
- `large_speed`: print speed for large labels. Default `2.0`.
- `pause_every`: insert a cooling pause after this many labels in one job.
  Default `10`; set to `0` to disable.
- `pause_seconds`: cooling pause duration. Default `20` seconds.

If large black areas look speckled on paper, keep `large_density` at `15` and
try lowering `large_speed` to `1.5` or `1.0`. This is a physical thermal-print
issue, not a preview issue.

Every print endpoint also accepts optional per-job overrides:

```json
{
  "copies": 20,
  "speed": 2.0,
  "pause_every": 10,
  "pause_seconds": 20
}
```

The printer inserts a 20-second wait after every tenth label, including when
the labels arrive as separate API requests. Lower `speed` values reduce
throughput and usually make the print darker; the cooling pause is the primary
overheat protection. These fields do not affect preview endpoints.

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

Build and print a relay wiring label:

```yaml
action: rest_command.xprinter_relay
data:
  copies: 1
  relays:
    - title: "Реле 1"
      outputs:
        - "Узел коллектора"
        - "Спальня"
        - "Холл"
        - "Мастер-санузел"
```

Use output icons with object syntax:

```yaml
action: rest_command.xprinter_relay
data:
  copies: 1
  relays:
    - title: "Реле 1"
      outputs:
        - line: "L1"
          name: "Спальня"
          icon: "floor"
        - line: "L2"
          name: "Холл"
          icon: "radiator"
        - line: "L3"
          name: "Кухня"
          icon: "convector"
```

Supported relay output icons: `none`, `radiator`, `floor`, `convector`.

Relay constructor limits:

- 1 relay: max 4 outputs
- 2 relays: max 8 outputs total
- 3 relays: max 9 outputs total

Preview endpoint:

```bash
curl -X POST http://HOME_ASSISTANT_IP:8099/preview-relay \
  -H 'Content-Type: application/json' \
  -d '{"relays":[{"title":"Реле 1","outputs":["Узел","Спальня","Холл","Санузел"]}]}' \
  --output relay-preview.png
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

For ready-made BMS label JPG files that must fill the whole 60x100 label,
use full-bleed stretch mode:

```bash
curl -X POST http://HOME_ASSISTANT_IP:8099/preview-file \
  -F profile=large_60x100 \
  -F fit=stretch \
  -F full_bleed=true \
  -F threshold=180 \
  -F file=@label.jpg \
  --output preview.png
```

Supported upload formats: PDF first page, PNG, JPEG, WebP, and other formats
that Pillow can read. The 30x20 QR label keeps its legacy color behavior; the
60x100 profile previews and prints with normal black-on-white polarity.
