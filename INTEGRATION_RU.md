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

Этот endpoint всегда печатает старый QR-макет 30x20 мм. Для новой бумаги
60x100 мм используйте `/print-text` или `/print-file` с
`profile: "large_60x100"`.

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

## Печать произвольного текста

Этот режим печатает обычную текстовую этикетку без QR-кода и без логотипа.
Поддерживается английский и русский текст, потому что текст рендерится как
изображение.

Доступные профили бумаги:

| profile | Размер | Зазор | Поведение цвета |
| --- | --- | --- | --- |
| `small_30x20` | 30x20 мм | из настроек add-on | старое поведение сохранено |
| `large_60x100` | 60x100 мм | 4 мм по умолчанию | нормальный чёрный на белом |

### Запрос

```http
POST /print-text
Content-Type: application/json
```

Тело запроса:

```json
{
  "text": "Door opened",
  "profile": "large_60x100",
  "copies": 1,
  "font_size": 22,
  "align": "center"
}
```

Поля:

| Поле | Тип | Обязательно | Ограничения |
| --- | --- | --- | --- |
| `text` | string | да | До 300 символов для `small_30x20`, до 2000 для `large_60x100` |
| `profile` | string | нет | `small_30x20` или `large_60x100` |
| `copies` | integer | нет | От 1 до 20, по умолчанию 1 |
| `font_size` | integer | нет | От 10 до 96, по умолчанию 22 |
| `align` | string | нет | `left`, `center` или `right` |

Текст автоматически переносится по строкам. Если текст не помещается, размер
шрифта уменьшается автоматически, но не ниже 10. Для `large_60x100`
допустимо до 2000 символов, для `small_30x20` до 300 символов.

Пример:

```bash
curl -X POST http://homeassistant.local:8012/print-text \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "Открыта входная дверь",
    "profile": "large_60x100",
    "copies": 1,
    "font_size": 42,
    "align": "left"
  }'
```

Предпросмотр текстовой этикетки:

```bash
curl -X POST http://homeassistant.local:8012/preview-text \
  -H 'Content-Type: application/json' \
  -d '{"text":"Открыта входная дверь","profile":"large_60x100","font_size":42,"align":"left"}' \
  --output text-preview.png
```

## Печать загруженного файла

Endpoint `/print-file` принимает файл и печатает его как изображение.
Endpoint `/preview-file` принимает те же параметры, но возвращает PNG-превью
без печати.

Поддерживаемые форматы:

- PDF, печатается первая страница;
- PNG;
- JPEG;
- WebP;
- другие изображения, которые распознаёт Pillow.

### Multipart-запрос

```bash
curl -X POST http://homeassistant.local:8012/preview-file \
  -F profile=large_60x100 \
  -F fit=contain \
  -F file=@document.pdf \
  --output preview.png
```

```bash
curl -X POST http://homeassistant.local:8012/print-file \
  -F profile=large_60x100 \
  -F fit=contain \
  -F copies=1 \
  -F file=@document.pdf
```

Поля:

| Поле | Тип | Обязательно | Ограничения |
| --- | --- | --- | --- |
| `file` | file | да, если нет `file_base64` | До 8 MB |
| `file_base64` | string | да, если нет `file` | Base64 файла |
| `filename` | string | нет | Нужно для определения `.pdf` |
| `content_type` | string | нет | Например `application/pdf` |
| `profile` | string | нет | Обычно `large_60x100` |
| `copies` | integer | нет | От 1 до 20 |
| `fit` | string | нет | `contain`, `cover` или `stretch` |
| `invert` | boolean | нет | Инвертирует само изображение перед печатью |
| `full_bleed` | boolean | нет | Убирает внутренний отступ и печатает на всю область |
| `threshold` | integer | нет | Порог чёрно-белой конвертации, от 1 до 254, по умолчанию 180 |

Рекомендуемый режим для документов: `fit=contain`. Он сохраняет пропорции и
оставляет поля. На большой бумаге применяется отступ `large_margin_mm`, по
умолчанию 4 мм.

Для готовых JPG-макетов BMS используйте режим во весь лист:

```bash
curl -X POST http://homeassistant.local:8012/preview-file \
  -F profile=large_60x100 \
  -F fit=stretch \
  -F full_bleed=true \
  -F threshold=180 \
  -F file=@label.jpg \
  --output preview.png
```

