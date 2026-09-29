"""Local token entry; the secret never appears in terminal output."""
import getpass
import os
import re
import sys
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    target = ROOT / ".env"
    config = dotenv_values(target) if target.exists() else {}
    token = os.getenv("BOT_TOKEN") or config.get("BOT_TOKEN", "")
    if token:
        print("Токен уже настроен.")
        return
    print("Открой https://t.me/BotFather → /newbot и создай бота.")
    print("Вставь выданный токен ниже. При вводе символы скрыты.")
    token = getpass.getpass("Токен: ").strip()
    if not re.fullmatch(r"\d+:[A-Za-z0-9_-]{20,}", token):
        raise SystemExit("Не похоже на токен BotFather. Запусти настройку ещё раз.")
    content = target.read_text(encoding="utf-8") if target.exists() else (ROOT / ".env.example").read_text(encoding="utf-8")
    if re.search(r"^BOT_TOKEN=.*$", content, re.M):
        content = re.sub(r"^BOT_TOKEN=.*$", "BOT_TOKEN=" + token, content, flags=re.M)
    else:
        content += "\nBOT_TOKEN=" + token + "\n"
    target.write_text(content, encoding="utf-8")
    print("Настройка сохранена. Теперь бот запустится.")


if __name__ == "__main__":
    main()
