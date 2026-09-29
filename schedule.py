"""Read the public guest timetable; never execute scripts from the website."""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import date, timedelta

import requests
import truststore
from bs4 import BeautifulSoup, Tag

# Use the OS certificate store, including on Windows. TLS stays verified.
truststore.inject_into_ssl()

BASE_URL = "https://tt.chuvsu.ru"
DAY_NAMES = ("Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье")
MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4,
    "мая": 5, "июня": 6, "июля": 7, "августа": 8,
    "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
}


class ScheduleError(Exception):
    """A readable failure, rather than a false 'no lessons' result."""


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def week_set(expression: str) -> frozenset[int]:
    expression = expression.replace("–", "-").replace("—", "-")
    expression = re.sub(r"\s+", "", expression)
    if not re.fullmatch(r"\d+(?:-\d+)?(?:[,;]\d+(?:-\d+)?)*", expression):
        raise ScheduleError(f"Не удалось разобрать недели занятия: {expression}")
    result: set[int] = set()
    for part in re.split(r"[,;]", expression):
        bounds = [int(n) for n in part.split("-")]
        start, end = bounds[0], bounds[-1]
        if not 1 <= start <= end <= 60:
            raise ScheduleError("На сайте появился неизвестный диапазон учебных недель.")
        result.update(range(start, end + 1))
    return frozenset(result)


@dataclass(frozen=True)
class Lesson:
    weekday: int
    number: int
    start: str
    end: str
    text: str
    weeks: frozenset[int] | None
    parity: int | None  # 1 = *, odd week; 0 = **, even week
    subgroup: int | None
    changes: tuple[tuple[date, str], ...] = ()

    def on(self, target: date, week: int, subgroup: int) -> bool:
        return (
            self.weekday == target.weekday()
            and (self.weeks is None or week in self.weeks)
            and (self.parity is None or week % 2 == self.parity)
            and (not subgroup or self.subgroup is None or subgroup == self.subgroup)
        )

    def description(self, target: date) -> str:
        notes = [note for when, note in self.changes if when == target]
        if not notes:
            return self.text
        return "Основное расписание: " + self.text + "\n" + "\n".join("⚠ " + note for note in notes)


@dataclass(frozen=True)
class Timetable:
    group: str
    group_id: int
    anchor_date: date
    anchor_week: int
    semester: int
    lessons: tuple[Lesson, ...]

    def week_for(self, target: date) -> int:
        anchor_monday = self.anchor_date - timedelta(days=self.anchor_date.weekday())
        target_monday = target - timedelta(days=target.weekday())
        return self.anchor_week + (target_monday - anchor_monday).days // 7

    def render(self, target: date, subgroup: int = 0) -> str:
        if subgroup not in (0, 1, 2):
            raise ValueError("subgroup must be 0, 1 or 2")
        if not -7 <= (target - self.anchor_date).days <= 14:
            raise ScheduleError("Можно посмотреть дни за последнюю неделю и на 14 дней вперёд.")
        week = self.week_for(target)
        if week < 1 or week > 30:
            raise ScheduleError("Для этой даты нельзя определить учебную неделю по текущему расписанию.")
        selection = "Все подгруппы" if not subgroup else f"{subgroup}-я подгруппа"
        lines = [
            f"📚 {self.group}",
            f"📅 {DAY_NAMES[target.weekday()]}, {target:%d.%m.%Y}",
            f"Неделя {week} · {'нечётная' if week % 2 else 'чётная'} · {selection}",
            "",
        ]
        matches = [lesson for lesson in self.lessons if lesson.on(target, week, subgroup)]
        current_number = None
        for lesson in sorted(matches, key=lambda item: item.number):
            if lesson.number != current_number:
                if current_number is not None:
                    lines.append("")
                lines.append(f"🕒 {lesson.number} пара · {lesson.start}–{lesson.end}")
                current_number = lesson.number
            lines.append(lesson.description(target))
        if not matches:
            lines.append("По опубликованному расписанию занятий нет 🎉")
        lines.extend(["", "Замены показаны ниже соответствующей пары. Сайт может обновить расписание.",
                      f"Источник: {BASE_URL}/index/grouptt/gr/{self.group_id}"])
        return "\n".join(lines)


