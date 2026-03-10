# ShareChat

ShareChat — это легковесное приложение для обмена файлами и чата на базе Express и Socket.IO.

## Быстрый запуск

```bash
npm install
npm run build
npm start
```

`npm run build` компилирует frontend и сервер (в `dist/index.js`), `npm start` запускает уже собранный сервер. Приложение стартует на `PORT` или `3000` по умолчанию.

## Переменные окружения

Скопируйте `.env.example` и переопределите только необходимые значения.

- `PUBLIC_ORIGIN` и `ALLOWED_ORIGINS`: контролируют, с каких браузерных origin разрешается обращаться к API и открывать Socket.IO-сессию.
- `UPLOADS_DIR` и `DATA_DIR`: позволяют задать пути хранения файлов и данных (удобно для тестов и изолированных окружений).
- `MAX_UPLOAD_MB`, `MAX_UPLOAD_FILES`, `MAX_TOTAL_UPLOADS_MB`, `UPLOAD_RATE_LIMIT`, `DELETE_RATE_LIMIT`: ограничения на загрузку, квоты и защиту удаления.
- `CHAT_MESSAGE_TTL_HOURS`, `CHAT_MESSAGE_LIMIT`, `MESSAGE_RATE_LIMIT`: удержание сообщений и антиспам-ограничения.
- `STALE_UPLOAD_TTL_HOURS` и `UPLOAD_CLEANUP_INTERVAL_MINUTES`: необязательная очистка старых неиспользуемых файлов и orphaned изображений чата.
- `BLOCKED_UPLOAD_EXTS` или `ALLOWED_UPLOAD_EXTS`: политика допустимых расширений для загрузки.
- `STORAGE_BACKEND`: включает адаптер для `uploads` (`disk`, `s3`, `minio`); `disk` — локальный диск, остальные используют S3/MinIO storage.
- `STORAGE_S3_BUCKET/REGION/PREFIX/ENDPOINT/ACCESS_KEY/SECRET_KEY/FORCE_PATH_STYLE`: параметры S3/MinIO, префикс автоматически нормализуется и синхронизируется с маршрутом `/uploads`.
- `REDIS_URL`: если задана, rate limit и история чатов хранятся и синхронизируются через Redis, что позволяет запускать несколько инстансов с общим состоянием.
- `HTTPS_KEY_FILE` и `HTTPS_CERT_FILE`: путь к файлам ключа и сертификата; при наличии обоих сервер автоматически запускается по HTTPS. Дополнительно можно указать `HTTPS_CA_FILE` (цепочка доверия) и `HTTPS_PASSPHRASE` (если ключ зашифрован).
- `SOCKET_TRANSPORTS`: список через запятую поддерживаемых транспортов Socket.IO. По умолчанию оставляем только `websocket`, чтобы исключить XHR polling и связанный `xhr poll error / timed out`, но можно вернуть `websocket,polling`, если перед прокси нужна поддержка long polling.
- `npm run build`: пересобирает браузерный bundle вручную при изменениях только во фронтенде.

## Проверка

```bash
npm test
```

Smoke-тест поднимает сервер на временном порте, использует изолированные папки uploads/data и проверяет:

- доступность health-эндпоинта
- блокировку origin
- подключение Socket.IO и доставку сообщений
- сохранение и очистку изображений чата
- загрузку файлов, preview, overwrite, delete
- сохранение созданных чатов после рестарта

## Примечание по деплою

`install.sh` устанавливает приложение в `/opt/ShareChat`, выполняет `npm run build`, генерирует TLS-сертификат в `certs/` (по умолчанию `/opt/ShareChat/certs/sharechat.key` и `…/sharechat.crt`) и пишет env-файл в `/etc/default/sharechat`. Сервис сразу стартует по HTTPS; при необходимости укажите реальный `PUBLIC_ORIGIN` и/или подставьте свои `HTTPS_KEY_FILE`/`HTTPS_CERT_FILE`/`HTTPS_PASSPHRASE` (или задайте `SHARECHAT_CERT_*` при установке).

## Доступ по invite-коду

Если задан `AUTH_INVITE_CODES` (список через запятую, без учета регистра), сервер требует invite-код для UI, REST API, загрузок, скачивания файлов и Socket.IO.

Передать код можно тремя способами:

- через query-параметр `?invite=CODE`,
- через заголовок `X-ShareChat-Invite`,
- через cookie `sharechat_invite`, которую сервер сам выставляет после успешной проверки.

После успешного входа сервер пишет `HttpOnly` cookie `sharechat_invite`, поэтому повторно передавать query-параметр или заголовок не нужно. При неверном коде запросы получают `401` или `403`.
