// Test-only SDK: no database, credentials, network or fallback to a live client.
let client: any;
export function setClient(value: any) { client = value; }
export function createClientFromRequest(_request: Request) {
  if (!client) throw new Error('Missing isolated test client');
  return client;
}
