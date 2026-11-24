/**
 * Full Platform Verification & Security Invariant Script
 */
const assert = require('assert');
const fs = require('fs');

// 1. Verify catalogData.js & commerce.js
require('../assets/js/catalogData.js');
const catalog = globalThis.FT_CATALOG;
const commerce = require('../assets/js/commerce.js');

if (!catalog) {
  console.error('FAIL: globalThis.FT_CATALOG is not defined!');
  process.exit(1);
}

console.log('--- Catalog System Verification ---');
console.log('Total Collections:', catalog.COLLECTIONS.length);
console.log('Total Products:', catalog.PRODUCTS.length);

if (catalog.COLLECTIONS.length !== 8) {
  console.error(`FAIL: Expected exactly 8 collections, got ${catalog.COLLECTIONS.length}`);
  process.exit(1);
}

if (catalog.PRODUCTS.length !== 53) {
  console.error(`FAIL: Expected exactly 53 products, got ${catalog.PRODUCTS.length}`);
  process.exit(1);
}

const fashionCount = catalog.PRODUCTS.filter(p => p.superCategory === 'Fashion').length;
const accCount = catalog.PRODUCTS.filter(p => p.superCategory === 'Accessories').length;

console.log('Fashion SKUs:', fashionCount, '(Expected 18)');
console.log('Accessories SKUs:', accCount, '(Expected 35)');

if (fashionCount !== 18 || accCount !== 35) {
  console.error('FAIL: SKU counts do not match expected 18 fashion and 35 accessories!');
  process.exit(1);
}

assert.ok(commerce && typeof commerce.computeOrderTotals === 'function', 'commerce.js exports computeOrderTotals');
assert.strictEqual(commerce.DEFAULT_FREE_SHIPPING_THRESHOLD, 3000, 'Canonical free shipping threshold is 3000 BDT');

// 2. Check all supplied image assets on disk across KEYS
let missingAssets = 0;
let checkedAssets = 0;
const slotsToCheck = Array.isArray(catalog.KEYS) && catalog.KEYS.length
  ? catalog.KEYS
  : ['main', 'original', 'alternate', 'socialSquare', 'storyReel', 'detailA', 'detailB', 'aiStylingPreview'];

catalog.PRODUCTS.forEach(p => {
  if (!p.assets || !p.assets.main) {
    console.error(`FAIL: Product ${p.sku} has no main asset defined!`);
    missingAssets++;
    return;
  }

  slotsToCheck.forEach(slot => {
    const assetPath = p.assets[slot];
    if (!assetPath) return;
    checkedAssets++;
    if (!fs.existsSync(assetPath)) {
      console.error(`Missing ${slot} asset for ${p.sku}: ${assetPath}`);
      missingAssets++;
    }
  });
});

console.log(`Checked ${checkedAssets} image assets on disk across all slots. Missing: ${missingAssets}`);

if (missingAssets > 0) {
  console.error('FAIL: Some image files are missing on disk!');
  process.exit(1);
}

// Verify supabase/seed.sql asset URLs exist on disk
if (fs.existsSync('supabase/seed.sql')) {
  const seedSql = fs.readFileSync('supabase/seed.sql', 'utf8');
  const seedAssets = new Set();
  const seedAssetRegex = /'(assets\/products\/[^']+)'/g;
  let m;
  while ((m = seedAssetRegex.exec(seedSql)) !== null) {
    seedAssets.add(m[1]);
  }
  let missingSeedAssets = 0;
  seedAssets.forEach(relPath => {
    if (!fs.existsSync(relPath)) {
      console.error(`Missing asset referenced in supabase/seed.sql: ${relPath}`);
      missingSeedAssets++;
    }
  });
  if (missingSeedAssets > 0) {
    console.error('FAIL: supabase/seed.sql references missing files on disk!');
    process.exit(1);
  }
  console.log(`Verified ${seedAssets.size} unique asset paths in supabase/seed.sql.`);
}

// 3. Verify collection integrity & JavaScript files exist with zero syntax errors
const colIds = new Set(catalog.COLLECTIONS.map(c => c.id));
catalog.PRODUCTS.forEach(p => {
  if (!colIds.has(p.colId)) {
    console.error(`FAIL: Product ${p.sku} references unknown colId: ${p.colId}`);
    process.exit(1);
  }
});

const jsFiles = [
  'server.js',
  'api/capi.js',
  'api/index.js',
  'lib/supabaseServer.js',
  'lib/localBoutiqueStore.js',
  'assets/js/commerce.js',
  'assets/js/config.js',
  'assets/js/supabaseClient.js',
  'assets/js/catalogData.js',
  'assets/js/threeHero.js',
  'assets/js/threeCollectionParallax.js',
  'assets/js/threeui.js',
  'assets/js/threeAdminCockpit.js',
  'assets/js/adminCockpit.js',
  'assets/js/animePolish.js',
  'assets/js/app.js'
];

