"""Telegram bot using Bot API long polling. Run --check without a Telegram token."""
from __future__ import annotations

import argparse
import logging
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

from schedule import ScheduleClient, ScheduleError

ROOT = Path(__file__).resolve().parent
TODAY = "📅 Расписание на сегодня"
TOMORROW = "🌅 Расписание на завтра"
WEEK = "🗓 Расписание на неделю"
PICK = "🗓 Выбрать день"
GROUP = "👥 Подгруппа"
SUBSCRIBE = "🔔 Ежедневная рассылка"
STOP = "🔕 Отключить рассылку"
KEYBOARD = {
    "keyboard": [[{"text": TODAY}, {"text": WEEK}], [{"text": TOMORROW}, {"text": PICK}],
                 [{"text": GROUP}, {"text": SUBSCRIBE}], [{"text": STOP}]],
    "resize_keyboard": True,
    "is_persistent": True,
}
LOG = logging.getLogger("chuvsu_bot")


@dataclass(frozen=True)
class Config:
    token: str
    group_id: int
    zone: ZoneInfo
    daily_hour: int
    daily_minute: int
    allowed_users: frozenset[int]

    @classmethod
    def load(cls):
        load_dotenv(ROOT / ".env")
        daily = os.getenv("DAILY_TIME", "07:00")
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", daily):
            raise ValueError("DAILY_TIME должен быть в формате ЧЧ:ММ, например 07:00.")
        hour, minute = map(int, daily.split(":"))
        group_id = int(os.getenv("GROUP_ID", "8075"))
        if group_id <= 0:
            raise ValueError("GROUP_ID должен быть положительным числом.")
        return cls(os.getenv("BOT_TOKEN", "").strip(), group_id,
                   ZoneInfo(os.getenv("BOT_TIMEZONE", "Europe/Moscow")), hour, minute,
                   frozenset(int(n.strip()) for n in os.getenv("ALLOWED_USER_IDS", "").split(",") if n.strip()))


class TelegramError(Exception):
    def __init__(self, description: str, code: int = 0, retry_after: int = 5):
        super().__init__(description)
        self.code = code
        self.retry_after = max(1, retry_after)


def chunks(text: str, max_units: int = 3500) -> list[str]:
    """Telegram measures UTF-16 units. Preserve whole lines where possible."""
    result, current, units = [], "", 0
    for character in text:
        cost = 2 if ord(character) > 0xFFFF else 1
        if units + cost > max_units:
            split = current.rfind("\n")
            if split >= max_units // 2:
                result.append(current[:split])
                current = current[split + 1:]
                units = len(current.encode("utf-16-le")) // 2
            else:
                result.append(current)
                current, units = "", 0
        current += character
        units += cost
    if current:
        result.append(current)
    return result


class Telegram:
    def __init__(self, token: str):
        self.token = token
        self.session = requests.Session()

    def call(self, method: str, **parameters):
        try:
            response = self.session.post(f"https://api.telegram.org/bot{self.token}/{method}",
                                         json=parameters, timeout=(10, 35))
            payload = response.json()
        except (requests.RequestException, ValueError) as error:
            # requests exception strings contain the token-bearing URL; don't log them.
            raise TelegramError("Нет соединения с Telegram.") from error
        if not payload.get("ok"):
            description = str(payload.get("description", "Ошибка Telegram")).replace(self.token, "[TOKEN]")
            raise TelegramError(description, payload.get("error_code", response.status_code),
                                payload.get("parameters", {}).get("retry_after", 5))
        return payload["result"]

    def send(self, chat_id: int, text: str, markup=None):
        pieces = chunks(text)
        for index, piece in enumerate(pieces):
            self.call("sendMessage", chat_id=chat_id, text=piece,
                      reply_markup=(markup if markup is not None else KEYBOARD) if index == len(pieces) - 1 else None,
                      link_preview_options={"is_disabled": True})


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("""CREATE TABLE IF NOT EXISTS users (
            chat_id INTEGER PRIMARY KEY, subgroup INTEGER NOT NULL DEFAULT 0,
            subscribed INTEGER NOT NULL DEFAULT 0, last_sent TEXT, since_date TEXT)""")
        self.db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.db.commit()

    def user(self, chat_id: int):
        self.db.execute("INSERT OR IGNORE INTO users(chat_id) VALUES (?)", (chat_id,))
        self.db.commit()
        return self.db.execute("SELECT * FROM users WHERE chat_id=?", (chat_id,)).fetchone()

    def set_subgroup(self, chat_id: int, subgroup: int):
        self.user(chat_id)
        self.db.execute("UPDATE users SET subgroup=? WHERE chat_id=?", (subgroup, chat_id))
        self.db.commit()

    def subscribe(self, chat_id: int, enabled: bool, since: date | None = None):
        self.user(chat_id)
        self.db.execute("UPDATE users SET subscribed=?, since_date=? WHERE chat_id=?",
                        (int(enabled), since.isoformat() if since else None, chat_id))
        self.db.commit()

    def subscribers(self):
        return self.db.execute("SELECT * FROM users WHERE subscribed=1").fetchall()

    def mark_sent(self, chat_id: int, target: date):
        self.db.execute("UPDATE users SET last_sent=? WHERE chat_id=?", (target.isoformat(), chat_id))
        self.db.commit()

    @property
    def offset(self) -> int:
        row = self.db.execute("SELECT value FROM meta WHERE key='offset'").fetchone()
        return int(row[0]) if row else 0

    @offset.setter
    def offset(self, value: int):
        self.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES ('offset',?)", (str(value),))
        self.db.commit()


