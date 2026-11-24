import asyncio
import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from onebox_rag.parsers.base import UnreadableFileError
from onebox_rag.pipeline.pool import ParsePool, ParseWorkerError
from tests import pool_jobs


@pytest.fixture
def pool() -> Iterator[ParsePool]:
    pool = ParsePool(1, timeout_s=30)
    yield pool
    pool.close()


def gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    # A zombie still answers kill(0); it has stopped running all the same.
    return (
        Path(f"/proc/{pid}/status").exists() and "zombie" in Path(f"/proc/{pid}/status").read_text()
    )


async def test_runs_jobs_in_a_separate_process(pool: ParsePool) -> None:
    assert await pool.run(pool_jobs.double, 21) == 42
    assert await pool.run(pool_jobs.pid) != os.getpid()


async def test_parser_errors_come_back_as_they_were_raised(pool: ParsePool) -> None:
    with pytest.raises(UnreadableFileError, match="not really a PDF"):
        await pool.run(pool_jobs.unreadable)
    assert await pool.run(pool_jobs.double, 1) == 2


async def test_a_job_past_its_time_is_killed_with_everything_it_started(
    pool: ParsePool, tmp_path: Path
) -> None:
    pid_file = tmp_path / "child.pid"
    before = await pool.run(pool_jobs.pid)
    with pytest.raises(ParseWorkerError) as caught:
        await pool.run(pool_jobs.hang_with_child, str(pid_file), timeout_s=1)
    assert caught.value.cause == "timed_out"
    child = int(pid_file.read_text())
    for _ in range(50):
        if gone(child):
            break
        await asyncio.sleep(0.1)
    assert gone(child), "the job's own child process outlived the timeout"
    assert await pool.run(pool_jobs.pid) != before


@pytest.mark.parametrize(
    ("job", "cause"), [(pool_jobs.killed, "killed"), (pool_jobs.crash, "crashed")]
)
async def test_a_dead_worker_fails_only_its_job(pool: ParsePool, job: object, cause: str) -> None:
    with pytest.raises(ParseWorkerError) as caught:
        await pool.run(job)  # type: ignore[arg-type]
    assert caught.value.cause == cause
    assert await pool.run(pool_jobs.double, 2) == 4
