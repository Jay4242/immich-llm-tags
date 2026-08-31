# Immich LLM Tags

This standalone CLI downloads an Immich image's original file, sends it to an OpenAI-compatible vision endpoint, prompts for approval of missing tags, and adds the approved tags without removing existing tags.

The CLI is independent of the Immich source tree. It communicates with an existing Immich server through its HTTP API and can be cloned and run as its own project.

## API key

Create an Immich API key in **User Settings > API Keys** with these permissions:

- `asset.download`
- `tag.read`
- `tag.create`
- `tag.asset`

The key is only needed for Immich, not for an unauthenticated local LLM server.

## Configuration

```bash
export IMMICH_URL=http://localhost:2283
export IMMICH_API_KEY='your-immich-api-key'
export LLM_BASE_URL=http://localhost:11434/v1
export LLM_MODEL=llava
```

`LLM_BASE_URL` defaults to `http://localhost:11434/v1`, which is Ollama's default port. Set it to an LM Studio or llama.cpp OpenAI-compatible endpoint as needed. `LLM_API_KEY` is optional and is sent as a Bearer token when set.

## Build and run

From this project directory:

```bash
npm install
npm run build
npm start -- <asset-id>
```

The command currently processes one image at a time. It uses the original asset endpoint, so the Immich API key must have `asset.download` permission. Errors are printed by the CLI and do not modify Immich.

Node.js 20 or newer is required. The project has no runtime dependency on the Immich repository or its generated SDK.
