# Mafia Slack Bot

Полноценный мафия-бот для Slack (Socket Mode) с анонимными голосованиями, таймерами и сохранением состояния в Postgres (Render) или SQLite (локально).

## Быстрый старт

1. Создайте Slack App из `manifest.json`.
2. Включите Socket Mode и создайте app-level token с правом `connections:write`.
3. Установите приложение в workspace и возьмите:
   - Bot Token (`xoxb-...`)
   - Signing Secret
   - App Token (`xapp-...`)
4. Создайте `.env` на основе `.env.example`.
5. Для Render подключите Postgres и укажите `DATABASE_URL` (и `PGSSL=1`).
6. Для Telegram создайте бота через @BotFather и получите токен.
7. Укажите `TELEGRAM_BOT_TOKEN` и, если нужен webhook, `TELEGRAM_WEBHOOK_DOMAIN`, `TELEGRAM_WEBHOOK_PATH`, `PORT`.
8. Если Telegram работает через webhook, задайте `SLACK_PORT=0` или другой порт, чтобы `PORT` был свободен для Telegram.
9. Если `TELEGRAM_WEBHOOK_DOMAIN` не задан, Telegram будет работать через polling (удобно локально).
10. Установите зависимости и запустите:

```bash
cd /d E:\my_projects\Mafia Slack Bot
npm.cmd start

```

```bash
npm install
npm start
npm.cmd start
```

Примечание: в режиме polling бот поднимает health‑server на `PORT`, чтобы Render видел открытый порт.

## Медиа day/night и Home‑иконка

- Для видео day/night в канале нужен scope `files:write` и переустановка приложения.
- Для иконок в Home нужен публичный доступ к ассетам:
  - Укажите `ASSET_BASE_URL=https://<ваш-домен>` (например домен Render).
  - Бот раздаёт `/assets/*` через health‑server (PORT).
- Если `ASSET_BASE_URL` не указан — иконки в Home будут скрыты (только текст).

## Гайд для новичков (шаг за шагом)

### 1) Установите всё необходимое
- Установите Node.js (LTS).
- Откройте терминал в папке проекта.

### 2) Установите зависимости
```bash
npm install
```

### 3) Создайте Slack App (из manifest)
1. В Slack API → **Create App** → **From an app manifest**.
2. Вставьте содержимое `manifest.json`.
3. Установите приложение в workspace.

### 4) Получите токены Slack
В настройках приложения:
- **Bot Token** (`xoxb-...`)
- **App Token** (`xapp-...`) с правом `connections:write`
- **Signing Secret**

Укажите их в `.env`.

Где найти эти значения в Slack:
- **Bot Token**: App → **OAuth & Permissions** → “Bot User OAuth Token”.
- **Signing Secret**: App → **Basic Information** → “App Credentials”.
- **App Token**: App → **Socket Mode** → “Generate an app-level token” (scope `connections:write`).

### 5) Запуск локально
```bash
npm start
```
В логах должно быть подключение Socket Mode.

### 6) Добавьте бота в канал
В Slack‑канале:
```
/invite @MafiaBot
```

### 7) Создайте лобби
В канале:
```
@MafiaBot create
```
Игроки заходят `Join`, хост запускает `Start`.

### 8) Обновили scopes — переустановите
Если меняли `manifest.json`, **переустановите** приложение.

### 9) Render (прод)
1. Создайте Render Web Service.
2. Добавьте переменные окружения из `.env`.
3. Подключите Postgres и укажите:
   - `DATABASE_URL`
   - `PGSSL=1`
4. Задеплойте сервис.

Где взять `DATABASE_URL` в Render:
- Render → **PostgreSQL** → ваша БД → **Info** → “Internal Database URL”.
- Используйте **Internal Database URL** для сервисов Render (стабильнее и без проблем с доступом).

