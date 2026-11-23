"""Worker processes for parsing, so a hostile or huge file can only take down its own worker.

After PipesHub's parse pool: a few *lanes*, each one thread and the one worker process it talks
to, running one job at a time. A worker that dies is therefore always the fault of the job it
was running: that job fails and the lane starts a fresh worker for the next. A job that runs
past its timeout has its worker's whole process group killed.
"""

import asyncio
import contextlib
import logging
import os
import queue
import selectors
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Any, Literal, TypeVar

from onebox_rag.pipeline import parse_worker

logger = logging.getLogger("onebox_rag.pool")
T = TypeVar("T")
_POLL_S = 0.25

Cause = Literal["timed_out", "killed", "crashed", "unavailable"]


class ParseWorkerError(Exception):
    """The worker, not the parser, failed: it ran too long, was killed, or crashed."""

    def __init__(self, cause: Cause, message: str) -> None:
        super().__init__(message)
        self.cause = cause


@dataclass
class _Job:
    fn: Callable[..., Any]
    args: tuple[Any, ...]
    label: str
    timeout_s: float
    future: Future[Any] = field(default_factory=Future)


class _Worker:
    """One worker process and the two pipes to it."""

    def __init__(self, memory_mb: int) -> None:
        request_r, request_w = os.pipe()
        reply_r, reply_w = os.pipe()
        env = {**os.environ, parse_worker.MEMORY_ENV: str(memory_mb)}
        try:
            self.process = subprocess.Popen(  # noqa: S603 - our own interpreter and module
                [sys.executable, "-m", parse_worker.__name__, str(request_r), str(reply_w)],
                pass_fds=(request_r, reply_w),
                stdin=subprocess.DEVNULL,
                env=env,
                # Its own group, so stop() also kills anything a parse started.
                start_new_session=True,
            )
        except OSError:
            for fd in (request_r, request_w, reply_r, reply_w):
                os.close(fd)
            raise
        os.close(request_r)
        os.close(reply_w)
        self._requests = os.fdopen(request_w, "wb")
        self._replies = os.fdopen(reply_r, "rb", buffering=0)
        self._selector = selectors.DefaultSelector()
        self._selector.register(self._replies, selectors.EVENT_READ)
        self.jobs_run = 0

    def send(self, obj: object) -> None:
        parse_worker.write_frame(self._requests, obj)

    def reply_ready(self, timeout_s: float) -> bool:
        """True once a reply, or the end of a dead worker's pipe, can be read."""
        return bool(self._selector.select(timeout_s))

    def receive(self) -> Any:
        return parse_worker.read_frame(self._replies)

    def alive(self) -> bool:
        return self.process.poll() is None

    def stop(self) -> None:
        with contextlib.suppress(OSError):
            os.killpg(self.process.pid, signal.SIGKILL)
        with contextlib.suppress(OSError):
            self.process.kill()
        self._selector.close()
        for stream in (self._requests, self._replies):
            with contextlib.suppress(OSError):
                stream.close()
        with contextlib.suppress(subprocess.TimeoutExpired):
            self.process.wait(timeout=5)


class ParsePool:
    def __init__(
        self, workers: int, *, timeout_s: float, memory_mb: int = 0, max_jobs_per_worker: int = 0
    ) -> None:
        self.timeout_s = timeout_s
        self._memory_mb = memory_mb
        # Replacing a worker now and then hands back memory a parser fragmented.
        self._max_jobs = max_jobs_per_worker
        self._jobs: queue.Queue[_Job | None] = queue.Queue()
        self._closed = threading.Event()
        self._threads = [
            threading.Thread(target=self._serve, name=f"parse-lane-{i}", daemon=True)
            for i in range(max(1, workers))
        ]
        for thread in self._threads:
            thread.start()

    async def run(
        self, fn: Callable[..., T], *args: Any, label: str = "", timeout_s: float | None = None
    ) -> T:
        """fn(*args) in a worker. Raises what fn raised, or ParseWorkerError."""
        if self._closed.is_set():
            raise ParseWorkerError("unavailable", "the parse pool is shut down")
        job = _Job(fn, args, label, timeout_s or self.timeout_s)
        self._jobs.put(job)
        return await asyncio.wrap_future(job.future)

    def close(self) -> None:
        self._closed.set()
        for _ in self._threads:
            self._jobs.put(None)
        for thread in self._threads:
            thread.join(timeout=10)

    def _serve(self) -> None:
        worker: _Worker | None = None
        try:
            while (job := self._jobs.get()) is not None:
                if not job.future.set_running_or_notify_cancel():
                    continue
                try:
                    if worker is None or not worker.alive():
                        worker = _Worker(self._memory_mb)
                    result = self._run(worker, job)
                    job.future.set_result(result)
                    worker.jobs_run += 1
                    if self._max_jobs and worker.jobs_run >= self._max_jobs:
                        worker.stop()
                        worker = None
                except _Replace as replace:
                    if worker is not None:
                        worker.stop()
                    worker = None
                    job.future.set_exception(replace.error)
                except OSError as err:
                    job.future.set_exception(ParseWorkerError("unavailable", str(err)))
                except BaseException as err:
                    job.future.set_exception(err)
        finally:
            if worker is not None:
                worker.stop()

    def _run(self, worker: _Worker, job: _Job) -> Any:
        try:
            worker.send((job.fn, job.args))
        except OSError as err:
            raise _Replace(self._died(worker, job)) from err
        deadline = time.monotonic() + job.timeout_s
        while not worker.reply_ready(_POLL_S):
            if self._closed.is_set():
                raise _Replace(ParseWorkerError("unavailable", "the parse pool shut down"))
            if time.monotonic() >= deadline:
                logger.warning(
                    "parse timed out; worker replaced",
                    extra={"label": job.label, "timeoutS": job.timeout_s},
                )
                raise _Replace(
                    ParseWorkerError("timed_out", f"took longer than {job.timeout_s:.0f}s to parse")
                )
        try:
            ok, payload, remote_traceback = worker.receive()
        except (EOFError, OSError) as err:
            raise _Replace(self._died(worker, job)) from err
        if ok:
            return payload
        if remote_traceback:
            payload.add_note(f"Raised in a parse worker:\n{remote_traceback}")
        raise payload

    @staticmethod
    def _died(worker: _Worker, job: _Job) -> ParseWorkerError:
        # Read the exit status before stop(), whose own kill would look like one from outside.
        status = None
        with contextlib.suppress(subprocess.TimeoutExpired):
            status = worker.process.wait(timeout=1)
        if status == -signal.SIGKILL:
            # The kernel's out-of-memory killer (or a cgroup limit) ends a worker with SIGKILL.
            logger.warning(
                "parse worker killed, most likely out of memory", extra={"label": job.label}
            )
            return ParseWorkerError("killed", "the parser ran out of memory")
        logger.warning("parse worker crashed", extra={"label": job.label, "status": status})
        return ParseWorkerError("crashed", f"the parser crashed (exit status {status})")


class _Replace(Exception):
    """The lane's worker must be replaced; carries the error the job fails with."""

    def __init__(self, error: ParseWorkerError) -> None:
        super().__init__(str(error))
        self.error = error


def default_workers() -> int:
    # As PipesHub sizes it: half the CPUs, at most four.
    return max(1, min(4, (os.cpu_count() or 2) // 2))
