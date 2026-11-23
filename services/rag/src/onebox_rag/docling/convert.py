"""Runs in the Docling service's worker processes: one converter per process, kept warm."""

import io
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from onebox_rag.parsers.base import UnreadableFileError
from onebox_rag.parsers.libreoffice import convert_with_libreoffice


@dataclass(frozen=True)
class ConvertOptions:
    table_mode: str  # "accurate" (Docling's default, keeps multi-line cells) or "fast"
    images_scale: float
    timeout_s: float
    soffice: str
    # RapidOCR over picture regions (scanned pages go to the RAG service's own OCR instead).
    ocr: bool = False


@lru_cache(maxsize=2)
def _converter(options: ConvertOptions) -> Any:
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import (
        RapidOcrOptions,
        TableFormerMode,
        TableStructureOptions,
        ThreadedPdfPipelineOptions,
    )
    from docling.document_converter import (
        DocumentConverter,
        PdfFormatOption,
        PowerpointFormatOption,
        WordFormatOption,
    )

    # OCR off unless asked for (scanned pages go to our OCR engine), accurate
    # tables, picture images kept for descriptions, small batches to bound memory.
    pdf_options = ThreadedPdfPipelineOptions(
        do_ocr=options.ocr,
        ocr_options=RapidOcrOptions(),
        do_table_structure=True,
        table_structure_options=TableStructureOptions(mode=TableFormerMode(options.table_mode)),
        generate_picture_images=True,
        images_scale=options.images_scale,
        layout_batch_size=1,
        table_batch_size=1,
        queue_max_size=10,
        document_timeout=options.timeout_s,
    )
    # Docling sniffs formats from the bytes; allowing only these keeps a file routed as a PDF
    # from reaching its HTML, LaTeX or JSON backends.
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF, InputFormat.DOCX, InputFormat.PPTX],
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=pdf_options, backend=PyPdfiumDocumentBackend
            ),
            InputFormat.DOCX: WordFormatOption(),
            InputFormat.PPTX: PowerpointFormatOption(),
        },
    )


def warm_up(options: ConvertOptions) -> bool:
    """Loads the PDF pipeline's models before the first real file (Docling defers it)."""
    from docling.datamodel.base_models import InputFormat

    _converter(options).initialize_pipeline(InputFormat.PDF)
    return True


def convert_document(
    data: bytes, target: str, legacy_ext: str | None, options: ConvertOptions
) -> dict[str, Any]:
    """The file as a DoclingDocument dict. `target` is pdf, docx or pptx; `legacy_ext` names a
    format LibreOffice converts to `target` first."""
    from docling.datamodel.base_models import ConversionStatus, DocumentStream

    if legacy_ext:
        data = convert_with_libreoffice(
            data, legacy_ext, target, soffice=options.soffice, timeout_s=options.timeout_s
        )
    stream = DocumentStream(name=f"document.{target}", stream=io.BytesIO(data))
    try:
        result = _converter(options).convert(stream, raises_on_error=False)
    except Exception as err:
        raise UnreadableFileError(f"Docling could not read it ({type(err).__name__})") from err
    if result.status not in {ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS}:
        messages = "; ".join(str(e.error_message) for e in result.errors)[:200]
        raise UnreadableFileError(f"Docling could not read it ({messages or result.status})")
    document: dict[str, Any] = result.document.export_to_dict()
    return document
