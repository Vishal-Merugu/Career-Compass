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
// An unpacked folder, not a zip: load it straight into Chrome via
// chrome://extensions → Load unpacked. Rebuild overwrites it in place.
const outDir = path.join(__dirname, 'ext-prod');

// Clean up the previous build
if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
}

// Copy the extension source into the output folder
execSync(`cp -R ${extDir} ${outDir}`);

// Replace backendUrl in storage.js
const storageFile = path.join(outDir, 'services', 'storage.js');
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
const manifestFile = path.join(outDir, 'manifest.json');
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

// Drop any stray macOS metadata, then leave the folder in place for Chrome.
try {
  execSync(`find ${outDir} -name '.DS_Store' -delete`);
} catch {
  // No .DS_Store to remove — nothing to do.
}

console.log(`Successfully built unpacked extension at: ${outDir}`);
console.log(
  'Load it in Chrome: chrome://extensions → Developer mode → Load unpacked → select the ext-prod folder.',
);
