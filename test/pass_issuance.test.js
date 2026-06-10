const assert = require('assert');
const test = require('node:test');

test('Pass Issuance APIs', async (t) => {
  // Test invalid credentials
  const resInvalid = await fetch('http://localhost:3000/api/member/issue-pass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: 'MEM-999', lastName: 'Wrong' })
  });
  assert.strictEqual(resInvalid.status, 401);

  // Test valid credentials
  const resValid = await fetch('http://localhost:3000/api/member/issue-pass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: 'MEM-001', lastName: 'Smith' })
  });
  assert.strictEqual(resValid.status, 200);
  const data = await resValid.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.locker_token, 'Should return a locker_token');
  assert.ok(data.walletUrl, 'Should return a walletUrl');
});
