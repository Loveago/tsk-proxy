#!/usr/bin/env node

/**
 * Paystack Proxy Build & Production Readiness Verification Script
 * Validates configurations, static dashboard UI assets, and module integrity.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../');

console.log('====================================================');
console.log('  Paystack Multi-Site Proxy - Production Build Check');
console.log('====================================================\n');

let hasErrors = false;

async function step(name, fn) {
  try {
    process.stdout.write(`• Checking ${name}... `);
    const result = await fn();
    console.log(`\x1b[32m✔ PASSED\x1b[0m ${result ? `(${result})` : ''}`);
  } catch (err) {
    console.log(`\x1b[31m✖ FAILED\x1b[0m`);
    console.error(`  Error: ${err.message}`);
    hasErrors = true;
  }
}

// 1. Verify Node.js runtime environment
await step('Node.js runtime version', () => {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    throw new Error(`Node.js >= 18 required, current is ${process.version}`);
  }
  return `v${process.versions.node}`;
});

// 2. Validate package.json
// 2. Validate package.json
await step('package.json manifest', () => {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error('package.json is missing');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.name || !pkg.version) {
    throw new Error('package.json missing name or version');
  }
  return `${pkg.name} v${pkg.version}`;
});

// 3. Validate config/sites.json
await step('Sites configuration (config/sites.json)', () => {
  const sitesPath = path.join(projectRoot, 'config/sites.json');
  if (!fs.existsSync(sitesPath)) {
    throw new Error('config/sites.json file does not exist');
  }
  const data = JSON.parse(fs.readFileSync(sitesPath, 'utf8'));
  if (!data.sites || typeof data.sites !== 'object') {
    throw new Error('config/sites.json missing valid "sites" dictionary');
  }
  const keys = Object.keys(data.sites);
  if (keys.length === 0) {
    throw new Error('No child sites configured in config/sites.json');
  }
  for (const [key, site] of Object.entries(data.sites)) {
    if (!site.webhookUrl) {
      throw new Error(`Child site "${key}" missing required "webhookUrl"`);
    }
  }
  return `${keys.length} sites (${keys.join(', ')})`;
});

// 4. Validate Static UI Dashboard Assets
await step('Static UI assets in public/ directory', () => {
  const publicDir = path.join(projectRoot, 'public');
  if (!fs.existsSync(publicDir)) {
    throw new Error('public/ directory is missing');
  }
  const indexPath = path.join(publicDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error('public/index.html is missing');
  }
  const stats = fs.statSync(indexPath);
  if (stats.size < 500) {
    throw new Error(`public/index.html is suspiciously small (${stats.size} bytes)`);
  }

  // Validate embedded script syntax integrity
  const html = fs.readFileSync(indexPath, 'utf8');
  const scriptRegex = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let scriptCount = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    const code = match[1];
    if (code.trim()) {
      new Function(code);
      scriptCount++;
    }
  }

  return `index.html (${(stats.size / 1024).toFixed(1)} KB, ${scriptCount} scripts validated)`;
});

// 5. Verify core application imports
await step('Application module imports and syntax integrity', async () => {
  await import('../src/config/index.js');
  await import('../src/services/queue.js');
  await import('../src/services/dispatcher.js');
  await import('../src/services/paystack.js');
  await import('../src/routes/health.js');
  await import('../src/routes/dashboard.js');
  await import('../src/routes/webhook.js');
  await import('../src/routes/callback.js');
  await import('../src/app.js');
  return 'All ES modules imported cleanly';
});

// 6. Validate Next.js Modern UI Dashboard Build
await step('Next.js modern UI export in frontend/out', () => {
  const outDir = path.join(projectRoot, 'frontend/out');
  if (!fs.existsSync(outDir)) {
    throw new Error('frontend/out directory is missing. Run npm --prefix frontend run build');
  }
  const indexPath = path.join(outDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error('frontend/out/index.html is missing');
  }
  const stats = fs.statSync(indexPath);
  if (stats.size < 1000) {
    throw new Error(`frontend/out/index.html is suspiciously small (${stats.size} bytes)`);
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  if (!html.includes('Paystack Multi-Site Proxy')) {
    throw new Error('frontend/out/index.html missing Paystack Multi-Site Proxy header');
  }
  return `index.html (${(stats.size / 1024).toFixed(1)} KB, Next.js static export validated)`;
});

// 7. Sync Next.js _next assets and app.html into public/ directory for Vercel CDN and Express serving
await step('Syncing Next.js build assets into public/ directory', () => {
  const outNextDir = path.join(projectRoot, 'frontend/out/_next');
  const publicNextDir = path.join(projectRoot, 'public/_next');
  if (fs.existsSync(outNextDir)) {
    fs.cpSync(outNextDir, publicNextDir, { recursive: true });
  }
  const outIndexHtml = path.join(projectRoot, 'frontend/out/index.html');
  const publicAppHtml = path.join(projectRoot, 'public/app.html');
  if (fs.existsSync(outIndexHtml)) {
    fs.copyFileSync(outIndexHtml, publicAppHtml);
  }
  return 'Copied frontend/out/_next and app.html into public/ directory';
});

if (hasErrors) {
  console.error('\n\x1b[31mBuild failed with one or more errors.\x1b[0m\n');
  process.exit(1);
} else {
  console.log('\n\x1b[32m✔ Build verification completed successfully.\x1b[0m');
  console.log('  The UI dashboard and Express API server are production-ready.\n');
  process.exit(0);
}
