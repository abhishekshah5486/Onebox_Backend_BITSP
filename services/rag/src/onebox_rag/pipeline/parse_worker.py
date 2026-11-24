"""A parse worker process: ``python -m onebox_rag.pipeline.parse_worker <request fd> <reply fd>``.

It has a main module of its own so a worker imports only what the jobs it
is sent need, never the service. Each message is an 8-byte length then a pickle; a request is
(function, args) and a reply is (ok, result or exception, traceback). Keep imports stdlib-only.
"""

import contextlib
import ctypes
import os
import pickle
import signal
import struct
import sys
import threading
import time
import traceback
from typing import Any, BinaryIO

try:
    import resource
except ImportError:  # not POSIX
    resource = None  # type: ignore[assignment]

_LENGTH = struct.Struct("!Q")
_PARENT_POLL_S = 2.0
# Set by the pool: the most memory a worker may map, in MB (Linux enforces it).
MEMORY_ENV = "ONEBOX_RAG_PARSE_MEMORY_MB"


def write_frame(stream: BinaryIO, obj: object) -> None:
    payload = pickle.dumps(obj, protocol=pickle.HIGHEST_PROTOCOL)
    stream.write(_LENGTH.pack(len(payload)))
    stream.write(payload)
    stream.flush()


def _read_exactly(stream: BinaryIO, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            raise EOFError("the other end of the parse pipe closed")
        data += chunk
    return bytes(data)


def read_frame(stream: BinaryIO) -> Any:
    (size,) = _LENGTH.unpack(_read_exactly(stream, _LENGTH.size))
    return pickle.loads(_read_exactly(stream, size))  # noqa: S301 - our own process, our own pipe


def _portable(exc: BaseException) -> BaseException:
    """The exception, or a stand-in when it would not survive the trip to the parent."""
    try:
        pickle.loads(pickle.dumps(exc))  # noqa: S301
    except Exception:
        return RuntimeError(f"{type(exc).__name__}: {exc}")
    return exc


def _harden() -> None:
    # Out of memory, the kernel should kill this worker (one file fails), not the service.
    with contextlib.suppress(OSError):
        with open("/proc/self/oom_score_adj", "w") as adj:
            adj.write("1000")
    if sys.platform == "linux":
        # Not dumpable: another same-user process can't read this one's environment or memory.
        with contextlib.suppress(OSError, AttributeError):
            ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE
    if resource is not None:
        with contextlib.suppress(ValueError, OSError):
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        memory_mb = int(os.environ.get(MEMORY_ENV, "0") or 0)
        if memory_mb > 0 and sys.platform == "linux":
            limit = memory_mb * 2**20
            with contextlib.suppress(ValueError, OSError):
                resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    # Ctrl-C reaches the whole terminal group; the pool decides when a worker stops.
    signal.signal(signal.SIGINT, signal.SIG_IGN)


def _exit_with_parent(parent_pid: int) -> None:
    """A worker mid-parse never reads its pipe, so it watches for its service going away."""
    while os.getppid() == parent_pid:
        time.sleep(_PARENT_POLL_S)
    # Started in a session of its own: take any processes a parse started along with it.
    if os.getpgrp() == os.getpid():
        with contextlib.suppress(OSError):
            os.killpg(os.getpid(), signal.SIGKILL)
    os._exit(0)


def main(request_fd: int, reply_fd: int) -> None:
    _harden()
    threading.Thread(
        target=_exit_with_parent, args=(os.getppid(),), name="exit-with-parent", daemon=True
    ).start()
    requests = os.fdopen(request_fd, "rb")
    replies = os.fdopen(reply_fd, "wb")
    while True:
        try:
            request = read_frame(requests)
        except EOFError:
            return
        except Exception as exc:
            # A request that won't unpickle is answered, so the stream stays in step.
            write_frame(replies, (False, _portable(exc), traceback.format_exc()))
            continue
        try:
            fn, args = request
            reply: tuple[bool, Any, str] = (True, fn(*args), "")
        except MemoryError:
            reply = (False, MemoryError("ran out of memory"), "")
        except Exception as exc:
            reply = (False, _portable(exc), traceback.format_exc())
        write_frame(replies, reply)


if __name__ == "__main__":
    main(int(sys.argv[1]), int(sys.argv[2]))
