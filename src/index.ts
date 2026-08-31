#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

type Config = {
  immichUrl: string;
  immichApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string;
};

type ImmichTag = {
  id: string;
  name: string;
  value: string;
};

type ChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

const getRequiredEnvironment = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const getConfig = (): Config => ({
  immichUrl: (process.env.IMMICH_URL || 'http://localhost:2283').replace(/\/$/, ''),
  immichApiKey: getRequiredEnvironment('IMMICH_API_KEY'),
  llmBaseUrl: (process.env.LLM_BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, ''),
  llmModel: getRequiredEnvironment('LLM_MODEL'),
  llmApiKey: process.env.LLM_API_KEY?.trim() || undefined,
});

const getImmichApiUrl = (config: Config, path: string) =>
  `${config.immichUrl.endsWith('/api') ? config.immichUrl : `${config.immichUrl}/api`}${path}`;

const getJson = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body || 'empty response'}`);
  }

  return (await response.json()) as T;
};

const getImage = async (config: Config, assetId: string) => {
  const response = await fetch(getImmichApiUrl(config, `/assets/${assetId}/original`), {
    headers: { 'x-api-key': config.immichApiKey },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Unable to download asset: ${response.status} ${response.statusText}: ${body}`);
  }

  const contentType = response.headers.get('content-type')?.split(';', 1)[0] || 'application/octet-stream';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Asset is not an image (received ${contentType})`);
  }

  return {
    contentType,
    data: Buffer.from(await response.arrayBuffer()).toString('base64'),
  };
};

const getTags = (config: Config) =>
  getJson<ImmichTag[]>(getImmichApiUrl(config, '/tags'), {
    headers: { 'x-api-key': config.immichApiKey },
  });

const getCompletionContent = (completion: ChatCompletion) => {
  const content = completion.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => part.text || '').join('');
  }

  if (!content) {
    throw new Error('LLM response did not contain message content');
  }

  return content;
};

const parseTags = (content: string) => {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${content}`);
  }

  const tags = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && 'tags' in parsed
      ? (parsed as { tags: unknown }).tags
      : undefined;

  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new Error('LLM response must be a JSON array of strings or an object with a tags array');
  }

  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
};

const generateTags = async (config: Config, image: { contentType: string; data: string }) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.llmApiKey) {
    headers.authorization = `Bearer ${config.llmApiKey}`;
  }

  const completion = await getJson<ChatCompletion>(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.llmModel,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Return concise, useful tags describing this image. Reply only with a JSON array of strings, with no markdown or explanation.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${image.contentType};base64,${image.data}` },
            },
          ],
        },
      ],
    }),
  });

  return parseTags(getCompletionContent(completion));
};

const ask = async (question: string, readline: ReturnType<typeof createInterface>) => {
  const answer = (await readline.question(`${question} [y/N] `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
};

const main = async () => {
  const assetId = process.argv[2];
  if (!assetId || process.argv.length !== 3) {
    throw new Error('Usage: immich-llm-tags <asset-id>');
  }

  const config = getConfig();
  const readline = createInterface({ input, output });

  try {
    console.log(`Downloading original asset ${assetId}...`);
    const image = await getImage(config, assetId);

    console.log(`Generating tags with ${config.llmModel}...`);
    const suggestedTags = await generateTags(config, image);
    if (suggestedTags.length === 0) {
      console.log('The LLM returned no tags.');
      return;
    }

    const existingTags = await getTags(config);
    const existingNames = new Set(existingTags.map((tag) => tag.value));
    const missingTags = suggestedTags.filter((tag) => !existingNames.has(tag));
    const existingSuggestedTags = suggestedTags.filter((tag) => existingNames.has(tag));

    console.log(`Suggested tags: ${suggestedTags.join(', ')}`);
    if (existingSuggestedTags.length > 0) {
      console.log(`Already existing: ${existingSuggestedTags.join(', ')}`);
    }

    const tagIds = existingTags.filter((tag) => suggestedTags.includes(tag.value)).map((tag) => tag.id);
    for (const tagName of missingTags) {
      if (await ask(`Create missing tag "${tagName}"?`, readline)) {
        const created = await getJson<ImmichTag>(getImmichApiUrl(config, '/tags'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': config.immichApiKey },
          body: JSON.stringify({ name: tagName }),
        });
        tagIds.push(created.id);
      }
    }

    if (tagIds.length === 0) {
      console.log('No tags approved; the asset was not changed.');
      return;
    }

    await getJson(getImmichApiUrl(config, '/tags/assets'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-api-key': config.immichApiKey },
      body: JSON.stringify({ assetIds: [assetId], tagIds }),
    });
    console.log(`Applied ${tagIds.length} tag(s) to asset ${assetId}.`);
  } finally {
    readline.close();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
