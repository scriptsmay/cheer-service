'use strict';

// Set env vars before requiring modules
process.env.JWT_SECRET = 'test_secret';
process.env.APP_USERS = '[]';
process.env.ALLOWED_ORIGINS = '';
process.env.BLOCKED_TERMS = '赌博,色情';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { resolveIdentity } = require('../src/services/identity');
const authMiddleware = require('../src/middleware/auth');

const SECRET = 'test_secret';

function mockReq({ authorization = '', query = {}, body = {} } = {}) {
  return { headers: authorization ? { authorization } : {}, query, body };
}

function signedToken(payload, options = {}) {
  return jwt.sign(payload, SECRET, options);
}

// ── resolveIdentity：Bearer 收紧（2026-09-21 拍板）──
// 携带 Bearer 但校验失败 → ok:false 拒绝；只有未携带 Bearer 才回退匿名。
// 背景：Bearer [object Promise] 曾被静默降级为匿名身份，造成打卡数据归属错位。
describe('resolveIdentity — invalid bearer 拒绝而非降级匿名', () => {
  test('valid session token resolves to session identity', async () => {
    const token = signedToken({ sub: 'user:u1', username: 'u1' });
    const identity = await resolveIdentity(mockReq({ authorization: `Bearer ${token}` }));
    assert.equal(identity.ok, true);
    assert.equal(identity.kind, 'session');
    assert.equal(identity.subjectId, 'user:u1');
    assert.equal(identity.username, 'u1');
  });

  test('malformed bearer (object promise string) returns ok:false', async () => {
    const identity = await resolveIdentity(mockReq({ authorization: 'Bearer [object Promise]' }));
    assert.equal(identity.ok, false);
    assert.equal(identity.kind, 'invalid_bearer');
  });

  test('garbage bearer returns ok:false', async () => {
    const identity = await resolveIdentity(mockReq({ authorization: 'Bearer not.a.valid.token' }));
    assert.equal(identity.ok, false);
    assert.equal(identity.kind, 'invalid_bearer');
  });

  test('expired bearer returns ok:false', async () => {
    const token = signedToken({ sub: 'user:u1' }, { expiresIn: '-10s' });
    const identity = await resolveIdentity(mockReq({ authorization: `Bearer ${token}` }));
    assert.equal(identity.ok, false);
    assert.equal(identity.kind, 'invalid_bearer');
  });

  test('signed token without sub returns ok:false', async () => {
    const token = signedToken({ username: 'u1' });
    const identity = await resolveIdentity(mockReq({ authorization: `Bearer ${token}` }));
    assert.equal(identity.ok, false);
    assert.equal(identity.kind, 'invalid_bearer');
  });

  test('wrong-secret bearer returns ok:false', async () => {
    const token = jwt.sign({ sub: 'user:u1' }, 'other_secret');
    const identity = await resolveIdentity(mockReq({ authorization: `Bearer ${token}` }));
    assert.equal(identity.ok, false);
    assert.equal(identity.kind, 'invalid_bearer');
  });

  test('no bearer header falls back to anonymous identity', async () => {
    const identity = await resolveIdentity(mockReq({ body: { client_id: 'cid-12345678' } }));
    assert.equal(identity.ok, true);
    assert.equal(identity.kind, 'anonymous');
    assert.match(identity.subjectId, /^anon:/u);
  });

  test('empty bearer falls back to anonymous identity', async () => {
    const identity = await resolveIdentity(mockReq({ authorization: 'Bearer ' }));
    assert.equal(identity.ok, true);
    assert.equal(identity.kind, 'anonymous');
  });
});

// ── authMiddleware：同步收紧，保持「不拦截、路由自行判断」设计 ──
describe('authMiddleware — invalid bearer 挂 ok:false 交由路由拒绝', () => {
  function run(req) {
    return new Promise((resolve) => {
      authMiddleware(req, {}, resolve);
    });
  }

  test('valid bearer attaches session identity', async () => {
    const req = mockReq({ authorization: `Bearer ${signedToken({ sub: 'user:u1' })}` });
    await run(req);
    assert.equal(req.identity.ok, true);
    assert.equal(req.identity.kind, 'session');
    assert.equal(req.identity.subjectId, 'user:u1');
  });

  test('invalid bearer marks identity not ok (admin 守卫等据此拒绝)', async () => {
    const req = mockReq({ authorization: 'Bearer garbage.token.here' });
    await run(req);
    assert.equal(req.identity.ok, false);
    assert.equal(req.identity.kind, 'invalid_bearer');
  });

  test('expired bearer marks identity not ok', async () => {
    const req = mockReq({ authorization: `Bearer ${signedToken({ sub: 'user:u1' }, { expiresIn: '-10s' })}` });
    await run(req);
    assert.equal(req.identity.ok, false);
    assert.equal(req.identity.kind, 'invalid_bearer');
  });

  test('no bearer attaches anonymous identity', async () => {
    const req = mockReq({ body: { client_id: 'cid-12345678' } });
    await run(req);
    assert.equal(req.identity.ok, true);
    assert.equal(req.identity.kind, 'anonymous');
  });
});
