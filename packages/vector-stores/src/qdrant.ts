import { QdrantClient } from '@qdrant/js-client-rest';

// Search keeps its own Qdrant index (with native filters); this is only for checking keys.
export function qdrantCheck(settings: Record<string, string>) {
  const client = new QdrantClient({
    url: settings.url ?? '',
    ...(settings.apiKey && { apiKey: settings.apiKey }),
    checkCompatibility: false,
  });
  return {
    check: async () => {
      await client.getCollections();
    },
    close: async () => {},
  };
}
