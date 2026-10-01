// Each install gets a long-lived self-signed ECDSA P-256 certificate. Its SHA-256
// fingerprint is the peer's identity: peers announce it over discovery, and the
// sender checks it against the certificate actually presented in the TLS
// handshake. Node has no API for creating X.509 certificates, so this module
// builds the (tiny) DER structure by hand rather than pulling in a dependency.
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256hex } from './util.js';

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';

function lenBytes(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lenBytes(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);

function derInt(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  buf = buf.subarray(i);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}

function derOid(oid) {
  const arcs = oid.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function derTime(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const body =
    `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const year = d.getUTCFullYear();
  // RFC 5280: UTCTime up to 2049, GeneralizedTime from 2050.
  return year < 2050
    ? tlv(0x17, Buffer.from(p(year % 100) + body))
    : tlv(0x18, Buffer.from(p(year, 4) + body));
}

export function createSelfSignedCert(cn = 'beam') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = seq(set(seq(derOid(OID_COMMON_NAME), tlv(0x0c, Buffer.from(cn)))));
  const sigAlg = seq(derOid(OID_ECDSA_SHA256));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfter = new Date(Date.now() + 3650 * 24 * 3600 * 1000);

  const tbs = seq(
    tlv(0xa0, derInt(Buffer.from([2]))), // version: v3
    derInt(serial),
    sigAlg,
    name, // issuer
    seq(derTime(notBefore), derTime(notAfter)),
    name, // subject
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.from([0]), signature));

  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function defaultConfigDir() {
  if (process.env.BEAM_HOME) return process.env.BEAM_HOME;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'beam');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'beam');
}

/** Load the identity from `dir`, creating (and persisting) one on first run. */
export function loadOrCreateIdentity(dir = defaultConfigDir()) {
  const file = path.join(dir, 'identity.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const x = new X509Certificate(saved.cert);
    if (new Date(x.validTo) > new Date(Date.now() + 30 * 24 * 3600 * 1000)) {
      return { cert: saved.cert, key: saved.key, fingerprint: sha256hex(x.raw) };
    }
  } catch {
    /* missing or unusable: fall through and generate a new identity */
  }
  const { cert, key } = createSelfSignedCert();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ cert, key }), { mode: 0o600 });
  return { cert, key, fingerprint: sha256hex(new X509Certificate(cert).raw) };
}
