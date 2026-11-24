import certifi
import pytest

from onebox_rag.mongo import mongo_client, uses_tls


@pytest.mark.parametrize(
    ("uri", "tls"),
    [
        ("mongodb+srv://u:p@cluster.example.net/?retryWrites=true", True),
        ("mongodb+srv://cluster.example.net/?tls=false", False),
        ("mongodb://localhost:27017", False),
        ("mongodb://db:27017/?ssl=true", True),
        ("mongodb://db:27017/?TLS=True", True),
    ],
)
def test_knows_when_a_connection_uses_tls(uri: str, tls: bool) -> None:
    assert uses_tls(uri) is tls


async def test_trusts_certifi_only_for_tls_connections() -> None:
    secure = mongo_client("mongodb://db:27017/?tls=true", connect=False)
    plain = mongo_client("mongodb://db:27017", connect=False)
    try:
        assert secure.options.pool_options._ssl_context is not None
        assert plain.options.pool_options._ssl_context is None
        assert certifi.where().endswith(".pem")
    finally:
        await secure.close()
        await plain.close()
