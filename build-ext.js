const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const envProdPath = path.join(__dirname, '.env.production');
let backendUrl = 'http://localhost:3000';

if (fs.existsSync(envProdPath)) {
  const envContent = fs.readFileSync(envProdPath, 'utf-8');
  const match = envContent.match(/PUBLIC_API_URL="([^"]+)"/);
  if (match && match[1]) {
    backendUrl = match[1];
  }
}

console.log(`Building extension with Backend URL: ${backendUrl}`);

const extDir = path.join(__dirname, 'extension');
const tempExtDir = path.join(__dirname, 'dist-extension');

// Clean up previous temp dir
if (fs.existsSync(tempExtDir)) {
  fs.rmSync(tempExtDir, { recursive: true, force: true });
}

// Copy extension to temp folder
execSync(`cp -R ${extDir} ${tempExtDir}`);

// Replace backendUrl in storage.js
const storageFile = path.join(tempExtDir, 'services', 'storage.js');
let storageContent = fs.readFileSync(storageFile, 'utf-8');
storageContent = storageContent.replace(
  /backendUrl:\s*'http:\/\/localhost:3000'/g,
  `backendUrl: '${backendUrl}'`,
);
fs.writeFileSync(storageFile, storageContent);

// The dashboard bridge is a content script, so its origin is fixed at build
// time — a match pattern cannot be read from config at runtime. The checked-in
// manifest lists the dev origins; a distributable has to carry the deployed one
// or the dashboard sees no extension on the machine it actually runs on.
const manifestFile = path.join(tempExtDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
const bridge = manifest.content_scripts?.find((cs) =>
  cs.js?.includes('content-scripts/dashboardBridge.js'),
);

if (bridge) {
  const origin = new URL(backendUrl).origin;
  // Kept alongside localhost rather than replacing it: one build should work
  // against the deployment and against a local server, and an extra match
  // pattern costs nothing.
  bridge.matches = [
    ...new Set([...bridge.matches, `${origin}/*`, 'http://localhost:3000/*']),
  ];
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Dashboard bridge matches: ${bridge.matches.join(', ')}`);
}

// Zip the temp folder
console.log('Zipping extension...');
try {
  execSync(`cd ${tempExtDir} && zip -r ../extension.zip . -x '*.DS_Store*'`);
  console.log('Successfully created extension.zip!');
} catch (err) {
  console.error('Error zipping extension:', err.message);
}

// Clean up temp dir
fs.rmSync(tempExtDir, { recursive: true, force: true });
