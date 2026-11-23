import argparse

import uvicorn
from fastapi import FastAPI

from onebox_rag.app import create_app
from onebox_rag.config import load_settings
from onebox_rag.logs import configure_logging


def app_from_env() -> FastAPI:
    settings = load_settings()
    configure_logging(settings.LOG_LEVEL)
    return create_app(settings)


def main() -> None:
    parser = argparse.ArgumentParser(prog="onebox_rag")
    parser.add_argument("--reload", action="store_true", help="restart on code changes (dev)")
    args = parser.parse_args()
    settings = load_settings()
    uvicorn.run(
        "onebox_rag.__main__:app_from_env",
        factory=True,
        host=settings.HOST,
        port=settings.PORT,
        reload=args.reload,
        log_config=None,
        access_log=False,
    )


if __name__ == "__main__":
    main()
