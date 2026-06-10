const assert = require('assert');
const test = require('node:test');

test('Auto-Vacate turnstile webhook', async (t) => {
  // Try checkout with invalid auth header
  const resBadAuth = await fetch('http://localhost:3000/api/turnstile/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-turnstile-key': 'wrongkey'
    },
    body: JSON.stringify({ member_id: 'MEM-001' })
  });
  assert.strictEqual(resBadAuth.status, 401);

  // Try checkout with valid auth
  const resValid = await fetch('http://localhost:3000/api/turnstile/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-turnstile-key': 'supersecretturnstilekey'
    },
    body: JSON.stringify({ member_id: 'MEM-001' })
  });
  assert.strictEqual(resValid.status, 200);
  const data = await resValid.json();
  assert.strictEqual(data.success, true);
});
