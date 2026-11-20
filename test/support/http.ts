import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: unknown;
}

/** A raw HTTP request (node:http allows any Host header, unlike fetch). */
export function rawRequest(
  url: string,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<RawResponse> {
  const { hostname, port } = new URL(url);

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname,
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: { Host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text === '' ? null : JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** POST with Content-Type application/json. */
export function postJson(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return rawRequest(url, {
    method: 'POST',
    path,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
