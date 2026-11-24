"""Jobs the pool tests send to worker processes (importable there, so kept light)."""

import os
import signal
import subprocess
import time

from onebox_rag.parsers.base import UnreadableFileError


def double(n: int) -> int:
    return n * 2


def pid() -> int:
    return os.getpid()


def unreadable() -> None:
    raise UnreadableFileError("not really a PDF")


def hang_with_child(pid_file: str) -> None:
    child = subprocess.Popen(["sleep", "60"])  # noqa: S607 - test helper
    with open(pid_file, "w") as out:
        out.write(str(child.pid))
    time.sleep(60)


def killed() -> None:
    os.kill(os.getpid(), signal.SIGKILL)


def crash() -> None:
    os._exit(3)
