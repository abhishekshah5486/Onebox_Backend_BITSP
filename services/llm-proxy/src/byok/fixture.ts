// A slice of the models.dev catalogue, in its own shape.
export const catalogFixture = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    npm: '@ai-sdk/openai',
    env: ['OPENAI_API_KEY'],
    doc: 'https://platform.openai.com/docs/models',
    models: {
      'gpt-5': {
        id: 'gpt-5',
        name: 'GPT-5',
        reasoning: true,
        attachment: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 400000, output: 128000 },
        cost: { input: 1.25, output: 10 },
      },
      'text-embedding-3-small': {
        id: 'text-embedding-3-small',
        name: 'text-embedding-3-small',
        limit: { context: 8191, output: 1536 },
        cost: { input: 0.02 },
      },
      broken: { name: 'no id' },
    },
  },
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    npm: '@ai-sdk/amazon-bedrock',
    env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK'],
    models: {},
  },
  'fireworks-ai': {
    id: 'fireworks-ai',
    name: 'Fireworks AI',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.fireworks.ai/inference/v1/',
    env: ['FIREWORKS_API_KEY'],
    models: {},
  },
  lmstudio: {
    id: 'lmstudio',
    name: 'LMStudio',
    npm: '@ai-sdk/openai-compatible',
    api: 'http://127.0.0.1:1234/v1',
    env: ['LMSTUDIO_API_KEY'],
    models: {},
  },
  gitlab: {
    id: 'gitlab',
    name: 'GitLab',
    npm: 'gitlab-ai-provider',
    env: ['GITLAB_TOKEN'],
    models: {},
  },
};
