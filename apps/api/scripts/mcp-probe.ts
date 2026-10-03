// Protocol diagnostic client, not an AI agent. Token stays in memory and is never printed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
async function main() {
  if (!process.env.MCP_ACCESS_TOKEN)
    throw Error('Set MCP_ACCESS_TOKEN to a WorthPath personal access token');
  const client = new Client({ name: 'WorthPath MCP probe', version: '1.31.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(process.env.MCP_SERVER_URL || 'http://localhost:3100/mcp'),
        { requestInit: { headers: { Authorization: 'Bearer ' + process.env.MCP_ACCESS_TOKEN } } },
      ),
    );
    console.log(
      JSON.stringify(
        {
          server: client.getServerVersion(),
          tools: (await client.listTools()).tools.map((t) => ({
            name: t.name,
            annotations: t.annotations,
          })),
          connection: await client.callTool({ name: 'connection_info', arguments: {} }),
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
}
void main().catch(() => {
  console.error(
    'MCP probe failed: check server URL, token expiry, revocation and resource configuration.',
  );
  process.exitCode = 1;
});
