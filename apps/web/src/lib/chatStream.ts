import { chatEventSchema, type ChatEvent, type ChatRequest } from '@argus/shared';
import { ApiError } from './api';

/**
 * Reads the `POST /api/chat` Server-Sent Events stream and yields validated
 * ChatEvents (spec .agents/specs/chat.md). Each event is one `data: {json}` frame
 * separated by a blank line; a frame that fails the shared schema is dropped rather
 * than trusted (rule 5). The caller renders text/chips/refs as they arrive.
 */
export async function* streamChat(body: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
  } catch {
    throw new ApiError(0, 'could not reach the Argus server');
  }
  if (!res.ok || !res.body) {
    let message = `chat request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) message = j.error;
    } catch {
      /* keep the default */
    }
    throw new ApiError(res.status, message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(dataLine.indexOf(':') + 1).trim();
      if (!payload) continue;
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const parsed = chatEventSchema.safeParse(json);
      if (parsed.success) yield parsed.data;
    }
  }
}
