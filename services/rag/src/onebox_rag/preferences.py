"""Each user's own RAG settings, defaulting to the server's: how a search returns results and
how their files are indexed. The server's switches stay the ceiling (summaries switched off
there are off for everyone)."""

from dataclasses import replace
from typing import Any, Literal

from pydantic import Field, model_validator
from pymongo.asynchronous.database import AsyncDatabase

from onebox_rag.config import Settings
from onebox_rag.index.points import SplitSettings
from onebox_rag.models.base import CamelModel
from onebox_rag.models.records import ClassifyStatus, DateOrigin

MAX_RESULTS = 50

Summaries = Literal["on", "first_use", "off"]
HeaderDates = Literal["off", "true", "all"]


class SearchPreferences(CamelModel):
    # Passages a search returns, and at most this many from one record (None: no cap).
    results: int = Field(default=8, ge=1, le=MAX_RESULTS)
    max_per_record: int | None = Field(default=None, ge=1, le=MAX_RESULTS)
    # A search with dates also lists the best matches its dates left out.
    date_safety_net: bool = True


class IndexingPreferences(CamelModel):
    # A model summarizes each file once searchable: right away, on its first search, or never.
    summaries: Summaries = "on"
    # An upload takes the dates its header states: never, in place of its upload time, or
    # also in place of the file's own last-modified time.
    header_dates: HeaderDates = "off"
    # A block too long to embed whole becomes windows this long, overlapping by this much.
    window_chars: int = Field(default=1500, ge=200, le=8000)
    window_overlap: int = Field(default=200, ge=0, le=1000)

    @model_validator(mode="after")
    def _overlap_inside_window(self) -> "IndexingPreferences":
        if self.window_overlap >= self.window_chars:
            raise ValueError("windowOverlap must be shorter than windowChars")
        return self

    def content_dates(self) -> frozenset[DateOrigin]:
        return {
            "off": frozenset(),
            "true": frozenset({DateOrigin.UPLOAD}),
            "all": frozenset({DateOrigin.UPLOAD, DateOrigin.LAST_MODIFIED}),
        }[self.header_dates]

    def classify_status(self) -> ClassifyStatus:
        return {
            "on": ClassifyStatus.QUEUED,
            "first_use": ClassifyStatus.DEFERRED,
            "off": ClassifyStatus.SKIPPED,
        }[self.summaries]

    def split(self, base: SplitSettings) -> SplitSettings:
        return replace(base, window_chars=self.window_chars, window_overlap=self.window_overlap)


class RagPreferences(CamelModel):
    search: SearchPreferences = Field(default_factory=SearchPreferences)
    indexing: IndexingPreferences = Field(default_factory=IndexingPreferences)


def server_defaults(settings: Settings) -> RagPreferences:
    summaries: Summaries = "first_use" if settings.RAG_CLASSIFY_ON_FIRST_USE else "on"
    return RagPreferences(
        search=SearchPreferences(date_safety_net=settings.RAG_DATE_SAFETY_NET),
        indexing=IndexingPreferences(
            summaries=summaries if settings.RAG_CLASSIFY else "off",
            header_dates=settings.RAG_CONTENT_DOCUMENT_DATES,
            window_chars=min(max(settings.RAG_INDEX_WINDOW_CHARS, 200), 8000),
            window_overlap=min(settings.RAG_INDEX_WINDOW_OVERLAP, 1000),
        ),
    )


class PreferenceStore:
    def __init__(self, db: AsyncDatabase[dict[str, Any]], defaults: RagPreferences) -> None:
        self._prefs = db["preferences"]
        self._defaults = defaults

    @property
    def defaults(self) -> RagPreferences:
        return self._defaults

    async def get(self, user_id: str) -> RagPreferences:
        doc = await self._prefs.find_one({"_id": user_id})
        if doc is None:
            return self._defaults
        stored = {k: v for k, v in doc.items() if k != "_id"}
        merged = self._defaults.model_dump(by_alias=True)
        for section, values in stored.items():
            if isinstance(values, dict) and section in merged:
                merged[section] = {**merged[section], **values}
        return RagPreferences.model_validate(merged)

    async def put(self, user_id: str, prefs: RagPreferences) -> RagPreferences:
        await self._prefs.replace_one(
            {"_id": user_id}, {"_id": user_id, **prefs.model_dump(by_alias=True)}, upsert=True
        )
        return prefs

    async def reset(self, user_id: str) -> RagPreferences:
        await self._prefs.delete_one({"_id": user_id})
        return self._defaults
