const assert = require('assert');
const test = require('node:test');

test('Backup Member Portal, Geofence, and Override Token API Suite', async (t) => {
  // Setup: Ensure we have an active assignment for MEM-001
  // 1. Issue pass
  const resIssue = await fetch('http://localhost:3000/api/member/issue-pass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: 'MEM-001', lastName: 'Smith' })
  });
  assert.strictEqual(resIssue.status, 200);
  const dataIssue = await resIssue.json();
  const token = dataIssue.locker_token;
  assert.ok(token);
  assert.ok(dataIssue.walletUrl, 'Should return a walletUrl');

  // 2. Scan at terminal to allocate locker
  const resScan = await fetch('http://localhost:3000/api/terminal/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locker_token: token })
  });
  if (resScan.status !== 200) {
    console.error('Scan failed! Status:', resScan.status, 'Body:', await resScan.json());
  }
  assert.strictEqual(resScan.status, 200);
  const dataScan = await resScan.json();
  const lockerId = dataScan.locker_id;
  assert.ok(lockerId);

  // 3. Test portal login
  // Invalid login
  const resLoginBad = await fetch('http://localhost:3000/api/member/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: 'MEM-001', lastName: 'Wrong' })
  });
  assert.strictEqual(resLoginBad.status, 401);

  // Valid login
  const resLoginGood = await fetch('http://localhost:3000/api/member/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: 'MEM-001', lastName: 'Smith' })
  });
  assert.strictEqual(resLoginGood.status, 200);
  const dataLogin = await resLoginGood.json();
  assert.strictEqual(dataLogin.success, true);
  assert.strictEqual(dataLogin.lockerId, lockerId);
  assert.strictEqual(dataLogin.token, token);

  // 4. Test unlock with GPS inside gym (proximity check passed)
  const resUnlockInside = await fetch('http://localhost:3000/api/member/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lockerId, token, lat: 30.046123, lon: 31.483873 })
  });
  assert.strictEqual(resUnlockInside.status, 200);
  const dataInside = await resUnlockInside.json();
  assert.strictEqual(dataInside.success, true);

  // 5. Test unlock with GPS outside gym (proximity check blocked)
  const resUnlockOutside = await fetch('http://localhost:3000/api/member/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lockerId, token, lat: 40.0, lon: 50.0 })
  });
  assert.strictEqual(resUnlockOutside.status, 403);
  const dataOutside = await resUnlockOutside.json();
  assert.strictEqual(dataOutside.success, false);
  assert.match(dataOutside.message, /Access Denied/);

  // 6. Test unlock without GPS (requires override token)
  const resUnlockNoGPS = await fetch('http://localhost:3000/api/member/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lockerId, token })
  });
  assert.strictEqual(resUnlockNoGPS.status, 403);
  const dataNoGPS = await resUnlockNoGPS.json();
  assert.strictEqual(dataNoGPS.gpsError, true);

  // 7. Generate reception override token
  const resOverrideGen = await fetch('http://localhost:3000/api/reception/generate-override', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-reception-pin': '1234'
    },
    body: JSON.stringify({ lockerId })
  });
  assert.strictEqual(resOverrideGen.status, 200);
  const dataOverrideGen = await resOverrideGen.json();
  const overrideCode = dataOverrideGen.code;
  assert.match(overrideCode, /^\d{6}$/); // Assert 6-digit code

  // 8. Test unlock with override code
  const resUnlockOverride = await fetch('http://localhost:3000/api/member/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lockerId, token, overrideToken: overrideCode })
  });
  assert.strictEqual(resUnlockOverride.status, 200);
  const dataUnlockOverride = await resUnlockOverride.json();
  assert.strictEqual(dataUnlockOverride.success, true);

  // 9. Verify override token is single-use
  const resUnlockOverrideReuse = await fetch('http://localhost:3000/api/member/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lockerId, token, overrideToken: overrideCode })
  });
  assert.strictEqual(resUnlockOverrideReuse.status, 403);

  // 10. Test manual vacate
  const resVacate = await fetch('http://localhost:3000/api/terminal/vacate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locker_token: token })
  });
  assert.strictEqual(resVacate.status, 200);
  const dataVacate = await resVacate.json();
  assert.strictEqual(dataVacate.success, true);

  // 11. Verify member has no active assignments now
  const resLoginVacated = await fetch('http://localhost:3000/api/member/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: 'MEM-001', lastName: 'Smith' })
  });
  assert.strictEqual(resLoginVacated.status, 404);
});
