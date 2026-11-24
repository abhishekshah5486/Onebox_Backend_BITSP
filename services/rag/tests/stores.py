"""MongoDB, Redis, SeaweedFS and Qdrant in containers, shared by the integration tests."""

import time
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass

import boto3
import httpx
from testcontainers.community.redis import RedisContainer
from testcontainers.core.container import DockerContainer
from testcontainers.mongodb import MongoDbContainer

S3_KEY, S3_SECRET = "testaccesskey", "testsecretkey"


@dataclass(frozen=True)
class Stores:
    mongo_uri: str
    redis_url: str
    blob_endpoint: str
    qdrant_url: str

    def settings(self) -> dict[str, str]:
        # Indexing also needs RAG_LLM_PROXY_URL, which only the indexing tests set.
        return {
            "MONGO_URI": self.mongo_uri,
            "REDIS_URL": self.redis_url,
            "BLOB_ENDPOINT": self.blob_endpoint,
            "QDRANT_URL": self.qdrant_url,
        }


def _wait_for_s3(endpoint: str, timeout_s: float = 120) -> None:
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=S3_KEY,
        aws_secret_access_key=S3_SECRET,
        region_name="us-east-1",
    )
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            s3.list_buckets()
            return
        except Exception:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.5)


def _wait_for_http(url: str, timeout_s: float = 60) -> None:
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            if httpx.get(url).status_code == 200:
                return
        except httpx.TransportError:
            pass
        if time.monotonic() > deadline:
            raise TimeoutError(url)
        time.sleep(0.5)


def _mapped_port(container: DockerContainer, port: int, timeout_s: float = 30) -> int:
    # Docker Desktop publishes the mapping a moment after the container starts.
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            return int(container.get_exposed_port(port))
        except ConnectionError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.2)


@contextmanager
def running_stores() -> Iterator[Stores]:
    with ExitStack() as stack:
        mongo = stack.enter_context(MongoDbContainer("mongo:8.0"))
        redis = stack.enter_context(RedisContainer("redis:8.10.2-alpine"))
        # The same SeaweedFS the dev stack and packages/testing run.
        seaweed = stack.enter_context(
            DockerContainer("chrislusf/seaweedfs:4.48")
            .with_env("AWS_ACCESS_KEY_ID", S3_KEY)
            .with_env("AWS_SECRET_ACCESS_KEY", S3_SECRET)
            .with_command("server -dir=/data -s3 -s3.port=8333 -ip.bind=0.0.0.0")
            .with_exposed_ports(8333)
        )
        blob_endpoint = f"http://{seaweed.get_container_host_ip()}:{_mapped_port(seaweed, 8333)}"
        _wait_for_s3(blob_endpoint)
        # The Qdrant version the dev stack runs.
        qdrant = stack.enter_context(
            DockerContainer("qdrant/qdrant:v1.19.2").with_exposed_ports(6333)
        )
        qdrant_url = f"http://{qdrant.get_container_host_ip()}:{_mapped_port(qdrant, 6333)}"
        _wait_for_http(f"{qdrant_url}/readyz")
        yield Stores(
            mongo_uri=mongo.get_connection_url(),
            redis_url=f"redis://{redis.get_container_host_ip()}:{redis.get_exposed_port(6379)}",
            blob_endpoint=blob_endpoint,
            qdrant_url=qdrant_url,
        )
