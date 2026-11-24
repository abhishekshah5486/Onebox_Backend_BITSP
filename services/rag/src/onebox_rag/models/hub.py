from datetime import datetime

from pydantic import Field

from onebox_rag.models.base import CamelModel


class KnowledgeBase(CamelModel):
    """A collection of uploaded files, which folders and records sit in. Its id is unique per
    user (older ones are named by it, e.g. "default"), and its records' source id."""

    id: str
    user_id: str
    name: str
    created_at: datetime
    updated_at: datetime


class Folder(CamelModel):
    id: str = Field(alias="_id")
    user_id: str
    kb_id: str
    # None: directly in the collection.
    parent_id: str | None = None
    name: str
    # 1 for a folder directly in the collection.
    depth: int
    created_at: datetime
    updated_at: datetime
