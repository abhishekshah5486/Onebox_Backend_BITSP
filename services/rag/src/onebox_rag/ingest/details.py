"""What a record's details show beyond the record: where it sits and how far each stage got."""

from typing import Any

from onebox_rag.models import Content, Stage, Status

READ_OUTCOMES = {Status.EMPTY, Status.FILE_TYPE_NOT_SUPPORTED, Status.PASSWORD_PROTECTED}


def _stage(name: str, status: str, reason: str | None = None) -> dict[str, Any]:
    return {"stage": name, "status": status.upper(), "reason": reason}


def stage_states(content: Content) -> list[dict[str, Any]]:
    """Reading, indexing and summarizing, for the content's current revision."""
    waiting = content.status in {Status.QUEUED, Status.IN_PROGRESS}
    if waiting and content.stage == Stage.PARSE:
        parse = _stage("parse", content.status)
    elif content.status in READ_OUTCOMES:
        parse = _stage("parse", content.status, content.reason)
    elif content.status == Status.FAILED and content.blocks_key is None:
        parse = _stage("parse", Status.FAILED, content.reason)
    else:
        parse = _stage("parse", Status.COMPLETED)

    if parse["status"] != "COMPLETED":
        index = _stage("index", "NOT_STARTED")
    elif waiting:
        index = _stage("index", content.status)
    elif content.status == Status.FAILED:
        index = _stage("index", Status.FAILED, content.reason)
    else:
        index = _stage("index", Status.COMPLETED)

    summary = content.classify_status.value if content.classify_status else "not_started"
    return [parse, index, _stage("classify", summary, content.classify_reason)]


def content_facts(content: Content) -> dict[str, Any]:
    return {
        "blockCount": content.block_count,
        "engine": content.engine,
        "embeddingModel": content.embedding_model,
        "pointCount": content.point_count,
        "revision": content.revision,
    }
