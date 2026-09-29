import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

/** Loopback-only Responses fixture. Never stores request headers or uses real credentials. */
export async function projectlessProvider({
  respond = () => ({ text: 'NP0_FIXTURE_OK' }),
  maxRequests = 30,
} = {}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 256)
    throw new Error('Invalid fixture request limit');
  const requests = [];
  const errors = [];
  let unexpectedRequests = 0;
  const server = createServer((request, response) => {
    const receive = async () => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        unexpectedRequests++;
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('Fixture request too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (requests.length >= maxRequests) throw new Error('Fixture request limit exceeded');
      requests.push(body);
      const id = `resp_${randomUUID()}`;
      const reply = respond(body, requests.length - 1);
      const item = reply.item ?? {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: reply.text, annotations: [] }],
      };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let sequence = 0;
      const event = (type, value) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`,
        );
      event('response.created', { response: { id, status: 'in_progress', output: [] } });
      event('response.output_item.added', {
        output_index: 0,
        item: {
          ...item,
          status: 'in_progress',
          ...(item.type === 'message' ? { content: [] } : {}),
        },
      });
      if (item.type === 'message') {
        event('response.content_part.added', {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        event('response.output_text.delta', {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: reply.text,
        });
        event('response.output_text.done', {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: reply.text,
        });
        event('response.content_part.done', {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: item.content[0],
        });
      }
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', {
        response: {
          id,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      response.end();
    };
    receive().catch((error) => {
      // Do not echo malformed body text or errors containing request payloads.
      errors.push(error instanceof SyntaxError ? 'Invalid JSON' : 'Fixture request failed');
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  let closing;
  const close = async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  };
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    errors,
    get unexpectedRequests() {
      return unexpectedRequests;
    },
    close: () => (closing ??= close()),
  };
}
