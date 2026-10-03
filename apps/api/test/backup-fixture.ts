import { archiveBackup } from '../src/zip';
// Test-only aliases build ZIP fixtures and exercise the public upload/confirmation flow.
export async function fixtureFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!url.endsWith('/backup/restore-fixture') && !url.endsWith('/backup/preview-fixture'))
    return fetch(url, init);
  const restore = url.endsWith('/backup/restore-fixture');
  const input = JSON.parse(String(init?.body));
  const chunks: Buffer[] = [];
  const archive = archiveBackup(restore ? input.backup : input);
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });
  await archive.finalize();
  const form = new FormData();
  form.set(
    'file',
    new Blob([new Uint8Array(await completed)], { type: 'application/zip' }),
    'fixture.zip',
  );
  const headers = new Headers(init?.headers);
  headers.delete('Content-Type');
  const base = url.slice(0, url.lastIndexOf('/backup/'));
  const uploaded = await fetch(base + '/backup/upload', { method: 'POST', headers, body: form });
  if (!uploaded.ok || !restore) return uploaded;
  const preview = await uploaded.json();
  headers.set('Content-Type', 'application/json');
  return fetch(base + '/backup/import-file', {
    method: 'POST',
    headers,
    body: JSON.stringify({ token: preview.token, confirmed: input.confirmed }),
  });
}
