const assert = require('assert');
const test = require('node:test');

test('Locker Room Terminal Endpoint', async (t) => {
  // Test invalid scanner token format
  const resInvalid = await fetch('http://localhost:3000/api/terminal/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locker_token: 'not-a-uuid' })
  });
  assert.strictEqual(resInvalid.status, 404);

  // Assert API accepts valid format token (returns 404 since it does not exist in db)
  const resValidNotFound = await fetch('http://localhost:3000/api/terminal/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locker_token: '00000000-0000-0000-0000-000000000000' })
  });
  assert.strictEqual(resValidNotFound.status, 404);
});
