# Что ввести заново после восстановления

Ключи и логины бэкап не хранит и хранить не будет: приватный репозиторий —
это всё равно чужой сервер, а профили Chrome в `auth/` это живые сессии.
Ниже — что понадобится и где это взять.

| Файл | Что внутри | Где взять |
|---|---|---|
| `scripts/.telegram-config.json` | токен бота и chat_id | @BotFather в телеграме |
| `scripts/.hiker-config.json` | ключ Hiker API (поиск и скачивание Instagram) | hikerapi.com, личный кабинет |
| `scripts/.rapidapi-config.json` | ключ RapidAPI (Twitter/X и TikTok) | rapidapi.com → Social Download All In One |
| `auth/fish.key` | ключ Fish Audio (клон голоса) | fish.audio → API keys |
| `scripts/.fish-config.json` | id вашего клонированного голоса | создастся сам при повторном клонировании |
| `.mcp.json` | ChatPlace, 21st.dev, Gemini — если пользуетесь | личные кабинеты сервисов |
| `auth/chrome-auto-profile` | логин ChatGPT | войти руками, профили не переносятся |
| `auth/chrome-flow-profile` | логин Google Flow | войти руками; аккаунт заводить на этой машине |

Список общий для всех сборок — строки про то, чем вы не пользуетесь, пропустите.
Всё это создаёт мастер `/setup`: запустите его на новой машине и отвечайте на вопросы.
