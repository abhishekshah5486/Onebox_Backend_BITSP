import asyncio
from typing import BinaryIO

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from mypy_boto3_s3 import S3Client

from onebox_rag.config import Settings


class BlobStore:
    """Originals in the S3-compatible store; boto3 is blocking, so calls run in threads."""

    def __init__(self, settings: Settings) -> None:
        self.bucket = settings.RAG_BLOB_BUCKET
        self._s3: S3Client = boto3.client(
            "s3",
            endpoint_url=settings.BLOB_ENDPOINT,
            region_name=settings.BLOB_REGION,
            aws_access_key_id=settings.BLOB_ACCESS_KEY,
            aws_secret_access_key=settings.BLOB_SECRET_KEY,
            # Local stores serve buckets by path, not by subdomain.
            config=Config(s3={"addressing_style": "path"}, retries={"mode": "standard"}),
        )

    async def ensure_bucket(self) -> None:
        def ensure() -> None:
            try:
                self._s3.head_bucket(Bucket=self.bucket)
            except ClientError as err:
                if err.response.get("Error", {}).get("Code") not in {"404", "NoSuchBucket"}:
                    raise
                self._s3.create_bucket(Bucket=self.bucket)

        await asyncio.to_thread(ensure)

    async def ping(self) -> None:
        await asyncio.to_thread(self._s3.head_bucket, Bucket=self.bucket)

    async def put(self, key: str, body: BinaryIO, content_type: str) -> None:
        body.seek(0)
        await asyncio.to_thread(
            self._s3.upload_fileobj, body, self.bucket, key, ExtraArgs={"ContentType": content_type}
        )

    async def put_bytes(self, key: str, body: bytes, content_type: str) -> None:
        await asyncio.to_thread(
            self._s3.put_object, Bucket=self.bucket, Key=key, Body=body, ContentType=content_type
        )

    async def get(self, key: str) -> bytes:
        def read() -> bytes:
            return self._s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()

        return await asyncio.to_thread(read)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._s3.delete_object, Bucket=self.bucket, Key=key)
