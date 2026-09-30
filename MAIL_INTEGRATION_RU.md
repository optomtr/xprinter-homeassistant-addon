# Почта для кодов — Home Assistant и BMS ERP

**Короткая инструкция для установки и проверки:** [открыть PDF](output/pdf/Mail_Code_Inbox_guide_RU.pdf).

**Mail Code Inbox** — второе приложение в этом репозитории, рядом с Xprinter Label. Оно принимает письма на созданные адреса `*@mail.bmssmart.uz`, выделяет коды и хранит письма в SQLite. Проект BMS ERP не изменён; для подключения его бэкенда подготовлен HTTP API и [адаптер](integration/bms-erp-client.cjs).

## Установка и обновления

Репозиторий уже подключён для Xprinter Label. Откройте **Настройки → Приложения → Магазин приложений**, нажмите **Проверить обновления** и установите **Mail Code Inbox**. Если приложение не появилось, обновите страницу магазина. В настройках нового приложения задайте `admin_password` (от 12 символов) и отдельный `api_key` (от 24 символов, например результат `openssl rand -hex 32`).

Приложение запускается при старте Home Assistant. Чтобы новые версии устанавливались автоматически, включите **Автоматическое обновление** в карточке Mail Code Inbox. Новая версия определяется по полю `version` в `mail_code_inbox/config.yaml`; изменение кода без увеличения версии не считается обновлением. Home Assistant периодически проверяет репозитории на обновления. Обновления с изменениями, требующими ручного решения, могут не установиться автоматически.

Вкладка **Сеть**: `3000/tcp` → `3010` для веб-интерфейса и ERP API; `2525/tcp` → `25` для прямого SMTP. Веб-интерфейс открывается кнопкой приложения или по `http://homeassistant.local:3010`.

## Доставка без публичного IP и порта 25

Для обычных адресов вида `alice@mail.bmssmart.uz` можно использовать бесплатный catch-all [Forward Email](https://forwardemail.net/en/faq), HTTPS Worker и Cloudflare Tunnel. Письма хранятся в Home Assistant; внешний приёмник только передаёт их туда. Статичный или публичный IP у Home Assistant и проброс входящего порта 25 не нужны.

1. В опциях Mail Code Inbox укажите отдельный `relay_key` длиной не менее 32 символов. Сохраните тот же ключ как секрет `RELAY_KEY` Cloudflare Worker из [`mail_code_inbox/relay`](mail_code_inbox/relay). Не помещайте его в DNS или GitHub.
2. В Cloudflare Tunnel опубликуйте отдельный HTTPS hostname `inbox-hook.bmssmart.uz`. Направьте **только путь** `/api/inbound/forward-email` на `http://<IP-Home-Assistant>:3010`; для остальных путей установите ответ 404. Этот маршрут принимает запросы от Worker, а веб-интерфейс остаётся на локальном адресе.
3. В каталоге `mail_code_inbox/relay` разверните Worker: `npx wrangler secret put RELAY_KEY`, затем `npx wrangler deploy`. Перед развёртыванием при необходимости замените `INBOX_URL` в `wrangler.toml` на ваш HTTPS hostname туннеля. Worker проверяет IP отправителя по опубликованному списку серверов Forward Email и передаёт письмо в приложение с отдельным секретом.
4. В DNS Cloudflare для имени **`mail`** создайте два MX с приоритетом `0`: `mx1.forwardemail.net` и `mx2.forwardemail.net`. На том же имени добавьте TXT `forward-email=https://<адрес-вашего-Worker>.workers.dev/`. Это бесплатная catch-all пересылка на Worker; её URL виден в публичном DNS, но ключ `RELAY_KEY` там отсутствует. MX основного `bmssmart.uz` не меняйте.
5. Создайте адрес в Mail Code Inbox и отправьте на него пробное письмо. Приложение сохраняет только письма для созданных и включённых адресов. Письмо больше 5 МиБ приложение не принимает.

Если Home Assistant временно недоступен, Worker возвращает ошибку, а Forward Email повторяет доставку. Это не является гарантией доставки: проверьте первое письмо до использования адресов для важных аккаунтов.

## Альтернатива: прямой SMTP на Home Assistant

В DNS Cloudflare создайте DNS-only A-запись `mx.mail.bmssmart.uz` на публичный IPv4, а MX-запись для `mail.bmssmart.uz` с приоритетом 10 — на `mx.mail.bmssmart.uz`. На роутере пробросьте входящий TCP 25 на IP Home Assistant. Провайдер должен разрешать входящий порт 25 и выдавать публичный IP. MX основного `bmssmart.uz` менять не нужно.

Создайте адрес в веб-интерфейсе и отправьте на него тестовое письмо с внешнего сервиса. `alice+smartlab@mail.bmssmart.uz` доставляется в ящик `alice`.

## API для ERP

Бэкенд ERP обращается к `http://homeassistant.local:3010`, передавая `X-API-Key: <api_key>`. Ключ хранится только на сервере ERP, браузер обращается к ERP-бэкенду. По тому же принципу работает интеграция термопринтера.

| Действие | Метод и путь |
| --- | --- |
| Список адресов | `GET /api/erp/addresses` |
| Создать адрес | `POST /api/erp/addresses` с JSON `{"localPart":"alice","label":"Алиса"}` |
| Последний код | `GET /api/erp/codes/latest?address=alice%40mail.bmssmart.uz&since=TIMESTAMP_MS` |

`since` — Unix время в миллисекундах. Без него сервис ищет за последние 10 минут. Ответ содержит `message` с полем `code` или `message: null`. Повторное создание адреса возвращает существующий адрес (`created: false`). Ошибка ключа — HTTP 401.

Полная документация по настройкам приложения — в [DOCS.md](mail_code_inbox/DOCS.md). При установке по сети сертификат STARTTLS можно положить в `/ssl` и указать пути `smtp_tls_cert` и `smtp_tls_key`.
