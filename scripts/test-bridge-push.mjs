// Verifies pushBridgeNotify against a stub bridge server (no DSH needed).
// Usage: node scripts/test-bridge-push.mjs  (after npm run build:host)
import { createServer } from 'node:http';
import { bridgeForwardEnabled, pushBridgeNotify } from '../lib/index.js';

const requests = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    requests.push({
      url: req.url,
      method: req.method,
      auth: req.headers['authorization'],
      body: JSON.parse(body),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, delivered: 1 }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let failed = false;
const check = (condition, message) => {
  if (condition) console.log('PASS', message);
  else {
    failed = true;
    console.error('FAIL', message);
  }
};

// 1. done → forwarded with bearer token + sessionId
let ok = await pushBridgeNotify(base, 'tok-123', { kind: 'done', title: 't', message: 'm', sessionId: 'sess-1' });
check(ok === true, 'done push returns true');
check(requests.length === 1, 'one request made');
check(requests[0].url === '/api/notify.push' && requests[0].method === 'POST', 'POST /api/notify.push');
check(requests[0].auth === 'Bearer tok-123', 'bearer token header');
check(requests[0].body.kind === 'done' && requests[0].body.sessionId === 'sess-1', 'payload carries kind + sessionId');

// 2. question → forwarded
ok = await pushBridgeNotify(base, 'tok-123', { kind: 'question', title: 't', message: 'm' });
check(ok === true && requests.length === 2 && requests[1].body.kind === 'question', 'question push forwarded');

// 3. approval → NOT forwarded (only done/question per requirement)
requests.length = 0;
ok = await pushBridgeNotify(base, 'tok-123', { kind: 'approval', title: 't', message: 'm' });
check(ok === false && requests.length === 0, 'approval not forwarded');

// 4. empty bridgeUrl / token → no request
requests.length = 0;
ok = await pushBridgeNotify('', 'tok', { kind: 'done', title: 't', message: 'm' });
check(ok === false && requests.length === 0, 'empty bridgeUrl skips');
ok = await pushBridgeNotify(base, '', { kind: 'done', title: 't', message: 'm' });
check(ok === false && requests.length === 0, 'empty token skips');

// 5. unreachable bridge → returns false without throwing
try {
  ok = await pushBridgeNotify('http://127.0.0.1:1', 'tok', { kind: 'done', title: 't', message: 'm' });
  check(ok === false, 'unreachable bridge returns false');
} catch (error) {
  check(false, `unreachable bridge must not throw: ${error.message}`);
}

server.close();

// 6. bridgeForwardEnabled: 总开关 + 按类型开关
const allOn = { bridgePush: true, bridgePushKinds: { done: true, question: true } };
check(bridgeForwardEnabled(allOn, 'done') === true, 'done forwarded when all switches on');
check(bridgeForwardEnabled(allOn, 'question') === true, 'question forwarded when all switches on');
check(bridgeForwardEnabled(allOn, 'approval') === false, 'approval never forwarded');
check(bridgeForwardEnabled({ ...allOn, bridgePush: false }, 'done') === false, 'master switch off blocks done');
check(bridgeForwardEnabled({ ...allOn, bridgePushKinds: { done: false, question: true } }, 'done') === false, 'kind switch off blocks done');
check(bridgeForwardEnabled({ ...allOn, bridgePushKinds: { done: true, question: false } }, 'question') === false, 'kind switch off blocks question');

console.log(failed ? 'bridge push tests FAILED' : 'bridge push tests passed');
process.exit(failed ? 1 : 0);
