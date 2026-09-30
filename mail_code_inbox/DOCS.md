# Mail Code Inbox

Это приложение принимает письма на адреса `*@mail.bmssmart.uz` и показывает коды в веб-интерфейсе. База SQLite хранится в `/data/inbox.sqlite` и сохраняется при обновлениях Home Assistant.

## Настройка

- `mail_domain`: домен адресов, по умолчанию `mail.bmssmart.uz`.
- `admin_password`: пароль входа в веб-интерфейс, минимум 12 символов.
- `api_key`: отдельный ключ ERP API, минимум 24 символа. Получите случайный ключ командой `openssl rand -hex 32`.
- `retention_days`: сколько дней хранить письма, 0 отключает автоочистку.
- `smtp_tls_cert` и `smtp_tls_key`: необязательные пути в `/ssl` к сертификату и ключу для STARTTLS. Укажите оба параметра вместе.

Порт `3000/tcp` приложения опубликован на хосте как `3010` для веб-интерфейса и ERP API. Порт `2525/tcp` опубликован как `25` для входящей почты. Если 25 занят, найдите конфликтующий сервис. Снаружи SMTP должен быть доступен именно на TCP 25.

## DNS

Создайте DNS-only A-запись `mx.mail.bmssmart.uz` на публичный IPv4 Home Assistant, затем MX-запись для `mail.bmssmart.uz` с приоритетом 10 на `mx.mail.bmssmart.uz`. На роутере перенаправьте входящий TCP 25 на IP Home Assistant. MX основного домена `bmssmart.uz` менять не нужно.

## BMS ERP API

ERP-бэкенд обращается к `http://homeassistant.local:3010`, передавая заголовок `X-API-Key`. Не передавайте ключ в браузер. Доступны:

- `GET /api/erp/addresses` — список адресов.
- `POST /api/erp/addresses` с JSON `{"localPart":"alice","label":"Алиса"}` — создать адрес, повторный вызов идемпотентен.
- `GET /api/erp/codes/latest?address=alice%40mail.bmssmart.uz&since=TIMESTAMP_MS` — последний код после указанного времени, либо `message: null`. Без `since` ищет за 10 минут.

Веб-интерфейс открывается кнопкой в Home Assistant. Создайте первый адрес и отправьте на него письмо из внешнего почтового сервиса для проверки доставки.
