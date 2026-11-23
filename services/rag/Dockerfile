# The RAG service: docker build -t onebox/rag:dev services/rag
FROM python:3.13.18-slim-bookworm AS build
RUN pip install --no-cache-dir uv==0.13.7
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
# Dependencies first, so code changes reuse this layer.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev --no-editable
# RapidOCR fetches its models on first use; fetched here, so pods start offline.
RUN .venv/bin/python -c "from onebox_rag.parsers.ocr.rapid import _engine; _engine()"

FROM python:3.13.18-slim-bookworm
RUN useradd --uid 1000 --no-create-home app
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1
USER 1000
EXPOSE 4012
CMD ["python", "-m", "onebox_rag"]