`threshold` убирает грязный dithering и делает чёрные области плотными. Если
тонкие элементы пропадают, уменьшите значение, например до `150`. Если
появляется лишний серый шум, увеличьте до `200`.

## Печать встроенных BMS-этикеток

Эти шаблоны уже лежат внутри add-on и печатаются на бумаге `large_60x100`.
Загружать файл при каждом вызове не нужно.

Список шаблонов:

| template | Название |
| --- | --- |
| `sensor_panel` | Питание сенсорной панели |
| `curtain` | Питание электрокарниза |
| `speaker` | Колонка |
| `thermostat` | Питание терморегулятора |
| `yandex_station` | Питание Яндекс Станции |
| `amplifier` | Усилитель |
| `motion_sensor` | Питание датчика движения/присутствия |

Получить список через API:

```bash
curl http://homeassistant.local:8012/templates
```

Предпросмотр:

```bash
curl -X POST http://homeassistant.local:8012/preview-template \
  -H 'Content-Type: application/json' \
  -d '{"template":"sensor_panel"}' \
  --output sensor-panel-preview.png
```

Печать:

```bash
curl -X POST http://homeassistant.local:8012/print-template \
  -H 'Content-Type: application/json' \
  -d '{"template":"sensor_panel","copies":1}'
```

Ответ:

```json
{
  "ok": true,
  "profile": "large_60x100",
  "template": "sensor_panel",
  "title": "Питание сенсорной панели",
  "copies": 1
}
```

## Конструктор этикеток для реле коллектора

Конструктор печатает документацию подключения в коробе коллектора на бумаге
`large_60x100`. Он автоматически выбирает один из трёх макетов:

- 1 реле — крупная таблица выходов;
- 2 реле — две карточки;
- 3 реле — три компактные карточки.

### Лимиты

| Количество реле | Максимум выходов на реле | Максимум выходов суммарно |
| --- | --- | --- |
| 1 | 4 | 4 |
| 2 | 4 | 8 |
| 3 | 4 | 9 |

Комбинация `3 реле x 4 выхода = 12` отклоняется ошибкой HTTP `400`,
потому что на этикетке 60x100 мм она становится нечитаемой. Допустимые
варианты для трёх реле: например `3+3+3`, `4+3+2`, `4+4+1`.

Получить лимиты через API:

```bash
curl http://homeassistant.local:8012/relay-limits
```

Ответ также содержит список иконок для выходов:

| icon | Значение |
| --- | --- |
| `none` | Без иконки |
| `radiator` | Радиатор |
| `floor` | Тёплый пол |
| `convector` | Конвектор |

### Предпросмотр

```http
POST /preview-relay
Content-Type: application/json
```

Пример для одного реле:

```bash
curl -X POST http://homeassistant.local:8012/preview-relay \
  -H 'Content-Type: application/json' \
  -d '{
    "relays": [
      {
        "title": "Реле 1",
        "outputs": [
          "Узел коллектора",
          "Спальня",
          "Холл",
          "Мастер-санузел"
        ]
      }
    ]
  }' \
  --output relay-preview.png
```

Ответом будет PNG `480x800 px`, соответствующий печати на бумаге 60x100 мм.

### Печать

```http
POST /print-relay
Content-Type: application/json
```

Пример для двух реле:

```bash
curl -X POST http://homeassistant.local:8012/print-relay \
  -H 'Content-Type: application/json' \
  -d '{
    "copies": 1,
    "relays": [
      {
        "title": "Реле 1",
        "outputs": ["Гостиная", "Кухня", "Холл"]
      },
      {
        "title": "Реле 2",
        "outputs": ["Спальня", "Санузел", "Гардероб", "Коридор"]
      }
    ]
  }'
```

Пример для трёх реле:

```bash
curl -X POST http://homeassistant.local:8012/preview-relay \
  -H 'Content-Type: application/json' \
  -d '{
    "relays": [
      {
        "title": "Реле 1",
        "outputs": ["Узел", "Спальня", "Холл"]
      },
      {
        "title": "Реле 2",
        "outputs": ["Кухня", "Детская", "Коридор"]
      },
      {
        "title": "Реле 3",
        "outputs": ["С/У мастер", "Гардероб", "Резерв"]
      }
    ]
  }' \
  --output relay-3-preview.png
```

### Формат данных

Основной формат:

