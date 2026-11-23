"""Legacy Office and OpenDocument files to OOXML with headless LibreOffice (as PipesHub does)."""

import contextlib
import os
import signal
import subprocess
import tempfile
from pathlib import Path

from onebox_rag.parsers.base import UnreadableFileError


def convert_with_libreoffice(
    data: bytes, input_ext: str, output_ext: str, *, soffice: str, timeout_s: float
) -> bytes:
    with tempfile.TemporaryDirectory(prefix="onebox-lo-") as tmp:
        work = Path(tmp)
        source = work / f"input.{input_ext}"
        source.write_bytes(data)
        # A profile of its own: concurrent conversions never share or lock one.
        profile = (work / "profile").as_uri()
        process = subprocess.Popen(  # noqa: S603 - fixed arguments, our own temp files
            [
                soffice,
                f"-env:UserInstallation={profile}",
                "--headless",
                "--norestore",
                "--nolockcheck",
                "--convert-to",
                output_ext,
                "--outdir",
                str(work / "out"),
                str(source),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # soffice forks soffice.bin; its own group lets a timeout take both down.
            start_new_session=True,
        )
        try:
            _, stderr = process.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            raise UnreadableFileError(f"LibreOffice took longer than {timeout_s:.0f}s") from None
        finally:
            # Also after a clean exit: soffice can leave a helper behind in its group.
            with contextlib.suppress(OSError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        converted = work / "out" / f"input.{output_ext}"
        if process.returncode != 0 or not converted.exists():
            detail = stderr.decode(errors="replace").strip()[:200]
            raise UnreadableFileError(f"LibreOffice could not read this .{input_ext} ({detail})")
        return converted.read_bytes()