### 9.1) Как не уходить в sleep (опционально)
На бесплатном плане Render может «усыплять» сервис без трафика.
Включите keep‑alive ping:
- Укажите `KEEP_ALIVE_URL` = Service URL.
- Опционально: `KEEP_ALIVE_INTERVAL_MINUTES` (по умолчанию 10).

Примечание: keep‑alive помогает, но стопроцентная гарантия — только платный план.

### 10) Assets (иконки + day/night медиа)
- Укажите `ASSET_BASE_URL=https://<ваш-домен>`, чтобы Slack грузил картинки.
- Для day/night MP4 нужен `files:write`.

Где взять `ASSET_BASE_URL`:
- Render → ваш Web Service → **Settings** → “Service URL”  
  Пример: `https://your-service.onrender.com`

### 11) Telegram webhook (опционально)
Если используете Telegram webhook:
- `TELEGRAM_WEBHOOK_DOMAIN` = Service URL Render
- `TELEGRAM_WEBHOOK_PATH` = `/telegram` (по умолчанию)
- `PORT` должен быть открыт под webhook

Если оставить `TELEGRAM_WEBHOOK_DOMAIN` пустым, Telegram будет работать через polling (удобно локально).

## Управление проектом (для чайников)

### Как запускать/останавливать
- Запуск: `npm start`
- Остановка: `Ctrl + C`

### Где хранится память
- **Локально**: `data/mafia.db` (SQLite)
- **Render**: Postgres через `DATABASE_URL`

### Как сбросить базу (локально)
Остановите бота и удалите:
```
data/mafia.db
```

### Как обновлять зависимости
```
npm install
```

### Обычный цикл работы
1. Меняем код.
2. Перезапускаем `npm start`.
3. Если меняли scopes — переустановка Slack App.

### Полезные логи
Если что‑то не работает, смотрите терминал:
- статус подключения Slack
- статус Telegram webhook/polling
- ошибки базы

### Частые проблемы
- **Бот не пишет в личку**: Slack может блокировать сообщения от приложений.
- **Кнопки не работают**: включите Interactivity в Slack App.
- **Home пустой**: откройте Home заново или смотрите логи.
- **Видео не публикуется**: нужен `files:write` + переустановка.

## Команды

Slack в канале (через упоминание бота):
- `@MafiaBot create` — создать лобби
- `@MafiaBot join` — войти
- `@MafiaBot leave` — выйти
- `@MafiaBot start` — начать игру (только хост)
- `@MafiaBot extend 2` — продлить лобби на 2 минуты
- `@MafiaBot status` — статус
- `@MafiaBot config` — настройки (day/night/lobby/min/extend)
- `@MafiaBot end` — завершить игру (только хост)

Slack в личке (fallback):
- `vote @user` — дневное голосование
- `kill @user` — мафия
- `save @user` — доктор
- `check @user` — детектив
- `protect @user` — телохранитель
- `whisper <text>` — анонимный шёпот (1 раз за день)
- `lang en` / `lang ru` — язык сообщений
- `mychannels` — список ваших каналов и настройки
- `faq` / `faq <id>` — открыть FAQ (список или конкретный вопрос)
- `dev <code>` — открыть Dev‑панель (только для DEV_USER_ID)
- Любое сообщение в личке — инструкция по добавлению и запуску
- Кнопка `Найти игры` в личке — список публичных каналов с играми
- Кнопка `Мои каналы` в личке — редактирование приватности и настроек по умолчанию
По умолчанию язык сообщений — English.

Telegram в группах:
- `/create` — создать лобби
- `/join` — войти
- `/leave` — выйти
- `/start` — начать игру (только хост)
- `/extend 2` — продлить лобби на 2 минуты
- `/status` — статус
- `/config` — настройки (day/night/lobby/min/extend/lang)
- `/end` — завершить игру (только хост)

Telegram в личке:
- `/home` — статистика и текущая игра
- `/faq` — FAQ
- `/find` — найти игры
- `/mychannels` — ваши каналы
- `/lang en|ru` — язык сообщений
- `/whisper <text>` — анонимный шёпот (1 раз за день)

