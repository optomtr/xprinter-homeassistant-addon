# Xprinter XP-365B for Home Assistant Green

Local Home Assistant add-on for printing 30x20 mm labels through USB.

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
```

Restart Home Assistant after changing `configuration.yaml`.

Example action:

```yaml
action: rest_command.xprinter_label
data:
  text: "ID:ASD-1294"
  qr: "ASD-1294"
  copies: 1
```

The preview endpoint accepts the same JSON:

```bash
curl -X POST http://HOME_ASSISTANT_IP:8099/preview \
  -H 'Content-Type: application/json' \
  -d '{"text":"ID:ASD-1294","qr":"ASD-1294"}' \
  --output preview.png
```
