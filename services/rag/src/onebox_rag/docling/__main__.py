import argparse

import uvicorn
from fastapi import FastAPI

from onebox_rag.docling.config import load_docling_settings
from onebox_rag.docling.service import create_docling_app
from onebox_rag.logs import configure_logging


def app_from_env() -> FastAPI:
    settings = load_docling_settings()
    configure_logging(settings.LOG_LEVEL)
    return create_docling_app(settings)


def main() -> None:
    parser = argparse.ArgumentParser(prog="onebox_rag.docling")
    parser.add_argument("--reload", action="store_true", help="restart on code changes (dev)")
    args = parser.parse_args()
    settings = load_docling_settings()
    uvicorn.run(
        "onebox_rag.docling.__main__:app_from_env",
        factory=True,
        host=settings.HOST,
        port=settings.DOCLING_PORT,
        reload=args.reload,
        log_config=None,
        access_log=False,
    )


if __name__ == "__main__":
    main()