def parse_timetable(html: str, group_id: int) -> Timetable:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="groupstt")
    if table is None:
        if soup.find("form", id="authtt"):
            raise ScheduleError("Сайт не предоставил гостевой доступ. Попробуй позже.")
        raise ScheduleError("Не удалось найти таблицу расписания. Возможно, сайт изменился.")
    text = clean(soup.get_text(" ", strip=True))
    group_match = re.search(r"Группа\s+([^\s()]+)", text)
    date_match = re.search(r"(\d{1,2})\s+(" + "|".join(MONTHS) + r")\s+(\d{4})\s*г\.", text, re.I)
    week_match = re.search(r"идет\s+(\d+)\s*(?:\*+\s*)?неделя", text, re.I)
    semester_tag = soup.find("input", id="htype")
    if not group_match or not date_match or not week_match or semester_tag is None:
        raise ScheduleError("Не удалось прочитать группу, дату или учебную неделю на сайте.")
    semester = int(semester_tag.get("value", "0"))
    if semester not in (1, 3):
        raise ScheduleError("Сейчас на сайте сессия или другой учебный период. Открой расписание на сайте: бот поддерживает обычные осенний и весенний семестры.")
    anchor = date(int(date_match[3]), MONTHS[date_match[2].lower()], int(date_match[1]))
    anchor_week = int(week_match[1])
    if not 1 <= anchor_week <= 30:
        raise ScheduleError("Неизвестный номер учебной недели на сайте.")
    lessons: list[Lesson] = []
    slot_count = 0
    for cell in table.find_all("td", id=re.compile(rf"^td[1-6]t\d+g{group_id}$")):
        cell_match = re.fullmatch(rf"td([1-6])t(\d+)g{group_id}", cell["id"])
        weekday, number = int(cell_match[1]) - 1, int(cell_match[2])
        time_label = soup.find(id=f"trd{weekday + 1}t{number}")
        time_match = re.search(r"(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})", time_label.get_text(" ") if time_label else "")
        if not time_match:
            raise ScheduleError("Не удалось прочитать время пары на сайте.")
        slot_count += 1
        entries = cell.select(".tdd > table > tr > td, .tdd > table > tbody > tr > td")
        if clean(cell.get_text(" ", strip=True)) and not entries:
            raise ScheduleError("Структура описания занятия изменилась; расписание не прочитано.")
        for entry in entries:
            lessons.append(parse_lesson(entry, weekday, number, time_match[1], time_match[2]))
    if not slot_count:
        raise ScheduleError("Таблица имеет неизвестную структуру; расписание не прочитано.")
    return Timetable(group_match[1], group_id, anchor, anchor_week, semester, tuple(lessons))


def parse_lesson(entry: Tag, weekday: int, number: int, start: str, end: str) -> Lesson:
    entry = BeautifulSoup(str(entry), "html.parser").find("td")
    changes: list[tuple[date, str]] = []
    # Replacement notices are inside separate divs. Keep only those for the requested date.
    for block in list(entry.find_all("div", recursive=False)):
        block_text = clean(block.get_text(" ", strip=True))
        change_dates = re.findall(r"\b(\d{2}\.\d{2}\.\d{4})\b", block_text)
        if change_dates:
            for raw_date in dict.fromkeys(change_dates):
                day, month, year = map(int, raw_date.split("."))
                try:
                    when = date(year, month, day)
                except ValueError as error:
                    raise ScheduleError("Некорректная дата замены на сайте.") from error
                changes.append((when, block_text))
            block.decompose()
    parity = None
    for marker in list(entry.find_all("sup")):
        value = clean(marker.get_text())
        if value == "*":
            parity = 1
        elif value == "**":
            parity = 0
        else:
            raise ScheduleError("Неизвестная отметка недели у занятия.")
        marker.decompose()
    full_text = clean(entry.get_text(" ", strip=True))
    if not full_text:
        raise ScheduleError("На сайте обнаружено пустое описание занятия.")
    week_match = re.search(r"\(([^()]*)\s+нед\.?\)", full_text, re.I)
    weeks = week_set(week_match[1]) if week_match else None
    if re.search(r"\bнед\.?", full_text, re.I) and week_match is None:
        raise ScheduleError("Не удалось прочитать ограничение занятия по неделям.")
    subgroup_match = re.search(r"\b(\d+)\s*подгрупп", full_text, re.I)
    subgroup = int(subgroup_match[1]) if subgroup_match else None
    if subgroup is not None and subgroup not in (1, 2):
        raise ScheduleError("На сайте появилась неизвестная подгруппа.")
    if week_match:
        full_text = clean(full_text[:week_match.start()] + full_text[week_match.end():])
    return Lesson(weekday, number, start, end, full_text, weeks, parity, subgroup, tuple(changes))


class ScheduleClient:
    def __init__(self, group_id: int = 8075, cache_seconds: int = 120):
        self.group_id = group_id
        self.url = f"{BASE_URL}/index/grouptt/gr/{group_id}"
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "ChuvsuScheduleBot/1.0"
        self.cache_seconds = cache_seconds
        self._cached: Timetable | None = None
        self._cached_at = 0.0

    def _request(self, method: str, url: str, **kwargs) -> str:
        response = self.session.request(method, url, timeout=(10, 25), **kwargs)
        response.raise_for_status()
        return response.content.decode("utf-8")

    def get(self) -> Timetable:
        if self._cached is not None and time.monotonic() - self._cached_at < self.cache_seconds:
            return self._cached
        try:
            html = self._request("GET", self.url)
            if BeautifulSoup(html, "html.parser").find("form", id="authtt"):
                # Posting to the original group URL redirects to /auth and drops the POST body.
                self._request("POST", f"{BASE_URL}/auth", data={
                    "guest": "Войти гостем", "wauto": "1", "wname": "", "wpass": "", "pertt": "1",
                })
                html = self._request("GET", self.url)
            timetable = parse_timetable(html, self.group_id)
        except (requests.RequestException, UnicodeError) as error:
            raise ScheduleError("Сайт расписания сейчас недоступен. Попробуй через несколько минут.") from error
        self._cached, self._cached_at = timetable, time.monotonic()
        return timetable
