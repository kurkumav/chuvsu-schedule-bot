import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import requests

from bot import Bot, Config, Store, Telegram, TelegramError, TODAY, TOMORROW, chunks
from schedule import ScheduleClient, ScheduleError, parse_timetable, week_set

FIXTURE = Path(__file__).parent / "fixtures" / "group_8075_2026-09-29.html"


class ParserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = FIXTURE.read_text(encoding="utf-8")
        cls.table = parse_timetable(cls.html, 8075)

    def numbers(self, target, subgroup=0):
        week = self.table.week_for(target)
        return [lesson.number for lesson in self.table.lessons if lesson.on(target, week, subgroup)]

    def test_site_metadata_and_odd_tuesday(self):
        self.assertEqual(self.table.group, "ИВТ-13-23")
        self.assertEqual(self.table.anchor_date, date(2026, 9, 29))
        self.assertEqual(self.table.anchor_week, 5)
        self.assertEqual(self.numbers(date(2026, 9, 29)), [4, 5, 6, 7, 8])

    def test_subgroups_and_common_classes(self):
        self.assertEqual(self.numbers(date(2026, 9, 29), 1), [4, 5])
        self.assertEqual(self.numbers(date(2026, 9, 29), 2), [6, 7, 8])
        self.assertEqual(self.numbers(date(2026, 9, 30), 2), [2, 3])
        self.assertEqual(self.numbers(date(2026, 9, 30), 1), [2, 3, 4, 5])

    def test_next_week_monday_switches_parity(self):
        self.assertEqual(self.table.week_for(date(2026, 10, 4)), 5)
        self.assertEqual(self.table.week_for(date(2026, 10, 5)), 6)
        self.assertEqual(self.numbers(date(2026, 10, 6)), [2, 3, 3])

    def test_individual_week_and_range(self):
        self.assertEqual(self.numbers(date(2026, 10, 3)), [1, 2])
        self.assertEqual(self.numbers(date(2026, 10, 10)), [1, 2, 3])
        self.assertEqual(week_set("2 - 4, 7; 9–10"), frozenset([2, 3, 4, 7, 9, 10]))
        with self.assertRaises(ScheduleError):
            week_set("2 - ?")

    def test_replacement_only_on_matching_date(self):
        matching = self.table.render(date(2026, 10, 1), 1)
        self.assertIn("Основное расписание: Г-402", matching)
        self.assertIn("⚠ 01.10.2026 замена на: Аудитория: Б-202", matching)
        self.assertNotIn("Б-202", self.table.render(date(2026, 10, 8), 1))
        self.assertNotIn("Б-202", self.table.render(date(2026, 10, 1), 2))

    def test_sunday_and_date_limits(self):
        self.assertIn("занятий нет", self.table.render(date(2026, 10, 4)))
        with self.assertRaises(ScheduleError):
            self.table.render(date(2026, 12, 1))

    def test_login_and_broken_layout_are_errors(self):
        with self.assertRaises(ScheduleError):
            parse_timetable('<form id="authtt"></form>', 8075)
        with self.assertRaises(ScheduleError):
            parse_timetable(self.html.replace('id="groupstt"', 'id="new-layout"'), 8075)
        with self.assertRaises(ScheduleError):
            parse_timetable(self.html.replace('class="tdd"', 'class="unknown"'), 8075)
        with self.assertRaises(ScheduleError):
            parse_timetable(self.html.replace('value="1" id="htype"', 'value="2" id="htype"'), 8075)

    def test_guest_entry_and_cache(self):
        client = ScheduleClient()
        calls = []

        def request(method, url, **kwargs):
            calls.append((method, url, kwargs))
            if len(calls) == 1:
                return '<form id="authtt"></form>'
            return self.html

        with patch.object(client, "_request", side_effect=request):
            self.assertEqual(client.get().group, "ИВТ-13-23")
            client.get()
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1][0:2], ("POST", "https://tt.chuvsu.ru/auth"))
        self.assertIn("guest", calls[1][2]["data"])


class FakeTelegram:
    def __init__(self):
        self.messages = []
        self.calls = []
        self.error = None

    def send(self, chat_id, text, markup=None):
        if self.error:
            raise self.error
        self.messages.append((chat_id, text, markup))

    def call(self, method, **kwargs):
        self.calls.append((method, kwargs))
        return True


class FakeSchedule:
    url = "https://tt.chuvsu.ru/index/grouptt/gr/8075"

    def __init__(self):
        self.table = parse_timetable(FIXTURE.read_text(encoding="utf-8"), 8075)
        self.error = False

    def get(self):
        if self.error:
            raise ScheduleError("Сайт недоступен")
        return self.table


class BotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "state.sqlite3"
        self.store = Store(self.path)
        self.addCleanup(lambda: self.store.db.close())
        self.telegram, self.schedule = FakeTelegram(), FakeSchedule()
        self.config = Config("123:test", 8075, ZoneInfo("Europe/Moscow"), 7, 0, frozenset())
        self.bot = Bot(self.config, self.telegram, self.schedule, self.store)
        self.now = datetime(2026, 9, 29, 6, 59, tzinfo=self.config.zone)
        self.bot.now = lambda: self.now

    def message(self, text, chat_type="private", user_id=42):
        self.bot.handle({"message": {"chat": {"id": user_id, "type": chat_type}, "from": {"id": user_id}, "text": text}})

    def callback(self, data):
        self.bot.handle({"callback_query": {"id": "query", "from": {"id": 42}, "data": data,
                                           "message": {"chat": {"id": 42, "type": "private"}}}})

    def test_today_tomorrow_and_subgroup_buttons(self):
        self.callback("group:1")
        self.message(TODAY)
        self.assertIn("29.09.2026", self.telegram.messages[-1][1])
        self.assertNotIn("2 подгруппа", self.telegram.messages[-1][1])
        self.message(TOMORROW)
        self.assertIn("30.09.2026", self.telegram.messages[-1][1])
        self.callback("day:2026-10-01")
        self.assertIn("Б-202", self.telegram.messages[-1][1])
        self.assertEqual(self.telegram.calls[0][0], "answerCallbackQuery")

    def test_date_and_invalid_date(self):
        self.message("31.02.2026")
        self.assertIn("Такой даты нет", self.telegram.messages[-1][1])
        self.message("01.10.2026")
        self.assertIn("01.10.2026", self.telegram.messages[-1][1])
        self.callback("day:2026-12-25")
        self.assertIn("Выбери новую дату", self.telegram.messages[-1][1])

    def test_picker_and_keyboard(self):
        self.message("/days")
        markup = self.telegram.messages[-1][2]
        self.assertEqual(sum(len(row) for row in markup["inline_keyboard"]), 14)
        self.message("/start")
        self.assertIn("Расписание на сегодня", self.telegram.messages[-1][1])

    def test_daily_opt_in_time_and_persistence(self):
        self.bot.daily()
        self.assertEqual(self.telegram.messages, [])
        self.message("/subscribe")
        self.telegram.messages.clear()
        self.bot.daily()
        self.assertEqual(self.telegram.messages, [])
        self.now = self.now.replace(hour=7, minute=0)
        self.bot.daily()
        self.assertEqual(len(self.telegram.messages), 1)
        self.bot.daily()
        self.assertEqual(len(self.telegram.messages), 1)
        self.store.db.close()
        self.store = Store(self.path)
        self.bot.store = self.store
        self.bot.daily()
        self.assertEqual(len(self.telegram.messages), 1)
        self.now = self.now + timedelta(days=1)
        self.bot.daily()
        self.assertEqual(len(self.telegram.messages), 2)

    def test_subscribe_after_delivery_starts_tomorrow(self):
        self.now = self.now.replace(hour=8)
        self.message("/subscribe")
        self.telegram.messages.clear()
        self.bot.daily()
        self.assertEqual(self.telegram.messages, [])
        self.assertEqual(self.store.user(42)["since_date"], "2026-09-30")
        self.message("/unsubscribe")
        self.assertEqual(self.store.user(42)["subscribed"], 0)

    def test_site_failure_does_not_claim_no_classes_or_finish_delivery(self):
        self.message("/subscribe")
        self.schedule.error = True
        self.now = self.now.replace(hour=7)
        self.bot.daily()
        self.assertIsNone(self.store.user(42)["last_sent"])
        self.message(TODAY)
        self.assertIn("Сайт недоступен", self.telegram.messages[-1][1])
        self.assertNotIn("занятий нет", self.telegram.messages[-1][1])

    def test_telegram_failure_retries_and_block_unsubscribes(self):
        self.message("/subscribe")
        self.now = self.now.replace(hour=7)
        self.telegram.error = TelegramError("outage", 500)
        self.bot.daily()
        self.assertIsNone(self.store.user(42)["last_sent"])
        self.bot.retry_at.clear()
        self.telegram.error = TelegramError("blocked", 403)
        self.bot.daily()
        self.assertEqual(self.store.user(42)["subscribed"], 0)

    def test_access_restriction_and_group_chats(self):
        self.message(TODAY, chat_type="group")
        self.assertEqual(self.telegram.messages, [])
        self.bot.config = Config("", 8075, self.config.zone, 7, 0, frozenset([42]))
        self.message(TODAY, user_id=99)
        self.assertEqual(self.telegram.messages, [])

    def test_chunking_respects_utf16_limit(self):
        for text in ["📚" * 5000, ("пара\n" * 2000), "a" * 9000]:
            pieces = chunks(text)
            self.assertTrue(all(0 < len(piece.encode("utf-16-le")) // 2 <= 3500 for piece in pieces))
            self.assertEqual("".join(pieces).replace("\n", ""), text.replace("\n", ""))

    def test_token_is_not_in_network_error(self):
        telegram = Telegram("123:very_secret_token")
        with patch.object(telegram.session, "post", side_effect=requests.ConnectionError("https://api.telegram.org/bot123:very_secret_token")):
            with self.assertRaises(TelegramError) as failure:
                telegram.call("getMe")
        self.assertNotIn("very_secret_token", str(failure.exception))


if __name__ == "__main__":
    unittest.main()
