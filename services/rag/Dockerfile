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
# RapidOCR, BM25 and the token counter fetch their models on first use; fetched here, so pods
# start offline.
ENV FASTEMBED_CACHE_PATH=/app/models/fastembed TIKTOKEN_CACHE_DIR=/app/models/tiktoken
RUN .venv/bin/python -c "from onebox_rag.parsers.ocr.rapid import _engine; _engine()" \
 && .venv/bin/python -c "from onebox_rag.index.embed import warm_sparse; warm_sparse()" \
 && .venv/bin/python -c "import tiktoken; tiktoken.get_encoding('cl100k_base')"

FROM python:3.13.18-slim-bookworm
# cairo draws SVG (cairosvg).
RUN apt-get update && apt-get install -y --no-install-recommends libcairo2=1.16.0-7 \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 1000 --no-create-home app
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY --from=build /app/models /app/models
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 FASTEMBED_CACHE_PATH=/app/models/fastembed \
    TIKTOKEN_CACHE_DIR=/app/models/tiktoken \
    HF_HUB_OFFLINE=1
USER 1000
EXPOSE 4012
CMD ["python", "-m", "onebox_rag"]