## Механика

- Минимум 4 игрока: мафия, доктор, детектив, мирный.
- Доп. роли:
  - `>=7` игроков — мэр (двойной голос).
  - `>=8` игроков — телохранитель (перехватывает удар).
- Дневные и ночные действия приходят в личку как интерактивные сообщения.
- В лобби есть панель с кнопками `Join`, `Leave`, `Start`, `Ready`, `Extend`, `End`.
- Таймеры: по умолчанию лобби 5 мин, день 5 мин, ночь 2 мин; есть предупреждения и автодействия.
- Выбывшие игроки не могут писать в канал игры (сообщения удаляются).
- Последние слова: после смерти бот просит DM, сообщение публикуется в канал.
- Есть пин‑сообщение Game Dashboard (фаза/таймер/живые).
- Состояние хранится в Postgres (Render) или SQLite (`data/mafia.db`) при локальном запуске без `DATABASE_URL`.

## Render + Postgres

1. В Render создайте Postgres (Managed DB).
2. В настройках сервиса добавьте:
   - `DATABASE_URL` (строка подключения из Render)
   - `PGSSL=1`
3. Перезапустите сервис.  
   Бот автоматически перейдёт на Postgres и будет сохранять данные между деплоями.

## Публичные каналы и «Найти игры»

- При добавлении бота в канал он спросит в личке, делать ли канал публичным в каталоге игр.
- Если личка недоступна, бот спросит в самом канале.
- Если ничего не пришло, упомяните бота в канале (например `@MafiaBot help`) — он повторит вопрос.
- В личке нажмите кнопку `Найти игры`, чтобы открыть список:
  - Фильтры: «Активные», «В наборе», «Не активные»
  - Пагинация: кнопки `Prev` / `Next`
- Приватные каналы не попадают в список.

## Мои каналы

- В личке нажмите кнопку `Мои каналы`.
- Появится список каналов, где вы последний меняли приватность.
- Нажмите на канал, чтобы отредактировать приватность и дефолтные параметры игры.
- Рядом с настройками есть кнопки `?`, которые открывают связанный FAQ‑ответ.

## FAQ

- В личке есть кнопка `FAQ` — откроется модалка со списком вопросов.
- В ответах показывается ID: `faq <id>` — можно открыть конкретный вопрос через команду.

## Dev‑режим и обновление

- В `.env` можно указать `DEV_USER_ID` и `DEV_CODE`.
- В личке напишите `dev <code>` — откроется Dev‑панель.
- Кнопка `Enable maintenance` включает режим обновления:
  - Новые лобби и игры блокируются.
  - Все лобби автоматически закрываются.
  - Активные игры доигрываются.
  - Когда последняя игра завершится — бот напишет девелоперу в личку.
- Кнопка `Disable maintenance` отключает режим обновления.

## Тест‑режим (один аккаунт)

Только для `DEV_USER_ID`. Позволяет создать виртуальных игроков и управлять ими через DM.

- Создать тест‑лобби:  
  `test setup #channel Alice,Bob,Charlie`
- Управление действиями:  
  `as Alice vote Bob`  
  `as Alice kill Bob`  
  `as Alice save Bob`  
  `as Alice check Bob`  
  `as Alice protect Bob`  
  `as Alice whisper <text>`  
  `as Alice abstain`
- Список тест‑игроков:  
  `test list #channel`

Примечания:
- Тест‑игроки не получают DM‑сообщения и не учитываются в статистике.
- Имена должны быть одним словом (без пробелов).

## Важно про scopes

Если вы обновили `manifest.json`, переустановите приложение, чтобы обновить выданные права.
Для новых функций нужны дополнительные права (`pins:write`, `groups:write`, `mpim:write`, `channels:read`, `groups:read`, `files:write`).
