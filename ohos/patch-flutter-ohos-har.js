// Re-applies local patches to @ohos/flutter_ohos har source after `ohpm install`.
// Reason: the har is built against Huawei HarmonyOS SDK where KeyEvent exposes
// isCapsLockOn/isNumLockOn, while OpenHarmony SDK exposes capsLock/numLock.
// Run: node patch-flutter-ohos-har.js
const fs = require('fs');
const path = require('path');

const ohpmRoot = path.join(__dirname, 'oh_modules', '.ohpm');
if (!fs.existsSync(ohpmRoot)) {
  console.log('oh_modules/.ohpm not found, run ohpm install first');
  process.exit(0);
}

const patches = [
  {
    file: ['oh_modules', '@ohos', 'flutter_ohos', 'src', 'main', 'ets', 'embedding', 'ohos', 'KeyEventHandler.ets'],
    replacements: [
      [
        'const isCapsLockOn = event.isCapsLockOn !== undefined ? event.isCapsLockOn : false;',
        'const isCapsLockOn = (event as ESObject).capsLock === true;'
      ],
      [
        'const isNumLockOn = event.isNumLockOn !== undefined ? event.isNumLockOn : true;',
        'const isNumLockOn = (event as ESObject).numLock !== false;'
      ]
    ]
  }
];

let patchedFiles = 0;
for (const dir of fs.readdirSync(ohpmRoot)) {
  if (!dir.startsWith('@ohos+flutter_ohos@')) continue;
  for (const patch of patches) {
    const file = path.join(ohpmRoot, dir, ...patch.file);
    if (!fs.existsSync(file)) continue;
    let src = fs.readFileSync(file, 'utf8');
    let changed = false;
    for (const [from, to] of patch.replacements) {
      if (src.includes(from)) {
        src = src.split(from).join(to);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(file, src);
      patchedFiles++;
      console.log('patched:', file);
    }
  }
}
console.log('done, patched files:', patchedFiles);