```json
{
  "copies": 1,
  "relays": [
    {
      "title": "Реле 1",
      "outputs": [
        {
          "line": "L1",
          "name": "Узел коллектора",
          "icon": "floor"
        },
        {
          "line": "L2",
          "name": "Спальня",
          "icon": "radiator"
        }
      ]
    }
  ]
}
```

Сокращённый формат:

```json
{
  "relays": [
    {
      "title": "Реле 1",
      "outputs": ["Узел коллектора", "Спальня", "Холл"]
    }
  ]
}
```

В сокращённом формате линии назначаются автоматически: `L1`, `L2`, `L3`,
`L4`.

Поля:

| Поле | Тип | Обязательно | Ограничения |
| --- | --- | --- | --- |
| `copies` | integer | нет | От 1 до 20 |
| `relays` | array | да | От 1 до 3 реле |
| `relays[].title` | string | нет | До 24 символов |
| `relays[].outputs` | array/object | да | От 1 до 4 выходов на реле |
| `line` | string | нет | До 4 символов, например `L1` |
| `name` | string | да | До 40 символов |
| `icon` | string | нет | `none`, `radiator`, `floor`, `convector` |

Если `icon` не передан, используется `none`, то есть выход рисуется без
иконки. В сокращённом формате строк иконки не используются.

### Ошибка превышения лимита

Запрос:

```json
{
  "relays": [
    {"title": "Реле 1", "outputs": ["A", "B", "C", "D"]},
    {"title": "Реле 2", "outputs": ["A", "B", "C", "D"]},
    {"title": "Реле 3", "outputs": ["A", "B", "C", "D"]}
  ]
}
```

Ответ:

```json
{
  "error": "too many outputs for 3 relays: max 9 outputs total"
}
```

## Авторизация

В настройках add-on можно задать `api_key`. Если ключ задан, все POST-запросы
печати, предпросмотра и калибровки должны содержать:

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
  xprinter_text:
    url: "http://homeassistant.local:8012/print-text"
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
    url: "http://homeassistant.local:8012/print-template"
    method: POST
    content_type: "application/json"
    payload: >-
      {
        "template": {{ template | tojson }},
        "copies": {{ copies | default(1) | int }}
      }
  xprinter_relay:
    url: "http://homeassistant.local:8012/print-relay"
    method: POST
    content_type: "application/json"
    payload: >-
      {
        "relays": {{ relays | tojson }},
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

Пример печати произвольного текста из Home Assistant:

```yaml
action: rest_command.xprinter_text
data:
  text: "Открыта входная дверь"
  profile: "large_60x100"
  copies: 1
  font_size: 42
  align: "left"
```

Пример печати встроенной BMS-этикетки:

```yaml
action: rest_command.xprinter_template
data:
  template: "sensor_panel"
  copies: 1
```

Пример печати документации реле:

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

Пример с иконками выходов:

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
large_label_height_mm: 100.0
large_gap_mm: 4.0
large_margin_mm: 4.0
large_image_offset_dots: 0
large_density: 15
large_speed: 2.0
```

- `label_height_mm` — высота этикетки по направлению подачи.
- `gap_mm` — фактический зазор между этикетками.
- `image_offset_dots` — постоянный сдвиг макета; плюс вниз, минус вверх.
- `large_label_height_mm` — высота большой этикетки по направлению подачи.
- `large_gap_mm` — зазор между большими этикетками.
- `large_margin_mm` — отступ от края большой этикетки.
- `large_image_offset_dots` — постоянный сдвиг большого макета.
- `large_density` — нагрев большой печати, от 0 до 15.
- `large_speed` — скорость большой печати. Чем меньше, тем лучше сплошной чёрный.
- При 203 DPI примерно 8 точек соответствуют 1 мм.

Если чёрная шапка печатается точками или с белыми пробелами, это физическая
проблема термопечати: принтер не успевает прогреть большую чёрную область.
Рекомендуемые значения:

```yaml
large_density: 15
large_speed: 2.0
```

Если всё ещё есть пробелы, попробуйте:

```yaml
large_density: 15
large_speed: 1.5
```

или:

```yaml
large_density: 15
large_speed: 1.0
```

Эти значения обслуживает администратор принтера. Интегратор не должен
передавать их в запросе `/print`.

## Калибровка

Калибровка запускается только после замены типа рулона или потери положения:

```bash
curl -X POST http://homeassistant.local:8012/calibrate \
  -H 'Content-Type: application/json' \
  -d '{"profile":"large_60x100"}'
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
