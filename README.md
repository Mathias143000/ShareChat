# ShareChat

ShareChat — это легковесное приложение для обмена файлами и чата на базе Express и Socket.IO.

## Быстрый запуск

```bash
npm install
npm start
```

`npm start` перед запуском сервера компилирует TypeScript-клиент из `src/client/` в `public/app/`. Приложение стартует на `PORT` или `3000` по умолчанию.

## Переменные окружения

Скопируйте `.env.example` и переопределите только необходимые значения.

- `PUBLIC_ORIGIN` и `ALLOWED_ORIGINS`: контролируют, с каких браузерных origin разрешается обращаться к API и открывать Socket.IO-сессию.
- `UPLOADS_DIR` и `DATA_DIR`: позволяют задать пути хранения файлов и данных (удобно для тестов и изолированных окружений).
- `MAX_UPLOAD_MB`, `MAX_UPLOAD_FILES`, `MAX_TOTAL_UPLOADS_MB`, `UPLOAD_RATE_LIMIT`, `DELETE_RATE_LIMIT`: ограничения на загрузку, квоты и защиту удаления.
- `CHAT_MESSAGE_TTL_HOURS`, `CHAT_MESSAGE_LIMIT`, `MESSAGE_RATE_LIMIT`: удержание сообщений и антиспам-ограничения.
- `STALE_UPLOAD_TTL_HOURS` и `UPLOAD_CLEANUP_INTERVAL_MINUTES`: необязательная очистка старых неиспользуемых файлов и orphaned изображений чата.
- `BLOCKED_UPLOAD_EXTS` или `ALLOWED_UPLOAD_EXTS`: политика допустимых расширений для загрузки.
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

`install.sh` устанавливает приложение в `/opt/ShareChat`, выполняет `npm run build` и пишет env-файл в `/etc/default/sharechat`. После установки проверьте этот файл и задайте `PUBLIC_ORIGIN` или `ALLOWED_ORIGINS` под свой хост.
