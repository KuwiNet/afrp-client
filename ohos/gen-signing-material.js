#!/usr/bin/env node
/*
 * hvigor >= 5.19.8 requires signing passwords in build-profile.json5 to be
 * hex-encoded AES-GCM ciphertext, decryptable with key material living in
 * <dir of storeFile>/material/{fd,ac,ce}. DevEco Studio normally generates
 * that directory; this script recreates it for CLI-only workflows.
 *
 * Format reversed from @ohos/hvigor-ohos-plugin src/utils/decipher-util.js:
 *   root = pbkdf2_sha256(utf8(xor(fd0, fd1, fd2, COMPONENT)), salt, 10000, 16)
 *   key  = AES-128-GCM.decrypt(root, <material/ce/*>)
 *   pwd  = AES-128-GCM.decrypt(key,  <hex blob from build-profile.json5>)
 * Blob layout: BE32(ct.length + 16) || iv(12) || ct || tag(16)
 *
 * Usage:
 *   node gen-signing-material.js --verify        (self-test against the plugin's own material)
 *   node gen-signing-material.js [--force]       (ensure material + rewrite passwords in build-profile.json5)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COMPONENT = Buffer.from([49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119]);
const PLAIN_STORE_PASS = 'LocalTestSignPassword_1234567890ab';
const PLAIN_KEY_PASS = 'LocalTestSignPassword_1234567890ab';

function xorAll(bufs) {
  const out = Buffer.from(bufs[0]);
  for (let k = 1; k < bufs.length; k++) {
    for (let i = 0; i < out.length; i++) out[i] ^= bufs[k][i];
  }
  return out;
}

function rootKeyFrom(fd, salt) {
  const pw = xorAll([...fd, COMPONENT]).toString('utf8');
  return crypto.pbkdf2Sync(pw, salt, 10000, 16, 'sha256');
}

function gcmDecrypt(key, blob) {
  const r = ((blob[0] << 24) >>> 0) + (blob[1] << 16) + (blob[2] << 8) + blob[3];
  const ivLen = blob.length - 4 - r;
  const iv = blob.subarray(4, 4 + ivLen);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(4 + ivLen, blob.length - 16);
  const d = crypto.createDecipheriv('aes-128-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

function gcmEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-128-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(ct.length + 16, 0);
  return Buffer.concat([head, iv, ct, c.getAuthTag()]);
}

function readSingleFileDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => f !== '.DS_Store');
  if (files.length !== 1) throw new Error(`${dir}: expected exactly 1 file, found ${files.length}`);
  return fs.readFileSync(path.join(dir, files[0]));
}

function loadMaterial(matDir) {
  const fd = ['0', '1', '2'].map((n) => readSingleFileDir(path.join(matDir, 'fd', n)));
  return { fd, salt: readSingleFileDir(path.join(matDir, 'ac')), work: readSingleFileDir(path.join(matDir, 'ce')) };
}

function writeFileRandom(relDir, buf) {
  fs.mkdirSync(relDir, { recursive: true });
  fs.writeFileSync(path.join(relDir, crypto.randomBytes(16).toString('hex')), buf);
}

function findPluginMaterial() {
  const root = path.join(process.env.USERPROFILE || process.env.HOME, '.hvigor', 'project_caches');
  for (const cache of fs.readdirSync(root)) {
    const pnpm = path.join(root, cache, 'workspace', 'node_modules', '.pnpm');
    if (!fs.existsSync(pnpm)) continue;
    for (const entry of fs.readdirSync(pnpm)) {
      if (!entry.startsWith('@ohos+hvigor-ohos-plugin@')) continue;
      const mat = path.join(pnpm, entry, 'node_modules', '@ohos', 'hvigor-ohos-plugin', 'res', 'material');
      if (fs.existsSync(path.join(mat, 'fd'))) return mat;
    }
  }
  throw new Error('plugin res/material not found');
}

function verify() {
  const pluginMat = findPluginMaterial();
  const m = loadMaterial(pluginMat);
  const root = rootKeyFrom(m.fd, m.salt);
  const key = gcmDecrypt(root, m.work);
  if (key.length !== 16) throw new Error(`work key length ${key.length}, expected 16`);
  const zbHex = fs.readFileSync(path.join(pluginMat, 'zb', 'de'), 'utf8').trim();
  const plain = gcmDecrypt(key, Buffer.from(zbHex, 'hex'));
  console.log(`verify OK: plugin default store password = ${JSON.stringify(plain.toString('utf8'))}`);
}

function splitPems(text) {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
}

function findSignTool() {
  const props = fs.readFileSync(path.join(__dirname, 'local.properties'), 'utf8');
  const m = props.match(/sdk\.dir\s*=\s*(.+)/);
  if (!m) throw new Error('sdk.dir not found in local.properties');
  const sdk = m[1].trim().replace(/\\\\/g, '\\');
  const jars = fs
    .readdirSync(sdk)
    .map((d) => path.join(sdk, d, 'toolchains', 'lib', 'hap-sign-tool.jar'))
    .filter((p) => fs.existsSync(p))
    .sort();
  if (!jars.length) throw new Error(`hap-sign-tool.jar not found under ${sdk}`);
  return jars[jars.length - 1];
}

// The SDK's OpenHarmony.p12 ships a self-signed 'openharmony application release'
// cert, but hap-sign-tool requires a leaf issued by 'openharmony application ca'
// (whose private key is also in the p12). Re-issue the leaf with the bundled
// hap-sign-tool so the chain verifies.
function ensureAppCert(sigDir) {
  const pemPath = path.join(sigDir, 'OpenHarmonyApplication.pem');
  const pems = splitPems(fs.readFileSync(pemPath, 'utf8'));
  if (pems.length < 3) throw new Error('OpenHarmonyApplication.pem: expected 3 certificates');
  const leaf = new crypto.X509Certificate(pems[0]);
  if (leaf.subject !== leaf.issuer) {
    console.log('app cert leaf is CA-issued, OK');
    return;
  }
  console.log('app cert leaf is self-signed, re-issuing with OpenHarmony Application CA ...');
  const tmpLeaf = path.join(sigDir, 'new_leaf.pem.tmp');
  const r = require('child_process').spawnSync('java', [
    '-jar', findSignTool(), 'generate-cert',
    '-keyAlias', 'openharmony application release', '-keyPwd', PLAIN_STORE_PASS,
    '-issuer', 'C=CN,O=OpenHarmony,OU=OpenHarmony Team,CN=OpenHarmony Application CA',
    '-issuerKeyAlias', 'openharmony application ca', '-issuerKeyPwd', PLAIN_STORE_PASS,
    '-subject', 'C=CN,O=OpenHarmony,OU=OpenHarmony Team,CN=OpenHarmony Application Release',
    '-validity', '1095', '-keyUsage', 'digitalSignature', '-extKeyUsage', 'codeSignature',
    '-signAlg', 'SHA256withECDSA',
    '-keystoreFile', path.join(sigDir, 'OpenHarmony.p12'), '-keystorePwd', PLAIN_STORE_PASS,
    '-outFile', tmpLeaf,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('hap-sign-tool generate-cert failed');
  fs.copyFileSync(pemPath, pemPath + '.selfsigned.bak');
  fs.writeFileSync(pemPath, fs.readFileSync(tmpLeaf, 'utf8').trim() + '\n' + pems.slice(1).join('\n') + '\n');
  fs.rmSync(tmpLeaf);
  console.log('OpenHarmonyApplication.pem rebuilt: CA-signed leaf + CA + Root');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--verify')) return verify();

  const ohosDir = __dirname;
  const sigDir = path.join(ohosDir, 'signature');
  const matDir = path.join(sigDir, 'material');
  const force = args.includes('--force');

  if (force && fs.existsSync(matDir)) fs.rmSync(matDir, { recursive: true });

  if (fs.existsSync(path.join(matDir, 'fd'))) {
    console.log('material exists, reusing (pass --force to regenerate)');
  } else {
    const fd = [crypto.randomBytes(16), crypto.randomBytes(16), crypto.randomBytes(16)];
    const salt = crypto.randomBytes(16);
    const root = rootKeyFrom(fd, salt);
    const key = crypto.randomBytes(16);
    for (let i = 0; i < 3; i++) writeFileRandom(path.join(matDir, 'fd', String(i)), fd[i]);
    writeFileRandom(path.join(matDir, 'ac'), salt);
    writeFileRandom(path.join(matDir, 'ce'), gcmEncrypt(root, key));
    console.log(`material generated at ${matDir}`);
  }

  if (fs.existsSync(path.join(sigDir, 'OpenHarmonyApplication.pem'))) ensureAppCert(sigDir);

  const m = loadMaterial(matDir);
  const key = gcmDecrypt(rootKeyFrom(m.fd, m.salt), m.work);

  const profilePath = path.join(ohosDir, 'build-profile.json5');
  let profile = fs.readFileSync(profilePath, 'utf8');
  const storeHex = gcmEncrypt(key, Buffer.from(PLAIN_STORE_PASS)).toString('hex');
  const keyHex = gcmEncrypt(key, Buffer.from(PLAIN_KEY_PASS)).toString('hex');
  const before = profile;
  profile = profile
    .replace(/("storePassword"\s*:\s*)"[^"]*"/, `$1"${storeHex}"`)
    .replace(/("keyPassword"\s*:\s*)"[^"]*"/, `$1"${keyHex}"`);
  if (profile === before && !before.includes(storeHex)) throw new Error('failed to rewrite passwords in build-profile.json5');
  fs.writeFileSync(profilePath, profile);
  console.log('build-profile.json5 passwords rewritten (storePassword/keyPassword)');
  console.log(`plaintext for hap-sign-tool: ${PLAIN_STORE_PASS}`);
}

main();
