import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createSelfSignedCert, loadOrCreateIdentity } from '../src/identity.js';
import { sha256hex } from '../src/util.js';

test('generated certificate parses and is self-signed', () => {
  const { cert } = createSelfSignedCert('beam');
  const x = new X509Certificate(cert);
  assert.equal(x.subject, 'CN=beam');
  assert.equal(x.subject, x.issuer);
  assert.ok(x.verify(x.publicKey), 'signature must verify against own public key');
  assert.ok(new Date(x.validTo) > new Date(Date.now() + 3000 * 24 * 3600 * 1000));
});

test('identity persists across loads, and differs between config dirs', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-id-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-id-'));
  const i1 = loadOrCreateIdentity(a);
  const i2 = loadOrCreateIdentity(a);
  const i3 = loadOrCreateIdentity(b);
  assert.equal(i1.fingerprint, i2.fingerprint);
  assert.notEqual(i1.fingerprint, i3.fingerprint);
  assert.match(i1.fingerprint, /^[0-9a-f]{64}$/);
});

test('mutual TLS 1.3 handshake works and both sides see the other fingerprint', async () => {
  const server = loadOrCreateIdentity(fs.mkdtempSync(path.join(os.tmpdir(), 'beam-id-')));
  const client = loadOrCreateIdentity(fs.mkdtempSync(path.join(os.tmpdir(), 'beam-id-')));
  let gotServerSide;
  const serverSide = new Promise((r) => (gotServerSide = r));
  const srv = tls.createServer(
    { key: server.key, cert: server.cert, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' },
    (s) => {
      gotServerSide(sha256hex(s.getPeerCertificate().raw));
      s.end('hi');
    },
  );
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const seenByClient = await new Promise((resolve, reject) => {
    const c = tls.connect({
      host: '127.0.0.1', port: srv.address().port, key: client.key, cert: client.cert,
      rejectUnauthorized: false, minVersion: 'TLSv1.3', checkServerIdentity: () => undefined,
    }, () => resolve(sha256hex(c.getPeerCertificate().raw)));
    c.on('error', reject);
    c.resume();
  });
  const seenByServer = await serverSide;
  srv.close();
  assert.equal(seenByClient, server.fingerprint);
  assert.equal(seenByServer, client.fingerprint);
});
