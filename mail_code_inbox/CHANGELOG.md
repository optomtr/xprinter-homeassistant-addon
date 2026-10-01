# Changelog

## 0.5.1

- Исправлено извлечение кода Yandex ID из письма с переносами строк и CSS-цветом `#000000`.
- При обновлении пересчитывается ошибочный код `000000` в ранее полученных письмах.

## 0.5.0

- Основной домен адресов изменён на `bmssmart.uz`: новые письма приходят на адреса вида `test@bmssmart.uz`.
- Созданные ящики и ранее полученные письма остаются в базе при смене домена в настройках приложения.

## 0.4.0

- Интерфейс ящиков открывается внутри Home Assistant через Ingress, включая доступ с телефона через существующий адрес Home Assistant.
- Отдельный порт Ingress принимает запросы только от прокси Home Assistant; локальный порт и API ERP сохранены.

## 0.3.0

- Добавлен защищённый HTTPS-приём писем через Forward Email и Cloudflare Worker без публичного IP и входящего SMTP-порта.
- Прямой SMTP и существующий API ERP продолжают работать.

## 0.2.0

- First Home Assistant app release in the Xprinter app repository.
- Create addresses and receive verification codes over SMTP.
- Add the BMS ERP API protected by a separate API key.