class Bot:
    def __init__(self, config: Config, telegram: Telegram, schedule: ScheduleClient, store: Store):
        self.config, self.telegram, self.schedule, self.store = config, telegram, schedule, store
        self.retry_at: dict[int, float] = {}

    def now(self):
        return datetime.now(self.config.zone)

    def authorized(self, user_id: int) -> bool:
        return not self.config.allowed_users or user_id in self.config.allowed_users

    def show_day(self, chat_id: int, target: date):
        # Also validate callbacks against today's date so old keyboards don't bypass the limit.
        if not -7 <= (target - self.now().date()).days <= 14:
            self.telegram.send(chat_id, "Выбери новую дату: доступны последняя неделя и 14 дней вперёд.")
            return
        try:
            text = self.schedule.get().render(target, self.store.user(chat_id)["subgroup"])
        except ScheduleError as error:
            text = f"⚠ {error}\n\n{self.schedule.url}"
        self.telegram.send(chat_id, text)

    def show_week(self, chat_id: int, today: date):
        try:
            text = self.schedule.get().render_week(today, self.store.user(chat_id)["subgroup"])
        except ScheduleError as error:
            text = f"⚠ {error}\n\n{self.schedule.url}"
        self.telegram.send(chat_id, text)

    def handle(self, update: dict):
        if "callback_query" in update:
            self.callback(update["callback_query"])
            return
        message = update.get("message", {})
        chat = message.get("chat", {})
        if chat.get("type") != "private" or not self.authorized(message.get("from", {}).get("id", 0)):
            return
        chat_id = chat["id"]
        self.store.user(chat_id)
        text = message.get("text", "").strip()
        command = text.split(maxsplit=1)[0].split("@")[0].lower() if text else ""
        today = self.now().date()
        if command in ("/start", "/help"):
            self.telegram.send(chat_id, "Привет! Я показываю расписание твоей группы с сайта ЧувГУ.\n\n"
                               "Нажми «Расписание на сегодня» или «Расписание на неделю». В «Подгруппа» можно оставить только свои пары.\n\n"
                               f"Рассылка включается кнопкой и приходит в {self.config.daily_hour:02}:{self.config.daily_minute:02} "
                               f"({self.config.zone.key}).\n"
                               "Команды: /today, /tomorrow, /week, /days, /group, /subscribe, /unsubscribe.\n"
                               "Любую ближайшую дату можно отправить как ДД.ММ.ГГГГ.")
        elif text == TODAY or command == "/today":
            self.show_day(chat_id, today)
        elif text == WEEK or command == "/week":
            self.show_week(chat_id, today)
        elif text == TOMORROW or command == "/tomorrow":
            self.show_day(chat_id, today + timedelta(days=1))
        elif text == PICK or command == "/days":
            dates = [today + timedelta(days=n) for n in range(14)]
            buttons = [{"text": f"{('Пн','Вт','Ср','Чт','Пт','Сб','Вс')[d.weekday()]} {d:%d.%m}",
                        "callback_data": f"day:{d.isoformat()}"} for d in dates]
            self.telegram.send(chat_id, "Расписание на какой день?", {"inline_keyboard": [buttons[i:i + 2] for i in range(0, 14, 2)]})
        elif text == GROUP or command == "/group":
            self.telegram.send(chat_id, "Выбери свою подгруппу:", {"inline_keyboard": [
                [{"text": "1-я подгруппа", "callback_data": "group:1"}, {"text": "2-я подгруппа", "callback_data": "group:2"}],
                [{"text": "Все подгруппы", "callback_data": "group:0"}],
            ]})
        elif text == SUBSCRIBE or command == "/subscribe":
            if not self.store.user(chat_id)["subscribed"]:
                delivery = today if (self.now().hour, self.now().minute) < (self.config.daily_hour, self.config.daily_minute) else today + timedelta(days=1)
                self.store.subscribe(chat_id, True, delivery)
            self.telegram.send(chat_id, f"🔔 Рассылка включена: каждый день в {self.config.daily_hour:02}:{self.config.daily_minute:02} "
                               f"({self.config.zone.key}).\nПервое сообщение — в ближайшее такое время. Бот должен быть запущен.")
        elif text == STOP or command == "/unsubscribe":
            self.store.subscribe(chat_id, False)
            self.telegram.send(chat_id, "🔕 Рассылка отключена. Расписание по кнопкам по-прежнему доступно.")
        elif re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", text):
            try:
                target = datetime.strptime(text, "%d.%m.%Y").date()
            except ValueError:
                self.telegram.send(chat_id, "Такой даты нет. Отправь дату в формате ДД.ММ.ГГГГ.")
            else:
                self.show_day(chat_id, target)
        else:
            self.telegram.send(chat_id, "Выбери кнопку внизу или отправь дату в формате ДД.ММ.ГГГГ.")

    def callback(self, callback: dict):
        message = callback.get("message", {})
        if message.get("chat", {}).get("type") != "private" or not self.authorized(callback.get("from", {}).get("id", 0)):
            self.telegram.call("answerCallbackQuery", callback_query_id=callback["id"], text="Нет доступа.")
            return
        self.telegram.call("answerCallbackQuery", callback_query_id=callback["id"])
        chat_id = message["chat"]["id"]
        data = callback.get("data", "")
        if re.fullmatch(r"group:[012]", data):
            subgroup = int(data[-1])
            self.store.set_subgroup(chat_id, subgroup)
            self.telegram.send(chat_id, "Сохранено: " + (f"{subgroup}-я подгруппа." if subgroup else "все подгруппы."))
        elif data.startswith("day:"):
            try:
                target = date.fromisoformat(data[4:])
            except ValueError:
                self.telegram.send(chat_id, "Выбери день заново через кнопку «Выбрать день».")
            else:
                self.show_day(chat_id, target)

    def daily(self):
        now = self.now()
        if (now.hour, now.minute) < (self.config.daily_hour, self.config.daily_minute):
            return
        today = now.date()
        for user in self.store.subscribers():
            chat_id = user["chat_id"]
            if not self.authorized(chat_id) or user["last_sent"] == today.isoformat():
                continue
            if user["since_date"] and user["since_date"] > today.isoformat():
                continue
            if time.monotonic() < self.retry_at.get(chat_id, 0):
                continue
            try:
                text = self.schedule.get().render(today, user["subgroup"])
                self.telegram.send(chat_id, "🔔 Расписание на сегодня\n\n" + text)
            except ScheduleError:
                # Don't turn a temporary website outage into a 'no classes' delivery.
                self.retry_at[chat_id] = time.monotonic() + 300
                LOG.warning("Сайт недоступен для рассылки; повтор через 5 минут.")
            except TelegramError as error:
                if error.code == 403:
                    self.store.subscribe(chat_id, False)
                elif error.code in (401, 409):
                    raise
                else:
                    self.retry_at[chat_id] = time.monotonic() + max(60, error.retry_after)
                LOG.warning("Сообщение рассылки не доставлено (код %s).", error.code)
            else:
                self.store.mark_sent(chat_id, today)
                self.retry_at.pop(chat_id, None)

    def run(self):
        identity = self.telegram.call("getMe")
        webhook = self.telegram.call("getWebhookInfo")
        if webhook.get("url"):
            raise ValueError("У этого бота уже настроен webhook. Создай нового бота в BotFather или отключи прежний webhook.")
        self.telegram.call("setMyCommands", commands=[
            {"command": "today", "description": "Расписание на сегодня"},
            {"command": "tomorrow", "description": "Расписание на завтра"},
            {"command": "days", "description": "Выбрать день"},
            {"command": "group", "description": "Выбрать подгруппу"},
            {"command": "subscribe", "description": "Включить ежедневную рассылку"},
            {"command": "unsubscribe", "description": "Отключить рассылку"},
        ])
        LOG.info("Бот @%s запущен. Открой его в Telegram и нажми /start.", identity["username"])
        while True:
            try:
                self.daily()
                updates = self.telegram.call("getUpdates", offset=self.store.offset,
                                             timeout=20, allowed_updates=["message", "callback_query"])
                for update in updates:
                    self.handle(update)
                    self.store.offset = update["update_id"] + 1
            except TelegramError as error:
                if error.code in (401, 409):
                    raise
                LOG.warning("Ошибка Telegram (код %s), повтор соединения.", error.code)
                time.sleep(min(60, error.retry_after))


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Бот расписания ЧувГУ")
    parser.add_argument("--check", action="store_true", help="Проверить сайт без токена Telegram")
    parser.add_argument("--date", type=date.fromisoformat, help="Дата проверки: ГГГГ-ММ-ДД")
    parser.add_argument("--subgroup", type=int, choices=(0, 1, 2), default=0)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = Config.load()
        schedule = ScheduleClient(config.group_id)
        if args.check:
            print(schedule.get().render(args.date or datetime.now(config.zone).date(), args.subgroup))
            return 0
        if not re.fullmatch(r"\d+:[A-Za-z0-9_-]{20,}", config.token):
            print("Нужен токен Telegram. Запусти setup.py или укажи BOT_TOKEN в .env.")
            return 1
        Bot(config, Telegram(config.token), schedule, Store(ROOT / "data" / "bot.sqlite3")).run()
    except KeyboardInterrupt:
        print("\nБот остановлен.")
        return 0
    except (ValueError, ScheduleError, TelegramError) as error:
        LOG.error("%s", error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
