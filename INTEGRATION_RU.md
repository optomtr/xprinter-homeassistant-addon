# Интеграция печати этикеток BMS

Документ описывает передачу данных и печать этикеток 30x20 мм через
Home Assistant Green и USB-принтер Xprinter XP-365B.

## Подключение

Сервис печати работает внутри add-on `Xprinter Label`.

- Адрес Home Assistant: `http://homeassistant.local`
- Внешний порт в текущей установке: `8012`
- Базовый URL API: `http://homeassistant.local:8012`
- Формат запросов и ответов: JSON
- Кодировка: UTF-8

Если имя `homeassistant.local` недоступно из системы интегратора, следует
использовать постоянный IP-адрес Home Assistant, например:

```text
http://192.168.1.50:8012
```

## Проверка готовности

### Запрос

```http
GET /health
```

Пример:

```bash
curl http://homeassistant.local:8012/health
```

Успешный ответ:

```json
{
  "ok": true,
  "printer_connected": true,
  "label_height_mm": 20.0,
  "gap_mm": 2.0,
  "image_offset_dots": 0
}
```

Печать разрешается только при:

```json
"printer_connected": true
```

## Печать этикетки

### Запрос

```http
POST /print
Content-Type: application/json
```

Тело запроса:

```json
{
  "text": "ID:ASD-1294",
  "qr": "ASD-1294",
  "copies": 1
}
```

Поля:

| Поле | Тип | Обязательно | Ограничения |
| --- | --- | --- | --- |
| `text` | string | да | Английский текст, от 1 до 18 символов |
| `qr` | string | да | Непустое содержимое QR-кода |
| `copies` | integer | нет | От 1 до 20, по умолчанию 1 |

`text` печатается рядом с QR-кодом. В `qr` можно передавать идентификатор,
URL или другой текст. Для уверенного считывания на этикетке 30x20 мм
рекомендуется передавать короткое значение.

Успешный ответ, HTTP `200`:

```json
{
  "ok": true,
  "text": "ID:ASD-1294",
  "qr": "ASD-1294",
  "copies": 1
}
```

### cURL

```bash
curl -X POST http://homeassistant.local:8012/print \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "ID:ASD-1294",
    "qr": "ASD-1294",
    "copies": 1
  }'
```

### JavaScript

```javascript
const response = await fetch("http://homeassistant.local:8012/print", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    text: "ID:ASD-1294",
    qr: "ASD-1294",
    copies: 1,
  }),
});

const result = await response.json();

if (!response.ok) {
  throw new Error(result.error ?? `Print failed: HTTP ${response.status}`);
}
```

### Python

```python
import requests

response = requests.post(
    "http://homeassistant.local:8012/print",
    json={
        "text": "ID:ASD-1294",
        "qr": "ASD-1294",
        "copies": 1,
    },
    timeout=15,
)
response.raise_for_status()
print(response.json())
```

## Предварительный просмотр

Endpoint возвращает PNG размером 240x160 пикселей и не запускает печать.

```http
POST /preview
Content-Type: application/json
```

Пример:

```bash
curl -X POST http://homeassistant.local:8012/preview \
  -H 'Content-Type: application/json' \
  -d '{"text":"ID:ASD-1294","qr":"ASD-1294"}' \
  --output preview.png
```

## Авторизация

В настройках add-on можно задать `api_key`. Если ключ задан, запросы
`/print`, `/preview` и `/calibrate` должны содержать:

```http
X-API-Key: SECRET_KEY
```

Пример:

```bash
curl -X POST http://homeassistant.local:8012/print \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: SECRET_KEY' \
  -d '{"text":"ID:ASD-1294","qr":"ASD-1294","copies":1}'
```

API предназначен для использования внутри доверенной локальной сети. Не
следует публиковать порт `8012` напрямую в интернет.

## Вызов через Home Assistant

В `configuration.yaml`:

```yaml
rest_command:
  xprinter_label:
    url: "http://homeassistant.local:8012/print"
    method: POST
    content_type: "application/json"
    # Добавить следующую строку, если в add-on задан api_key:
    # headers:
    #   X-API-Key: "SECRET_KEY"
    payload: >-
      {
        "text": {{ text | tojson }},
        "qr": {{ qr | tojson }},
        "copies": {{ copies | default(1) | int }}
      }
```

После изменения конфигурации необходимо перезапустить Home Assistant.

Ручной тест выполняется в разделе
**Инструменты разработчика -> Действия -> YAML**:

```yaml
action: rest_command.xprinter_label
data:
  text: "ID:ASD-1294"
  qr: "ASD-1294"
  copies: 1
```

Тот же action можно использовать внутри любой автоматизации:

```yaml
actions:
  - action: rest_command.xprinter_label
    data:
      text: "ID:ASD-1294"
      qr: "ASD-1294"
      copies: 1
```

## Ошибки

| HTTP-код | Значение |
| --- | --- |
| `200` | Запрос выполнен |
| `400` | Ошибка входных данных |
| `401` | Отсутствует или неверен `X-API-Key` |
| `503` | Принтер отключен или произошла ошибка USB |

Примеры сообщений:

```json
{"error":"text and qr must not be empty"}
```

```json
{"error":"text must contain at most 18 characters"}
```

```json
{"error":"copies must be between 1 and 20"}
```

```json
{"error":"Xprinter 1fc9:2016 is not connected"}
```

При HTTP `503` интегратор должен считать задание не напечатанным. Допустим
повторный запрос после проверки `/health`. Автоматический повтор должен быть
ограничен, чтобы после восстановления соединения не получить дубли.

## Настройки бумаги

Настройки находятся во вкладке **Конфигурация** add-on:

```yaml
label_height_mm: 20.0
gap_mm: 2.0
image_offset_dots: 0
```

- `label_height_mm` — высота этикетки по направлению подачи.
- `gap_mm` — фактический зазор между этикетками.
- `image_offset_dots` — постоянный сдвиг макета; плюс вниз, минус вверх.
- При 203 DPI примерно 8 точек соответствуют 1 мм.

Эти значения обслуживает администратор принтера. Интегратор не должен
передавать их в запросе `/print`.

## Калибровка

Калибровка запускается только после замены типа рулона или потери положения:

```bash
curl -X POST http://homeassistant.local:8012/calibrate
```

Во время калибровки принтер может протянуть несколько этикеток. Не следует
вызывать `/calibrate` перед каждым заданием печати.

## Рекомендуемый алгоритм интеграции

1. Проверить `GET /health`.
2. Убедиться, что `printer_connected` равно `true`.
3. Сформировать уникальные `text` и `qr`.
4. Выполнить `POST /print`.
5. Считать задание принятым только после HTTP `200`.
6. Сохранить ответ и идентификатор задания в журнале интегратора.