console.log('--- JavaScript Files Verification ---');
jsFiles.forEach(f => {
  if (!fs.existsSync(f)) {
    console.error(`FAIL: File does not exist: ${f}`);
    process.exit(1);
  }
  const code = fs.readFileSync(f, 'utf8');
  try {
    new Function(code);
    console.log(`PASS: ${f} (${(code.length / 1024).toFixed(1)} KB) syntax OK`);
  } catch (err) {
    console.error(`FAIL: Syntax error in ${f}:`, err.message);
    process.exit(1);
  }
  if (/\b(?:window\.)?(?:alert|open)\s*\(/.test(code) && !f.startsWith('server')) {
    console.error(`FAIL: Forbidden window.alert / window.open detected in ${f}`);
    process.exit(1);
  }
});

// 4. Verify index.html, admin.html, ghl-bundle.html & inline scripts
console.log('--- HTML Pages Verification ---');
['index.html', 'admin.html', 'ghl-bundle.html'].forEach(f => {
  if (!fs.existsSync(f)) {
    console.error(`FAIL: HTML file does not exist: ${f}`);
    process.exit(1);
  }
  const content = fs.readFileSync(f, 'utf8');
  const scriptRegex = /<script(?![^>]*src=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let inlineIdx = 0;
  while ((match = scriptRegex.exec(content)) !== null) {
    inlineIdx++;
    const snippet = match[1].trim();
    if (!snippet) continue;
    try {
      new Function(snippet);
    } catch (err) {
      console.error(`FAIL: Inline script #${inlineIdx} syntax error in ${f}:`, err.message);
      process.exit(1);
    }
    if (/\b(?:window\.)?(?:alert|open)\s*\(/.test(snippet)) {
      console.error(`FAIL: Forbidden window.alert / window.open in inline script #${inlineIdx} of ${f}`);
      process.exit(1);
    }
  }
  console.log(`PASS: ${f} (${(content.length / 1024).toFixed(1)} KB, ${inlineIdx} inline scripts OK)`);
});

// 5. Verify Static Security Invariants
console.log('--- Static Security Invariant Checks ---');
const adminHtml = fs.readFileSync('admin.html', 'utf8');
assert.ok(!adminHtml.includes("'1430'") && !adminHtml.includes('"1430"'), 'admin.html must not contain hardcoded PIN 1430');
assert.ok(!adminHtml.includes('ft_admin_unlocked'), 'admin.html must not use client-side unlock bypass');
assert.ok(!adminHtml.includes('set-admin-pin'), 'admin.html must not expose client PIN settings');

const serverJs = fs.readFileSync('server.js', 'utf8');
assert.ok(!serverJs.includes('.data/orders.json'), 'server.js must not use ephemeral .data/orders.json');
assert.ok(!/app\.get\s*\(\s*['"]\/api\/orders['"]/.test(serverJs), 'server.js must not expose unauthenticated GET /api/orders');
assert.ok(!/app\.patch\s*\(\s*['"]\/api\/orders\//.test(serverJs), 'server.js must not expose unauthenticated PATCH /api/orders/:orderRef');

const configJs = fs.readFileSync('assets/js/config.js', 'utf8');
assert.ok(!/anonKey\s*:\s*['"]eyJ/.test(configJs), 'config.js must not hardcode a Supabase anonKey JWT');
assert.ok(!/service_role/i.test(configJs), 'config.js must never reference service_role key');

assert.ok(fs.existsSync('supabase/migrations/02_security_hardening.sql'), '02_security_hardening.sql must exist');
const migration02 = fs.readFileSync('supabase/migrations/02_security_hardening.sql', 'utf8');
assert.ok(!/FOR ALL\s+USING\s*\(\s*true\s*\)/i.test(migration02), '02_security_hardening.sql must not contain permissive FOR ALL USING (true)');
assert.ok(/CREATE OR REPLACE FUNCTION private\.is_super_admin\(\)/i.test(migration02), '02_security_hardening.sql must define private.is_super_admin()');
assert.ok(/CREATE POLICY "staff_users_admin_manage"[\s\S]*?private\.is_super_admin\(\)/i.test(migration02), 'staff_users_admin_manage must use non-recursive private.is_super_admin() helper');
assert.ok(fs.existsSync('supabase/migrations/02_security_hardening_rollback.sql'), '02_security_hardening_rollback.sql must exist');

assert.ok(fs.existsSync('supabase/migrations/03_handover_reconciliation.sql'), '03_handover_reconciliation.sql must exist');
assert.ok(fs.existsSync('supabase/migrations/03_handover_reconciliation_rollback.sql'), '03_handover_reconciliation_rollback.sql must exist');
const migration03 = fs.readFileSync('supabase/migrations/03_handover_reconciliation.sql', 'utf8');
assert.ok(migration03.includes('private.is_staff_member'), '03_handover_reconciliation.sql must use non-recursive private.is_staff_member()');
assert.ok(migration03.includes('private.is_super_admin'), '03_handover_reconciliation.sql must use non-recursive private.is_super_admin()');
assert.ok(migration03.includes('capi_outbox') && migration03.includes('audit_logs'), '03_handover_reconciliation.sql must provision capi_outbox and audit_logs');
assert.ok(migration03.includes('ft_create_order_atomic') && migration03.includes('ft_transition_order_inventory'), '03_handover_reconciliation.sql must define atomic stock RPCs');

const seedSql = fs.readFileSync('supabase/seed.sql', 'utf8');
assert.ok(!seedSql.includes('8801700000000'), 'seed.sql must not seed placeholder 8801700000000 WhatsApp');
assert.ok(seedSql.includes('3000'), 'seed.sql must align free_delivery_threshold = 3000');

const indexHtmlRaw = fs.readFileSync('index.html', 'utf8');
const ghlHtmlRaw = fs.readFileSync('ghl-bundle.html', 'utf8');
assert.ok(!indexHtmlRaw.includes('@supabase/supabase-js@2"'), 'index.html must not use unpinned @supabase/supabase-js@2');
assert.ok(!adminHtml.includes('@supabase/supabase-js@2"'), 'admin.html must not use unpinned @supabase/supabase-js@2');
assert.ok(!ghlHtmlRaw.includes('@supabase/supabase-js@2"'), 'ghl-bundle.html must not use unpinned @supabase/supabase-js@2');
assert.ok(!ghlHtmlRaw.includes('8801700000000'), 'ghl-bundle.html must not embed placeholder 8801700000000');
assert.ok(ghlHtmlRaw.includes('id="ft-consent-bar"'), 'ghl-bundle.html must include GDPR consent banner');
assert.ok(!/fbq\s*\(\s*['"]track['"]/i.test(ghlHtmlRaw), 'ghl-bundle.html must not fire Meta Pixel fbq("track") eagerly before consent');

assert.ok(fs.existsSync('docs/SELLER_53_SKU_LEDGER.csv'), 'docs/SELLER_53_SKU_LEDGER.csv must exist');

assert.ok(!fs.existsSync('netlify.toml'), 'Misleading static netlify.toml must be removed');
if (fs.existsSync('vercel.json')) {
  const vercelCfg = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  const hasExpressRewrite = Array.isArray(vercelCfg.rewrites) && vercelCfg.rewrites.some(r => r && r.destination === '/api/index.js');
  assert.ok(hasExpressRewrite, 'vercel.json must route requests through /api/index.js Express bridge');
}

// 6. Verify .env.example Canonical Template & Secret Hygiene
const { parseDotEnvContent } = require('../lib/supabaseServer.js');
assert.ok(fs.existsSync('.env.example'), '.env.example must exist');
const envExampleRaw = fs.readFileSync('.env.example', 'utf8');
const envExampleParsed = parseDotEnvContent(envExampleRaw);
const requiredEnvKeys = [
  'PORT',
  'NODE_ENV',
  'PUBLIC_SITE_URL',
  'ALLOWED_ORIGINS',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_ALLOWED_EMAILS',
  'META_DATASET_ID',
  'META_PIXEL_ID',
  'META_CAPI_ACCESS_TOKEN',
  'META_TEST_EVENT_CODE'
];
for (const key of requiredEnvKeys) {
  assert.ok(Object.prototype.hasOwnProperty.call(envExampleParsed, key), `.env.example must define ${key}`);
}
assert.strictEqual(envExampleParsed.PUBLIC_SITE_URL, 'https://farizasterritory.com', '.env.example PUBLIC_SITE_URL must match canonical domain');
assert.strictEqual(envExampleParsed.SUPABASE_URL, 'https://vjbhrdclcnxevunskodm.supabase.co', '.env.example SUPABASE_URL must match project URL');
assert.strictEqual(envExampleParsed.META_DATASET_ID, '1657670575734647', '.env.example META_DATASET_ID must match canonical dataset ID');
assert.strictEqual(envExampleParsed.META_PIXEL_ID, '1657670575734647', '.env.example META_PIXEL_ID must match canonical pixel ID');
assert.strictEqual(envExampleParsed.SUPABASE_ANON_KEY, '', '.env.example SUPABASE_ANON_KEY must be blank');
assert.strictEqual(envExampleParsed.SUPABASE_SERVICE_ROLE_KEY, '', '.env.example SUPABASE_SERVICE_ROLE_KEY must be blank');
assert.strictEqual(envExampleParsed.META_CAPI_ACCESS_TOKEN, '', '.env.example META_CAPI_ACCESS_TOKEN must be blank');
assert.strictEqual(envExampleParsed.META_TEST_EVENT_CODE, '', '.env.example META_TEST_EVENT_CODE must be blank in production');

console.log('PASS: Static security invariants & .env.example template verified');

console.log('\n=========================================');
console.log('ALL VERIFICATION CHECKS PASSED PERFECTLY!');
console.log('=========================================');
