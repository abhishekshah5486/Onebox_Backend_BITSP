from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    # camelCase in MongoDB, stored blobs and JSON, like the TypeScript services' documents.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
