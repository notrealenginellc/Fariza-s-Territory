const express = require('express');
const path = require('path');
const fs = require('fs');
const { createSupabaseServerStore, getSupabaseConfig } = require('./lib/supabaseServer.js');
const capiHandler = require('./api/capi.js');
const commerce = require('./assets/js/commerce.js');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_ALLOWED_AISTUDIO_FILES = new Set([
  'fariza_s_territory_brand_book_by_pomelli_1e38cd9b.pdf'
]);
const ALLOWED_MEDIA_ASSET_KEYS = new Set([
  'main',
  'hero16x9',
  'socialSquare',
  'storyReel',
  'gallery1',
  'gallery2'
]);

function toAbsoluteMediaUrl(baseUrl, relOrAbs) {
  const s = String(relOrAbs || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `${baseUrl}/${s.replace(/^\/+/, '')}`;
}

function parseDataUrlImage(dataUrl) {
  const raw = String(dataUrl || '').trim();
  const match = /^data:(image\/(?:webp|png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
  if (!match) return { ok: false, error: 'Image must be a base64 WebP, PNG, or JPEG data URL.' };
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length || buffer.length > 4 * 1024 * 1024) {
    return { ok: false, error: 'Image binary must be between 1 byte and 4 MB.' };
  }
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isWebp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (isWebp) return { ok: true, buffer, mimeType: 'image/webp', ext: 'webp' };
  if (isPng) return { ok: true, buffer, mimeType: 'image/png', ext: 'png' };
  if (isJpeg) return { ok: true, buffer, mimeType: 'image/jpeg', ext: 'jpg' };
  return { ok: false, error: 'Uploaded binary failed image signature verification.' };
}

function loadCatalogInMemory() {
  try {
    const catalogCode = fs.readFileSync(path.join(__dirname, 'assets/js/catalogData.js'), 'utf8');
    const sandbox = {};
    const fn = new Function('window', catalogCode);
    fn(sandbox);
    return sandbox.FT_CATALOG || { COLLECTIONS: [], PRODUCTS: [], PRODUCTS_BY_SKU: {} };
  } catch (err) {
    console.error('[Server] Failed to load catalogData.js:', err.message);
    return { COLLECTIONS: [], PRODUCTS: [], PRODUCTS_BY_SKU: {} };
  }
}

function getCanonicalBaseUrl(req) {
  const configured = String(process.env.PUBLIC_SITE_URL || '').trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      return parsed.origin.replace(/\/+$/, '');
    } catch (_) {}
  }
  if (req) {
    const host = String(req.get('host') || '').trim();
    if (host && (/^localhost(:\d+)?$/i.test(host) || /^127\.0\.0\.1(:\d+)?$/.test(host) || /^0\.0\.0\.0(:\d+)?$/.test(host))) {
      const proto = req.protocol === 'https' ? 'https' : 'http';
      return `${proto}://${host}`;
    }
    if (host && /^[a-z0-9.-]+(:\d+)?$/i.test(host)) {
      const proto = req.protocol === 'https' ? 'https' : 'http';
      return `${proto}://${host}`;
    }
  }
  return 'https://farizasterritory.com';
}

function csvEscape(val) {
  const s = String(val == null ? '' : val).replace(/\r?\n|\r/g, ' ').trim();
  if (s.includes(',') || s.includes('"') || s.includes(';')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function xmlEscape(val) {
  return String(val == null ? '' : val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function htmlAttrEscape(val) {
  return String(val == null ? '' : val)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function htmlTextEscape(val) {
  return String(val == null ? '' : val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function createRateLimiter(windowMs, maxRequests) {
  const buckets = new Map();
  return function rateLimiterMiddleware(req, res, next) {
    const rawIp = (req.ip || (req.socket && req.socket.remoteAddress) || '127.0.0.1').toString();
    const ip = rawIp.replace(/^::ffff:/i, '');
    const now = Date.now();
    if (buckets.size > 5000) {
      for (const [k, v] of buckets.entries()) {
        if (!v || now > v.resetAt) buckets.delete(k);
      }
    }
    const entry = buckets.get(ip);
    if (!entry || now > entry.resetAt) {
      buckets.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > maxRequests) {
      return res.status(429).json({
        ok: false,
        error: 'Too many requests from this IP. Please wait a moment and try again.'
      });
    }
    return next();
  };
}

function createApp(options = {}) {
  const app = express();
  const store = options.store || createSupabaseServerStore();
  const catalog = options.catalog || loadCatalogInMemory();
  const capiSender = options.capiSender || capiHandler.dispatchCapiEvent;
  const indexHtmlPath = path.join(__dirname, 'index.html');
  let cachedIndexTemplate = null;

  function getIndexTemplate() {
    if (!cachedIndexTemplate || process.env.NODE_ENV !== 'production') {
      cachedIndexTemplate = fs.readFileSync(indexHtmlPath, 'utf8');
    }
    return cachedIndexTemplate;
  }

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // Global security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Self-host pinned @supabase/supabase-js UMD client bundle cleanly
  let supabaseUmdPath = '';
  try {
    const pkgDir = path.dirname(require.resolve('@supabase/supabase-js/package.json'));
    supabaseUmdPath = path.join(pkgDir, 'dist/umd/supabase.js');
  } catch (_) {}

  app.get('/vendor/supabase.js', (req, res) => {
    if (!supabaseUmdPath || !fs.existsSync(supabaseUmdPath)) {
      return res.status(404).send('// Supabase UMD bundle unavailable');
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(supabaseUmdPath);
  });

  // Block internal docs, migrations, scripts, tests, dotfiles & repository metadata from public routes
  app.use(
    [
      '/docs',
      '/supabase',
      '/lib',
      '/scripts',
      '/tests',
      '/node_modules',
      '/.git',
      '/.github',
      '/.env',
      '/SOURCE_CONFLICTS_AND_UNKNOWN_FIELDS.md',
      '/README.md',
      '/package.json',
      '/package-lock.json',
      '/metadata.json'
    ],
    (req, res) => res.status(404).json({ ok: false, error: 'Resource not found.' })
  );

  // Block raw engineering docs, source audits, monolithic dumps, and JSON master dump on public asset routes
  app.use(['/assets/aistudio', '/public/assets/aistudio'], (req, res, next) => {
    const cleanRel = String(req.path || '').replace(/^\/+/, '');
    if (!cleanRel || !PUBLIC_ALLOWED_AISTUDIO_FILES.has(cleanRel)) {
      return res.status(404).json({ ok: false, error: 'Resource not found.' });
    }
    return next();
  });

  app.use('/assets/aistudio', express.static(path.join(__dirname, 'public/assets/aistudio'), {
    maxAge: '7d'
  }));
  app.use('/public/assets', express.static(path.join(__dirname, 'public/assets'), {
    maxAge: '7d'
  }));
  app.use('/assets', express.static(path.join(__dirname, 'assets'), {
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.webp') || filePath.endsWith('.jpg') || filePath.endsWith('.png')) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    }
  }));
  app.use(['/assets', '/public/assets'], (req, res) => {
    res.status(404).json({ ok: false, error: 'Asset not found.' });
  });

  async function buildMergedCatalog(opts = {}) {
    const includeArchived = Boolean(opts.includeArchived);
    const [dbCollections, dbProducts, dbAssets] = await Promise.all([
      typeof store.listCollections === 'function' ? store.listCollections() : null,
      store.listProducts(),
      typeof store.listProductAssets === 'function' ? store.listProductAssets() : null
    ]);

    const colMapBySlug = new Map();
    const baseCollections = Array.isArray(catalog.COLLECTIONS) ? catalog.COLLECTIONS : [];
    for (const c of baseCollections) {
      colMapBySlug.set(c.slug, Object.assign({}, c));
    }
    if (Array.isArray(dbCollections)) {
      dbCollections.forEach((row, idx) => {
        if (!row || !row.slug) return;
        const slug = String(row.slug).trim().toLowerCase();
        const existing = colMapBySlug.get(slug);
        if (existing) {
          colMapBySlug.set(slug, Object.assign({}, existing, {
            name: row.name || existing.name,
            nameBn: row.name_bn || existing.nameBn,
            leadEn: row.description || existing.leadEn,
            leadBn: row.description_bn || existing.leadBn,
            heroImage: row.hero_image || existing.heroImage,
            sortOrder: row.sort_order ?? existing.sortOrder ?? idx + 1,
            is_active: row.is_active !== false
          }));
        } else {
          const nextNum = String(colMapBySlug.size + 1).padStart(2, '0');
          colMapBySlug.set(slug, {
            id: `DB-${nextNum}`,
            slug,
            superCategory: row.name && /mirror|jewel|bangle/i.test(row.name) ? 'Accessories' : 'Fashion',
            name: row.name || slug,
            nameBn: row.name_bn || row.name || slug,
            leadEn: row.description || '',
            leadBn: row.description_bn || '',
            heroImage: row.hero_image || 'assets/products/CAT-001/main.webp',
            sortOrder: row.sort_order ?? colMapBySlug.size + 1,
            is_active: row.is_active !== false,
            isDbCustom: true
          });
        }
      });
    }

    const mergedCollections = Array.from(colMapBySlug.values())
      .filter(c => includeArchived || c.is_active !== false);

    const assetsBySku = new Map();
    if (Array.isArray(dbAssets)) {
      for (const a of dbAssets) {
        if (!a || !a.sku || !a.asset_key || !a.storage_path) continue;
        const sku = String(a.sku).toUpperCase();
        if (!assetsBySku.has(sku)) assetsBySku.set(sku, {});
        assetsBySku.get(sku)[a.asset_key] = a.storage_path;
      }
    }

    const dbMap = new Map();
    if (Array.isArray(dbProducts)) {
      for (const row of dbProducts) {
        if (row && row.sku) dbMap.set(String(row.sku).toUpperCase(), row);
      }
    }

    const baseProducts = Array.isArray(catalog.PRODUCTS) ? catalog.PRODUCTS : [];
    const baseSkus = new Set();

    const products = baseProducts.map(p => {
      baseSkus.add(p.sku);
      const dbRow = dbMap.get(p.sku);
      const dbSkuAssets = assetsBySku.get(p.sku) || {};
      const colObj = dbRow && dbRow.collection_slug && colMapBySlug.has(dbRow.collection_slug)
        ? colMapBySlug.get(dbRow.collection_slug)
        : p.collection;

      const stockCount = dbRow && dbRow.stock_count !== undefined && dbRow.stock_count !== null
        ? Number(dbRow.stock_count)
        : 5;
      const reservedCount = dbRow && dbRow.reserved_count !== undefined && dbRow.reserved_count !== null
        ? Number(dbRow.reserved_count)
        : 0;
      const mainImg = (dbRow && dbRow.main_image) || dbSkuAssets.main || (p.assets && p.assets.main) || '';
      const mergedAssets = Object.assign({}, p.assets || {}, dbSkuAssets, mainImg ? { main: mainImg } : {});

      const merged = Object.assign({}, p, {
        title: (dbRow && dbRow.title) || p.title,
        titleBn: (dbRow && dbRow.title_bn) || p.titleBn,
        collectionSlug: (dbRow && dbRow.collection_slug) || (colObj && colObj.slug) || '',
        collection: colObj,
        colId: colObj && colObj.id ? colObj.id : p.colId,
        superCategory: (colObj && colObj.superCategory) || p.superCategory,
        priceBDT: dbRow && Number(dbRow.price_bdt) > 0 ? Number(dbRow.price_bdt) : Number(p.priceBDT || 0),
        unit: (dbRow && dbRow.selling_unit) || p.unit,
        variants: dbRow && Array.isArray(dbRow.available_variants) && dbRow.available_variants.length
          ? dbRow.available_variants
          : p.variants,
        badge: dbRow && dbRow.badge !== null && dbRow.badge !== undefined ? dbRow.badge : p.badge,
        badgeBn: dbRow && dbRow.badge_bn !== null && dbRow.badge_bn !== undefined ? dbRow.badge_bn : p.badgeBn,
        material: (dbRow && dbRow.material) || p.material,
        color: (dbRow && dbRow.color) || p.color,
        care: (dbRow && dbRow.care) || p.care,
        descriptionEn: (dbRow && dbRow.description) || p.descriptionEn,
        alt: (dbRow && dbRow.alt) || p.alt,
        main_image: mainImg,
        assets: mergedAssets,
        is_available: dbRow && dbRow.is_available !== undefined ? Boolean(dbRow.is_available) : (p.is_available !== false),
        is_archived: dbRow && dbRow.is_archived !== undefined ? Boolean(dbRow.is_archived) : false,
        stock_count: stockCount,
        reserved_count: reservedCount,
        available_stock: Math.max(0, stockCount - reservedCount),
        stock_verified: dbRow && dbRow.stock_verified !== undefined ? Boolean(dbRow.stock_verified) : false,
        price_review: dbRow && dbRow.price_review !== undefined ? Boolean(dbRow.price_review) : (p.priceStatus !== 'approved'),
        approved_at: dbRow && dbRow.approved_at ? dbRow.approved_at : null
      });
      merged.feed_eligible = commerce.isFeedEligibleProduct(merged);
      return merged;
    });

    // Include newly authored DB-only SKUs from Admin CMS
    for (const [sku, dbRow] of dbMap.entries()) {
      if (baseSkus.has(sku)) continue;
      const dbSkuAssets = assetsBySku.get(sku) || {};
      const colSlug = String(dbRow.collection_slug || '').trim().toLowerCase();
      const colObj = colMapBySlug.get(colSlug) || mergedCollections[0] || {
        id: 'DB-01',
        slug: colSlug || 'boutique-new',
        name: colSlug || 'Boutique Arrivals',
        nameBn: 'নতুন কালেকশন',
        superCategory: 'Fashion'
      };
      const stockCount = dbRow.stock_count !== undefined && dbRow.stock_count !== null ? Number(dbRow.stock_count) : 0;
      const reservedCount = dbRow.reserved_count !== undefined && dbRow.reserved_count !== null ? Number(dbRow.reserved_count) : 0;
      const mainImg = dbRow.main_image || dbSkuAssets.main || 'assets/products/CAT-001/main.webp';
      const customProduct = {
        sku,
        colId: colObj.id || 'DB-01',
        collectionSlug: colObj.slug,
        collection: colObj,
        superCategory: colObj.superCategory || 'Fashion',
        title: dbRow.title || sku,
        titleBn: dbRow.title_bn || dbRow.title || sku,
        priceBDT: Number(dbRow.price_bdt || 0),
        priceStatus: dbRow.price_review === false ? 'approved' : 'pending_review',
        unit: dbRow.selling_unit || '1 pc',
        unitBn: dbRow.selling_unit || '১টি',
        variants: Array.isArray(dbRow.available_variants) && dbRow.available_variants.length ? dbRow.available_variants : ['Free Size'],
        badge: dbRow.badge || 'New Arrival',
        badgeBn: dbRow.badge_bn || 'নতুন',
        material: dbRow.material || 'Boutique Craft',
        color: dbRow.color || 'Artisan Shade',
        care: dbRow.care || 'Dry clean or gentle wipe recommended.',
        descriptionEn: dbRow.description || dbRow.title || sku,
        alt: dbRow.alt || dbRow.title || sku,
        main_image: mainImg,
        assets: Object.assign({ main: mainImg, socialSquare: dbSkuAssets.socialSquare || mainImg, storyReel: dbSkuAssets.storyReel || mainImg, hero16x9: dbSkuAssets.hero16x9 || mainImg }, dbSkuAssets),
        is_available: dbRow.is_available !== false,
        is_archived: Boolean(dbRow.is_archived),
        stock_count: stockCount,
        reserved_count: reservedCount,
        available_stock: Math.max(0, stockCount - reservedCount),
        stock_verified: Boolean(dbRow.stock_verified),
        price_review: dbRow.price_review !== undefined ? Boolean(dbRow.price_review) : true,
        approved_at: dbRow.approved_at || null,
        isDbCustom: true
      };
      customProduct.feed_eligible = commerce.isFeedEligibleProduct(customProduct);
      products.push(customProduct);
    }

    const visibleProducts = includeArchived ? products : products.filter(p => !p.is_archived);
    const productsBySku = {};
    for (const p of visibleProducts) {
      productsBySku[p.sku] = p;
    }

    return {
      collections: mergedCollections,
      products: visibleProducts,
      productsBySku
    };
  }

  async function requireAdminAuth(req, res, next) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await store.verifyAdminBearerToken(req.headers.authorization);
      if (!result.ok) {
        return res.status(result.status || 401).json({ ok: false, error: result.error || 'Unauthorized' });
      }
      req.adminUser = result.user;
      return next();
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'Authentication verification failed.' });
    }
  }

  function requireOwnerAdmin(req, res, next) {
    if (!req.adminUser || !commerce.hasRole(req.adminUser.role, 'admin')) {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden: Owner admin role is required for this sensitive operation.'
      });
    }
    return next();
  }

  async function writeAuditLog(req, action, targetType, targetId, beforeState, afterState, metadata) {
    if (typeof store.recordAuditLog !== 'function') return;
    await store.recordAuditLog({
      actor_id: req && req.adminUser ? req.adminUser.id : null,
      actor_email: req && req.adminUser ? req.adminUser.email : 'system',
      actor_role: req && req.adminUser ? req.adminUser.role : 'system',
      action,
      target_type: targetType,
      target_id: targetId,
      before_state: beforeState,
      after_state: afterState,
      metadata: metadata || {}
    });
  }

  async function processOutboxEvents(limit = 5, baseUrlOverride = '') {
    if (typeof store.claimDueCapiOutboxEvents !== 'function') {
      return { processed: 0, results: [] };
    }
    const claimed = await store.claimDueCapiOutboxEvents(limit);
    if (!claimed.ok || !Array.isArray(claimed.data) || claimed.data.length === 0) {
      return { processed: 0, results: [] };
    }
    const baseUrl = baseUrlOverride || getCanonicalBaseUrl(null);
    const results = [];
    for (const evt of claimed.data) {
      const p = evt.payload || {};
      const capiRes = await capiSender(
        Object.assign({}, p, {
          eventName: evt.event_name || p.eventName || 'Purchase',
          eventId: evt.event_id,
          eventSourceUrl: p.eventSourceUrl || `${baseUrl}/#/track`
        }),
        { allowPrivilegedEvents: true, allowTestCode: false }
      );
      const body = (capiRes && capiRes.body) || {};
      const delivered = Boolean(capiRes && capiRes.status < 400 && body.success === true && body.delivered === true && body.mode === 'live_production');
      if (typeof store.markCapiOutboxResult === 'function') {
        await store.markCapiOutboxResult(evt.event_id, {
          delivered,
          mode: body.mode || 'unknown',
          fbtrace_id: body.fbtrace_id || body.fb_trace_id || null,
          error: delivered ? null : (typeof body.error === 'string' ? body.error : JSON.stringify(body.error || body.message || 'Not delivered'))
        });
      }
      results.push({ event_id: evt.event_id, order_ref: evt.order_ref, delivered, mode: body.mode || 'unknown' });
    }
    return { processed: results.length, results };
  }

  if (options.enableOutboxWorker === true) {
    const workerTimer = setInterval(() => {
      processOutboxEvents(5).catch(err => console.error('[CAPI Outbox Worker]:', err.message));
    }, 60 * 1000);
    if (typeof workerTimer.unref === 'function') workerTimer.unref();
  }

  const orderCreateLimiter = createRateLimiter(10 * 60 * 1000, options.orderRateLimitMax || 25);
  const trackLimiter = createRateLimiter(10 * 60 * 1000, options.trackRateLimitMax || 40);
  const couponLimiter = createRateLimiter(10 * 60 * 1000, options.couponRateLimitMax || 60);

  // Meta Conversions API (CAPI) Endpoint (No unauthenticated Purchase / test_event_code)
  app.all('/api/capi', async (req, res) => {
    try {
      await capiHandler(req, res);
    } catch (err) {
      console.error('[CAPI Route Error]:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error', message: err.message });
      }
    }
  });

  // Safe Public Health Endpoint (no internal file URLs or secrets)
  app.get('/api/health', (req, res) => {
    const baseUrl = getCanonicalBaseUrl(req);
    const sbCfg = store.getConfigSummary ? store.getConfigSummary() : getSupabaseConfig();
    const resolvedPixelId = process.env.META_PIXEL_ID || process.env.META_DATASET_ID || '1657670575734647';
    const resolvedDatasetId = process.env.META_DATASET_ID || process.env.META_PIXEL_ID || '1657670575734647';
    res.status(200).json({
      ok: true,
      brand: "Fariza's Territory",
      location: 'Mirpur, Dhaka, Bangladesh',
      canonicalSiteUrl: baseUrl,
      catalog: {
        totalProducts: catalog.PRODUCTS.length,
        totalCollections: catalog.COLLECTIONS.length,
        fashionCount: catalog.PRODUCTS.filter(p => p.superCategory === 'Fashion').length,
        accessoriesCount: catalog.PRODUCTS.filter(p => p.superCategory === 'Accessories').length
      },
      databaseConfigured: store.isDurableConfigured ? store.isDurableConfigured() : false,
      supabaseAnonConfigured: Boolean(sbCfg && sbCfg.anonConfigured),
      metaCapiConfigured: Boolean(process.env.META_CAPI_ACCESS_TOKEN),
      datasetId: resolvedDatasetId,
      pixelId: resolvedPixelId,
      feeds: {
        metaCommerceCsv: `${baseUrl}/api/catalog-feed.csv`,
        googleMetaXml: `${baseUrl}/api/catalog-feed.xml`,
        jsonCatalog: `${baseUrl}/api/catalog-feed.json`,
        brandBookPdf: `${baseUrl}/assets/aistudio/fariza_s_territory_brand_book_by_pomelli_1e38cd9b.pdf`
      }
    });
  });

  // Public Storefront Configuration (hydrates Supabase URL/AnonKey + non-secret store settings)
  app.get('/api/public-config', async (req, res) => {
    const sbCfg = getSupabaseConfig();
    const settings = await store.getStoreSettings();
    const rawWa = settings && settings.whatsapp_number ? settings.whatsapp_number : '';
    const whatsappActive = !commerce.isPlaceholderWhatsapp(rawWa);
    const dhakaFee = Number((settings && settings.delivery_fee_dhaka) ?? commerce.DEFAULT_DELIVERY_FEES.dhaka);
    const outsideFee = Number((settings && settings.delivery_fee_outside) ?? commerce.DEFAULT_DELIVERY_FEES.outside_dhaka);
    const freeThreshold = Number((settings && settings.free_delivery_threshold) ?? commerce.DEFAULT_FREE_SHIPPING_THRESHOLD);
    const resolvedPixelId = (settings && settings.meta_pixel_id) || process.env.META_PIXEL_ID || process.env.META_DATASET_ID || '1657670575734647';
    const resolvedDatasetId = process.env.META_DATASET_ID || resolvedPixelId;

    res.status(200).json({
      ok: true,
      canonicalSiteUrl: getCanonicalBaseUrl(req),
      supabaseUrl: sbCfg.url,
      supabaseAnonKey: sbCfg.anonKey,
      databaseConfigured: store.isDurableConfigured ? store.isDurableConfigured() : false,
      metaDatasetId: resolvedDatasetId,
      metaPixelId: resolvedPixelId,
      ga4MeasurementId: (settings && settings.ga4_measurement_id) || '',
      deliveryFees: {
        dhaka: dhakaFee,
        outside_dhaka: outsideFee
      },
      freeShippingThreshold: freeThreshold,
      promoText: (settings && settings.promo_text) || 'First-order 25% OFF with code FIRST25 · Free delivery over ৳3,000 (FREESHIP)',
      officialChannels: {
        facebookPageUrl: (settings && settings.facebook_url) || 'https://www.facebook.com/farizasterritory143',
        messengerUsername: (settings && settings.messenger_username) || 'farizasterritory143',
        whatsappNumber: whatsappActive ? rawWa : '',
        whatsappActive
      }
    });
  });

  // Public merged catalog state (live prices, stock & dynamic CMS SKUs without PII)
  app.get('/api/catalog', async (req, res) => {
    const merged = await buildMergedCatalog({ includeArchived: false });
    res.status(200).json({
      ok: true,
      totalSkus: merged.products.length,
      collections: merged.collections,
      products: merged.products.map(p => ({
        sku: p.sku,
        colId: p.colId,
        collectionSlug: p.collectionSlug || (p.collection && p.collection.slug) || '',
        superCategory: p.superCategory,
        title: p.title,
        titleBn: p.titleBn,
        priceBDT: p.priceBDT,
        unit: p.unit,
        unitBn: p.unitBn,
        variants: p.variants,
        badge: p.badge,
        badgeBn: p.badgeBn,
        material: p.material,
        color: p.color,
        care: p.care,
        descriptionEn: p.descriptionEn,
        alt: p.alt,
        main_image: p.main_image,
        assets: p.assets,
        is_available: p.is_available,
        stock_count: p.stock_count,
        reserved_count: p.reserved_count || 0,
        available_stock: p.available_stock ?? p.stock_count,
        stock_verified: p.stock_verified,
        price_review: p.price_review,
        approved_at: p.approved_at || null,
        feed_eligible: p.feed_eligible,
        isDbCustom: Boolean(p.isDbCustom)
      }))
    });
  });

  // Server-side Coupon Validation
  app.post('/api/coupons/validate', couponLimiter, async (req, res) => {
    const body = req.body || {};
    const cleanCode = String(body.code || '').trim().toUpperCase();
    const subtotal = Number(body.subtotal || 0);
    const zone = commerce.normalizeZone(body.zone || body.delivery_zone || body.deliveryZone, body.district);
    if (!cleanCode) {
      return res.status(400).json({ valid: false, message: 'Please enter a coupon code.' });
    }
    const settings = await store.getStoreSettings();
    const deliveryFee = commerce.getDeliveryFeeForZone(zone, {
      dhaka: settings && settings.delivery_fee_dhaka,
      outside_dhaka: settings && settings.delivery_fee_outside
    });
    const coupon = await store.getCouponByCode(cleanCode);
    const result = commerce.evaluateCoupon(coupon, subtotal, deliveryFee);
    return res.status(200).json(result);
  });

  // Authoritative Order / Inquiry Creation Endpoint
  app.post('/api/orders', orderCreateLimiter, async (req, res) => {
    try {
      const body = req.body || {};
      const customerName = String(body.customer_name || body.name || '').trim();
      const rawPhone = String(body.customer_phone || body.phone || '').trim();
      const customerEmail = String(body.customer_email || body.email || '').trim();
      const district = String(body.customer_district || body.district || '').trim();
      const customerAddress = String(body.customer_address || body.address || '').trim();
      const contactChannel = String(body.contact_channel || body.contactChannel || 'web_form').trim();
      const notes = String(body.customer_notes || body.notes || '').trim().slice(0, 1000);
      const idempotencyKey = String(body.idempotency_key || req.get('x-idempotency-key') || '').trim().slice(0, 120) || null;

      if (customerName.length < 2 || customerName.length > 120) {
        return res.status(400).json({ ok: false, error: 'Please provide a valid full name (at least 2 characters).' });
      }

      const phoneInfo = commerce.normalizePhone(rawPhone);
      if (!phoneInfo.isBdMobile) {
        return res.status(400).json({
          ok: false,
          error: 'Please enter a valid 11-digit Bangladeshi mobile number (e.g., 017XXXXXXXX or +88017XXXXXXXX).'
        });
      }

      if (customerAddress.length < 5 || customerAddress.length > 500) {
        return res.status(400).json({ ok: false, error: 'Please provide a complete delivery street address.' });
      }

      const allowedPaymentMethods = ['Cash on Delivery (COD)', 'COD'];
      const requestedPayment = String(body.payment_method || body.paymentMethod || 'Cash on Delivery (COD)').trim();
      if (!allowedPaymentMethods.includes(requestedPayment)) {
        return res.status(400).json({ ok: false, error: 'Only Cash on Delivery (COD) is currently supported.' });
      }

      const merged = await buildMergedCatalog();
      const settings = await store.getStoreSettings();
      const deliveryFees = {
        dhaka: settings && settings.delivery_fee_dhaka,
        outside_dhaka: settings && settings.delivery_fee_outside
      };

      const requestedCoupon = String(body.discount_code || body.discountCode || '').trim().toUpperCase();
      let couponObj = null;
      if (requestedCoupon) {
        couponObj = await store.getCouponByCode(requestedCoupon);
        if (!couponObj || !couponObj.is_active) {
          return res.status(400).json({ ok: false, error: `Coupon code '${requestedCoupon}' is invalid or inactive.` });
        }
      }

      const computed = commerce.computeOrderTotals({
        items: body.items,
        productsBySku: merged.productsBySku,
        zone: body.delivery_zone || body.deliveryZone,
        district,
        deliveryFees,
        coupon: couponObj
      });

      if (!computed.ok) {
        return res.status(computed.status || 400).json({ ok: false, code: computed.code || 'VALIDATION_ERROR', error: computed.error });
      }

      // Generate server-authoritative order reference (or accept safe well-formed client ref if unique)
      const orderRef = commerce.generateOrderRef();
      const nowIso = new Date().toISOString();
      const fullAddress = district && !customerAddress.toLowerCase().includes(district.toLowerCase())
        ? `${district}, ${customerAddress}`
        : customerAddress;

      const orderRecord = {
        order_ref: orderRef,
        customer_name: customerName,
        customer_phone: phoneInfo.canonical11,
        customer_email: customerEmail || null,
        customer_district: district || (computed.delivery_zone === 'dhaka' ? 'Dhaka' : 'Outside Dhaka'),
        customer_address: fullAddress,
        delivery_zone: computed.delivery_zone,
        delivery_fee: computed.delivery_fee,
        subtotal: computed.subtotal,
        discount_code: computed.discount_code,
        discount_amount: computed.discount_amount,
        total: computed.total,
        payment_method: 'Cash on Delivery (COD)',
        contact_channel: ['web_form', 'messenger', 'whatsapp'].includes(contactChannel) ? contactChannel : 'web_form',
        items: computed.items,
        status: 'pending',
        courier_name: 'Steadfast Courier',
        tracking_number: '',
        customer_notes: notes,
        status_history: [
          {
            status: 'pending',
            note: computed.requires_manual_stock_confirmation
              ? 'Order inquiry registered — pending manual seller stock confirmation'
              : 'Order inquiry registered with server-verified totals & inventory reservation',
            time: nowIso
          }
        ],
        source: 'web_store',
        attribution: body.attribution && typeof body.attribution === 'object' ? body.attribution : null,
        idempotency_key: idempotencyKey,
        created_at: nowIso,
        updated_at: nowIso
      };

      const saved = await store.createOrder(orderRecord);
      if (!saved.ok) {
        return res.status(saved.status || 503).json({ ok: false, error: saved.error });
      }

      const redacted = commerce.redactOrderForPublicTracking(saved.data);
      redacted.payment_method = saved.data.payment_method || 'Cash on Delivery (COD)';
      redacted.requires_manual_stock_confirmation = Boolean(computed.requires_manual_stock_confirmation);

      return res.status(saved.idempotent ? 200 : 201).json({
        ok: true,
        idempotent: Boolean(saved.idempotent),
        requires_manual_stock_confirmation: Boolean(computed.requires_manual_stock_confirmation),
        order_ref: saved.data.order_ref,
        order: redacted
      });
    } catch (err) {
      console.error('[Order Create Error]:', err);
      return res.status(500).json({ ok: false, error: 'Failed to process order inquiry.' });
    }
  });

  // Challenge-Protected Public Order Tracking Endpoint (Requires BOTH Order Ref + Matching Phone)
  async function handlePublicTrack(req, res) {
    const input = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const rawRef = String(input.ref || input.order_ref || input.orderRef || '').trim().toUpperCase();
    const rawPhone = String(input.phone || input.customer_phone || '').trim();

    if (!rawRef || !rawPhone) {
      return res.status(400).json({
        ok: false,
        error: 'Both Order Reference and Phone Number are required to view order status.'
      });
    }

    const phoneInfo = commerce.normalizePhone(rawPhone);
    if (!phoneInfo.valid) {
      return res.status(400).json({
        ok: false,
        error: 'Please enter a valid 11-digit phone number associated with the order.'
      });
    }

    const found = await store.getOrderByRef(rawRef);
    if (!found.ok && found.status === 503) {
      return res.status(503).json({ ok: false, error: found.error });
    }
    if (!found.ok || !found.data || !commerce.phonesMatch(found.data.customer_phone, rawPhone)) {
      return res.status(404).json({
        ok: false,
        error: 'No matching order found for the provided Order Reference and Phone Number.'
      });
    }

    return res.status(200).json({
      ok: true,
      order: commerce.redactOrderForPublicTracking(found.data)
    });
  }

  app.get('/api/track', trackLimiter, handlePublicTrack);
  app.post('/api/track', trackLimiter, handlePublicTrack);

  // =========================================================================
  // AUTHENTICATED ADMIN & STAFF PORTAL APIs (/api/auth/session & /api/admin/*)
  // =========================================================================
  app.get('/api/auth/session', requireAdminAuth, (req, res) => {
    res.status(200).json({ ok: true, user: req.adminUser });
  });

  app.get('/api/admin/orders', requireAdminAuth, async (req, res) => {
    const status = String(req.query.status || 'all').trim();
    const result = await store.listOrders({ status });
    if (!result.ok) {
      return res.status(result.status || 500).json({ ok: false, error: result.error });
    }
    return res.status(200).json({ ok: true, orders: result.data });
  });

  app.post('/api/admin/orders', requireAdminAuth, async (req, res) => {
    const body = req.body || {};
    const customerName = String(body.customer_name || body.name || '').trim();
    const phoneInfo = commerce.normalizePhone(body.customer_phone || body.phone || '');
    const customerAddress = String(body.customer_address || body.address || '').trim();
    const district = String(body.customer_district || body.district || '').trim();
    if (customerName.length < 2 || !phoneInfo.isBdMobile || customerAddress.length < 4) {
      return res.status(400).json({ ok: false, error: 'Valid name, Bangladeshi mobile, and address are required.' });
    }
    const merged = await buildMergedCatalog();
    const settings = await store.getStoreSettings();
    const requestedCoupon = String(body.discount_code || body.discountCode || '').trim().toUpperCase();
    let couponObj = null;
    if (requestedCoupon) {
      couponObj = await store.getCouponByCode(requestedCoupon);
      if (!couponObj || !couponObj.is_active) {
        return res.status(400).json({ ok: false, error: `Coupon code '${requestedCoupon}' is invalid or inactive.` });
      }
    }
    const computed = commerce.computeOrderTotals({
      items: body.items,
      productsBySku: merged.productsBySku,
      zone: body.delivery_zone || body.deliveryZone,
      district,
      deliveryFees: {
        dhaka: settings && settings.delivery_fee_dhaka,
        outside_dhaka: settings && settings.delivery_fee_outside
      },
      coupon: couponObj
    });
    if (!computed.ok) {
      return res.status(computed.status || 400).json({ ok: false, error: computed.error });
    }
    const nowIso = new Date().toISOString();
    const fullAddress = district && !customerAddress.toLowerCase().includes(district.toLowerCase())
      ? `${district}, ${customerAddress}`
      : customerAddress;
    const orderRecord = {
      order_ref: commerce.generateOrderRef(),
      customer_name: customerName,
      customer_phone: phoneInfo.canonical11,
      customer_district: district || (computed.delivery_zone === 'dhaka' ? 'Dhaka' : 'Outside Dhaka'),
      customer_address: fullAddress,
      delivery_zone: computed.delivery_zone,
      delivery_fee: computed.delivery_fee,
      subtotal: computed.subtotal,
      discount_code: computed.discount_code,
      discount_amount: computed.discount_amount,
      total: computed.total,
      payment_method: 'Cash on Delivery (COD)',
      contact_channel: body.contact_channel || 'messenger',
      items: computed.items,
      status: 'pending',
      courier_name: body.courier_name || 'Steadfast Courier',
      tracking_number: '',
      customer_notes: String(body.customer_notes || body.notes || '').slice(0, 1000),
      status_history: [{ status: 'pending', note: `Created by ${req.adminUser.email}`, time: nowIso }],
      source: 'admin_manual',
      created_at: nowIso,
      updated_at: nowIso
    };
    const saved = await store.createOrder(orderRecord);
    if (!saved.ok) {
      return res.status(saved.status || 500).json({ ok: false, error: saved.error });
    }
    await writeAuditLog(req, 'order.manual_create', 'order', saved.data.order_ref, null, saved.data);
    return res.status(201).json({ ok: true, order: saved.data });
  });

  app.patch('/api/admin/orders/:orderRef', requireAdminAuth, async (req, res) => {
    const orderRef = String(req.params.orderRef || '').trim();
    const body = req.body || {};
    const current = await store.getOrderByRef(orderRef);
    if (!current.ok) {
      return res.status(current.status || 404).json({ ok: false, error: current.error || 'Order not found.' });
    }

    const existing = current.data;
    const patch = {};
    const history = Array.isArray(existing.status_history) ? [...existing.status_history] : [];
    let transitionedToConfirmed = false;

    if (body.status !== undefined) {
      const nextStatus = String(body.status).trim().toLowerCase();
      if (!commerce.isValidStatusTransition(existing.status, nextStatus)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid status transition from '${existing.status}' to '${nextStatus}'.`
        });
      }
      if (nextStatus !== existing.status) {
        patch.status = nextStatus;
        history.push({
          status: nextStatus,
          note: String(body.note || `Updated to ${nextStatus} by ${req.adminUser.email}`).slice(0, 300),
          actor: req.adminUser.email,
          time: new Date().toISOString()
        });
        patch.status_history = history;
        if (nextStatus === 'confirmed') {
          transitionedToConfirmed = true;
        }
      }
    }

    if (body.courier_name !== undefined) patch.courier_name = String(body.courier_name).trim().slice(0, 100);
    if (body.tracking_number !== undefined) patch.tracking_number = String(body.tracking_number).trim().slice(0, 120);
    if (body.customer_notes !== undefined) patch.customer_notes = String(body.customer_notes).trim().slice(0, 1000);
    if (body.customer_address !== undefined) patch.customer_address = String(body.customer_address).trim().slice(0, 500);

    const updated = typeof store.transitionOrder === 'function'
      ? await store.transitionOrder(orderRef, patch)
      : await store.updateOrder(orderRef, patch);
    if (!updated.ok) {
      return res.status(updated.status || 500).json({ ok: false, error: updated.error });
    }

    await writeAuditLog(
      req,
      patch.status ? `order.status.${patch.status}` : 'order.update',
      'order',
      orderRef,
      { status: existing.status, courier_name: existing.courier_name, tracking_number: existing.tracking_number },
      { status: updated.data.status, courier_name: updated.data.courier_name, tracking_number: updated.data.tracking_number }
    );

    let capiResult = null;
    let outboxRecord = null;
    if (transitionedToConfirmed && !existing.purchase_capi_sent_at) {
      const baseUrl = getCanonicalBaseUrl(req);
      const purchaseEventId = `pur_${orderRef}`;
      const capiParams = {
        eventName: 'Purchase',
        eventId: purchaseEventId,
        eventSourceUrl: `${baseUrl}/#/track`,
        userData: {
          name: existing.customer_name,
          phone: existing.customer_phone,
          email: existing.customer_email,
          district: existing.customer_district || 'Dhaka'
        },
        customData: {
          currency: 'BDT',
          value: Number(existing.total || 0),
          order_id: orderRef,
          content_type: 'product',
          content_ids: Array.isArray(existing.items) ? existing.items.map(i => i.sku) : [],
          num_items: Array.isArray(existing.items) ? existing.items.reduce((s, i) => s + Number(i.qty || 1), 0) : 1
        }
      };

      if (typeof store.enqueueCapiOutboxEvent === 'function') {
        const enq = await store.enqueueCapiOutboxEvent({
          event_id: purchaseEventId,
          event_name: 'Purchase',
          order_ref: orderRef,
          payload: capiParams
        });
        if (enq && enq.ok) outboxRecord = enq.data;
      }

      try {
        capiResult = await capiSender(capiParams, { allowPrivilegedEvents: true, allowTestCode: false });
        const bodyOut = (capiResult && capiResult.body) || {};
        const deliveredToMeta = Boolean(
          capiResult &&
          capiResult.status < 400 &&
          bodyOut.success === true &&
          bodyOut.delivered === true &&
          bodyOut.mode === 'live_production'
        );

        if (typeof store.markCapiOutboxResult === 'function') {
          const marked = await store.markCapiOutboxResult(purchaseEventId, {
            delivered: deliveredToMeta,
            mode: bodyOut.mode || 'unknown',
            fbtrace_id: bodyOut.fbtrace_id || bodyOut.fb_trace_id || null,
            error: deliveredToMeta ? null : (typeof bodyOut.error === 'string' ? bodyOut.error : (bodyOut.message || 'Not delivered to Meta'))
          });
          if (marked && marked.ok) outboxRecord = marked.data;
        }

        if (deliveredToMeta) {
          const sentAt = new Date().toISOString();
          await store.updateOrder(orderRef, {
            purchase_capi_sent_at: sentAt,
            purchase_capi_event_id: purchaseEventId
          });
          updated.data.purchase_capi_sent_at = sentAt;
          updated.data.purchase_capi_event_id = purchaseEventId;
        }
      } catch (err) {
        capiResult = { status: 500, body: { success: false, delivered: false, error: err.message } };
        if (typeof store.markCapiOutboxResult === 'function') {
          const marked = await store.markCapiOutboxResult(purchaseEventId, {
            delivered: false,
            mode: 'error',
            error: err.message
          });
          if (marked && marked.ok) outboxRecord = marked.data;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      order: updated.data,
      capi_purchase: capiResult ? capiResult.body : null,
      capi_outbox: outboxRecord
    });
  });

  app.get('/api/admin/catalog', requireAdminAuth, async (req, res) => {
    const merged = await buildMergedCatalog({ includeArchived: true });
    return res.status(200).json({ ok: true, collections: merged.collections, products: merged.products });
  });

  app.post('/api/admin/collections', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    if (typeof store.upsertCollection !== 'function') {
      return res.status(503).json({ ok: false, error: 'Collection CMS store not configured.' });
    }
    const body = req.body || {};
    const slug = String(body.slug || '').trim().toLowerCase();
    const name = String(body.name || '').trim();
    if (!/^[a-z0-9-]{2,48}$/.test(slug) || name.length < 2) {
      return res.status(400).json({ ok: false, error: 'Valid lowercase slug (a-z0-9-) and collection name are required.' });
    }
    const saved = await store.upsertCollection({
      slug,
      name,
      name_bn: body.name_bn || body.nameBn || null,
      description: body.description || body.leadEn || null,
      description_bn: body.description_bn || body.leadBn || null,
      hero_image: body.hero_image || body.heroImage || null,
      sort_order: body.sort_order,
      is_active: body.is_active !== false
    });
    if (!saved.ok) return res.status(saved.status || 500).json({ ok: false, error: saved.error });
    await writeAuditLog(req, 'collection.upsert', 'collection', slug, null, saved.data);
    return res.status(201).json({ ok: true, collection: saved.data });
  });

  app.patch('/api/admin/collections/:slug', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    if (typeof store.upsertCollection !== 'function') {
      return res.status(503).json({ ok: false, error: 'Collection CMS store not configured.' });
    }
    const slug = String(req.params.slug || '').trim().toLowerCase();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!/^[a-z0-9-]{2,48}$/.test(slug) || name.length < 2) {
      return res.status(400).json({ ok: false, error: 'Valid slug and collection name are required.' });
    }
    const saved = await store.upsertCollection(Object.assign({}, body, { slug, name }));
    if (!saved.ok) return res.status(saved.status || 500).json({ ok: false, error: saved.error });
    await writeAuditLog(req, 'collection.update', 'collection', slug, null, saved.data);
    return res.status(200).json({ ok: true, collection: saved.data });
  });

  app.post('/api/admin/products', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    if (typeof store.createProduct !== 'function') {
      return res.status(503).json({ ok: false, error: 'Product CMS creation is not supported by current store.' });
    }
    const body = req.body || {};
    const sku = String(body.sku || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,32}$/.test(sku)) {
      return res.status(400).json({ ok: false, error: 'SKU must be 3-32 uppercase alphanumeric/hyphen characters.' });
    }
    const title = String(body.title || '').trim();
    const price = Number(body.price_bdt ?? body.priceBDT ?? 0);
    if (title.length < 2 || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ ok: false, error: 'Valid title and positive price_bdt are required.' });
    }
    const stockCount = Number(body.stock_count ?? 0);
    if (!Number.isInteger(stockCount) || stockCount < 0) {
      return res.status(400).json({ ok: false, error: 'stock_count must be a non-negative integer.' });
    }
    const merged = await buildMergedCatalog({ includeArchived: true });
    if (merged.productsBySku[sku]) {
      return res.status(409).json({ ok: false, error: `SKU ${sku} already exists.` });
    }
    const colSlug = String(body.collection_slug || (merged.collections[0] && merged.collections[0].slug) || '').trim().toLowerCase();
    const created = await store.createProduct(
      {
        sku,
        collection_slug: colSlug,
        title,
        title_bn: body.title_bn || body.titleBn || null,
        price_bdt: Math.round(price),
        is_available: body.is_available !== false,
        stock_count: stockCount,
        stock_verified: Boolean(body.stock_verified),
        price_review: body.price_review !== undefined ? Boolean(body.price_review) : true,
        selling_unit: body.selling_unit || body.unit || '1 pc',
        available_variants: Array.isArray(body.available_variants)
          ? body.available_variants
          : (typeof body.variants === 'string'
            ? body.variants.split(',').map(v => v.trim()).filter(Boolean)
            : ['Free Size']),
        badge: body.badge || null,
        badge_bn: body.badge_bn || null,
        material: body.material || null,
        color: body.color || null,
        care: body.care || null,
        description: body.description || body.descriptionEn || null,
        alt: body.alt || title,
        main_image: body.main_image || null,
        is_archived: Boolean(body.is_archived)
      },
      req.adminUser.email
    );
    if (!created.ok) return res.status(created.status || 500).json({ ok: false, error: created.error });
    await writeAuditLog(req, 'product.create', 'product', sku, null, created.data);
    return res.status(201).json({ ok: true, product: created.data });
  });

  app.patch('/api/admin/products/:sku', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    const sku = String(req.params.sku || '').trim().toUpperCase();
    const merged = await buildMergedCatalog({ includeArchived: true });
    if (!merged.productsBySku[sku]) {
      return res.status(404).json({ ok: false, error: `Unknown SKU: ${sku}` });
    }
    const body = req.body || {};
    const updates = {};
    if (body.price_bdt !== undefined) {
      const price = Number(body.price_bdt);
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ ok: false, error: 'price_bdt must be greater than 0.' });
      }
      updates.price_bdt = Math.round(price);
    }
    if (body.is_available !== undefined) updates.is_available = Boolean(body.is_available);
    if (body.is_archived !== undefined) updates.is_archived = Boolean(body.is_archived);
    if (body.stock_count !== undefined) {
      const count = Number(body.stock_count);
      if (!Number.isInteger(count) || count < 0) {
        return res.status(400).json({ ok: false, error: 'stock_count must be a non-negative integer.' });
      }
      updates.stock_count = count;
    }
    if (body.stock_verified !== undefined) updates.stock_verified = Boolean(body.stock_verified);
    if (body.price_review !== undefined) updates.price_review = Boolean(body.price_review);

    const optTextFields = [
      'title',
      'title_bn',
      'collection_slug',
      'selling_unit',
      'badge',
      'badge_bn',
      'material',
      'color',
      'care',
      'description',
      'alt',
      'main_image'
    ];
    for (const f of optTextFields) {
      if (body[f] !== undefined) updates[f] = body[f];
    }
    if (body.available_variants !== undefined) {
      updates.available_variants = Array.isArray(body.available_variants)
        ? body.available_variants
        : String(body.available_variants).split(',').map(v => v.trim()).filter(Boolean);
    }

    const updated = await store.updateProduct(sku, updates, req.adminUser.email);
    if (!updated.ok) {
      return res.status(updated.status || 500).json({ ok: false, error: updated.error });
    }
    await writeAuditLog(req, 'product.update', 'product', sku, updated.previous || null, updated.data);
    return res.status(200).json({ ok: true, product: updated.data });
  });

  app.post(
    '/api/admin/products/:sku/media',
    express.json({ limit: '6mb' }),
    requireAdminAuth,
    requireOwnerAdmin,
    async (req, res) => {
      const sku = String(req.params.sku || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{3,32}$/.test(sku)) {
        return res.status(400).json({ ok: false, error: 'Invalid SKU format.' });
      }
      const merged = await buildMergedCatalog({ includeArchived: true });
      if (!merged.productsBySku[sku]) {
        return res.status(404).json({ ok: false, error: `Unknown SKU: ${sku}` });
      }
      const body = req.body || {};
      const assetKey = String(body.asset_key || 'main').trim();
      if (!ALLOWED_MEDIA_ASSET_KEYS.has(assetKey)) {
        return res.status(400).json({ ok: false, error: 'Unsupported asset_key.' });
      }
      const parsedImg = parseDataUrlImage(body.data_url || body.dataUrl);
      if (!parsedImg.ok) {
        return res.status(400).json({ ok: false, error: parsedImg.error });
      }

      let storedUrl = '';
      if (typeof store.uploadMediaToStorage === 'function' && store.isDurableConfigured && store.isDurableConfigured()) {
        const up = await store.uploadMediaToStorage({
          sku,
          assetKey,
          buffer: parsedImg.buffer,
          mimeType: parsedImg.mimeType,
          ext: parsedImg.ext
        });
        if (up && up.ok && up.url) storedUrl = up.url;
      }

      if (!storedUrl) {
        const safeRelDir = path.join('assets', 'uploads', sku);
        const absDir = path.join(__dirname, safeRelDir);
        fs.mkdirSync(absDir, { recursive: true });
        const filename = `${assetKey}-${Date.now()}.${parsedImg.ext}`;
        fs.writeFileSync(path.join(absDir, filename), parsedImg.buffer);
        storedUrl = `/${safeRelDir.replace(/\\/g, '/')}/${filename}`;
      }

      let assetRow = { sku, asset_key: assetKey, storage_path: storedUrl };
      if (typeof store.upsertProductAsset === 'function') {
        const savedAsset = await store.upsertProductAsset({
          sku,
          asset_key: assetKey,
          storage_path: storedUrl,
          sort_order: assetKey === 'main' ? 0 : 10
        });
        if (savedAsset && savedAsset.ok) assetRow = savedAsset.data;
      }
      await writeAuditLog(req, 'product.media_upload', 'product', sku, null, assetRow);
      return res.status(201).json({ ok: true, asset: assetRow, url: storedUrl });
    }
  );

  app.get('/api/admin/coupons', requireAdminAuth, async (req, res) => {
    const result = await store.listCoupons();
    if (!result.ok) {
      return res.status(result.status || 500).json({ ok: false, error: result.error });
    }
    return res.status(200).json({ ok: true, coupons: result.data });
  });

  app.post('/api/admin/coupons', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    const body = req.body || {};
    const code = String(body.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
      return res.status(400).json({ ok: false, error: 'Coupon code must be 3-24 uppercase alphanumeric characters.' });
    }
    const discountType = String(body.discount_type || '').trim();
    if (!['percentage', 'fixed', 'free_shipping'].includes(discountType)) {
      return res.status(400).json({ ok: false, error: 'Invalid discount_type.' });
    }
    const discountValue = Number(body.discount_value ?? 0);
    if (!Number.isFinite(discountValue) || discountValue < 0) {
      return res.status(400).json({ ok: false, error: 'discount_value must be a non-negative number.' });
    }
    if (discountType === 'percentage' && (discountValue <= 0 || discountValue > 100)) {
      return res.status(400).json({ ok: false, error: 'Percentage coupon discount_value must be between 1 and 100.' });
    }
    if (discountType === 'fixed' && discountValue <= 0) {
      return res.status(400).json({ ok: false, error: 'Fixed coupon discount_value must be greater than 0.' });
    }
    const minSpend = Number(body.min_spend ?? 0);
    if (!Number.isFinite(minSpend) || minSpend < 0) {
      return res.status(400).json({ ok: false, error: 'min_spend must be a non-negative number.' });
    }
    let maxDiscount = null;
    if (body.max_discount !== undefined && body.max_discount !== null && body.max_discount !== '') {
      const parsedMax = Number(body.max_discount);
      if (!Number.isFinite(parsedMax) || parsedMax < 0) {
        return res.status(400).json({ ok: false, error: 'max_discount must be a non-negative number.' });
      }
      maxDiscount = parsedMax;
    }
    const coupon = {
      code,
      discount_type: discountType,
      discount_value: discountValue,
      min_spend: minSpend,
      max_discount: maxDiscount,
      is_active: body.is_active !== false,
      notes: String(body.notes || '').slice(0, 200)
    };
    const saved = await store.upsertCoupon(coupon);
    if (!saved.ok) {
      return res.status(saved.status || 500).json({ ok: false, error: saved.error });
    }
    await writeAuditLog(req, 'coupon.upsert', 'coupon', code, null, saved.data);
    return res.status(200).json({ ok: true, coupon: saved.data });
  });

  app.get('/api/admin/settings', requireAdminAuth, async (req, res) => {
    const settings = await store.getStoreSettings();
    return res.status(200).json({ ok: true, settings: settings || {} });
  });

  app.put('/api/admin/settings', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    const body = req.body || {};
    const prev = await store.getStoreSettings();
    for (const numField of ['delivery_fee_dhaka', 'delivery_fee_outside', 'free_delivery_threshold']) {
      if (body[numField] !== undefined && body[numField] !== null && body[numField] !== '') {
        const val = Number(body[numField]);
        if (!Number.isFinite(val) || val < 0) {
          return res.status(400).json({ ok: false, error: `${numField} must be a non-negative number.` });
        }
      }
    }
    if (body.facebook_url !== undefined && String(body.facebook_url || '').trim() !== '') {
      const fbUrl = String(body.facebook_url).trim();
      if (!/^https?:\/\//i.test(fbUrl)) {
        return res.status(400).json({ ok: false, error: 'facebook_url must start with http:// or https://.' });
      }
    }
    const saved = await store.updateStoreSettings(body);
    if (!saved.ok) {
      return res.status(saved.status || 500).json({ ok: false, error: saved.error });
    }
    await writeAuditLog(req, 'settings.update', 'store_settings', 'default', prev, saved.data);
    return res.status(200).json({ ok: true, settings: saved.data });
  });

  app.post('/api/admin/capi-test', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    const body = req.body || {};
    const baseUrl = getCanonicalBaseUrl(req);
    const result = await capiSender(
      {
        eventName: body.eventName || 'Lead',
        eventId: body.eventId || `adm_test_${Date.now()}`,
        eventSourceUrl: body.eventSourceUrl || `${baseUrl}/`,
        userData: body.userData || { district: 'Dhaka' },
        customData: body.customData || { currency: 'BDT', value: 2350, content_ids: ['CAT-001'] },
        test_event_code: body.test_event_code || process.env.META_TEST_EVENT_CODE || ''
      },
      { allowPrivilegedEvents: true, allowTestCode: true }
    );
    await writeAuditLog(req, 'capi.test_dispatch', 'capi', result && result.body ? result.body.event_id : null, null, result && result.body);
    return res.status(result.status).json(result.body);
  });

  app.get('/api/admin/capi-outbox', requireAdminAuth, async (req, res) => {
    if (typeof store.listCapiOutbox !== 'function') {
      return res.status(200).json({ ok: true, events: [] });
    }
    const result = await store.listCapiOutbox(Number(req.query.limit || 100));
    if (!result.ok) {
      return res.status(result.status || 500).json({ ok: false, error: result.error });
    }
    return res.status(200).json({ ok: true, events: result.data });
  });

  app.post('/api/admin/capi-outbox/process', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    const baseUrl = getCanonicalBaseUrl(req);
    const out = await processOutboxEvents(Number((req.body && req.body.limit) || 10), baseUrl);
    await writeAuditLog(req, 'capi.outbox_process', 'capi_outbox', 'batch', null, out);
    return res.status(200).json({ ok: true, processed: out.processed, results: out.results });
  });

  app.post('/api/admin/capi-outbox/:eventId/retry', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    if (typeof store.resetCapiOutboxForRetry !== 'function') {
      return res.status(503).json({ ok: false, error: 'CAPI outbox retry unsupported on store.' });
    }
    const eventId = String(req.params.eventId || '').trim();
    const reset = await store.resetCapiOutboxForRetry(eventId);
    if (!reset.ok) {
      return res.status(reset.status || 500).json({ ok: false, error: reset.error });
    }
    if (reset.alreadySent) {
      return res.status(200).json({ ok: true, alreadySent: true, event: reset.data });
    }
    const out = await processOutboxEvents(5, getCanonicalBaseUrl(req));
    await writeAuditLog(req, 'capi.outbox_manual_retry', 'capi_outbox', eventId, null, out);
    const listRes = typeof store.listCapiOutbox === 'function' ? await store.listCapiOutbox(100) : { data: [] };
    const latest = (listRes.data || []).find(e => e.event_id === eventId) || reset.data;
    return res.status(200).json({ ok: true, event: latest, results: out.results });
  });

  app.get('/api/admin/staff', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    if (typeof store.listStaffUsers !== 'function') {
      return res.status(200).json({ ok: true, staff: [] });
    }
    const result = await store.listStaffUsers();
    if (!result.ok) return res.status(result.status || 500).json({ ok: false, error: result.error });
    return res.status(200).json({ ok: true, staff: result.data });
  });

  app.post('/api/admin/staff', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    if (typeof store.upsertStaffUser !== 'function') {
      return res.status(503).json({ ok: false, error: 'Staff management unsupported on store.' });
    }
    const body = req.body || {};
    const userId = String(body.user_id || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || 'staff').trim().toLowerCase();
    if (!userId || !email.includes('@') || !['admin', 'staff'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'Valid user_id, email, and role (admin|staff) are required.' });
    }
    const saved = await store.upsertStaffUser({
      user_id: userId,
      email,
      full_name: body.full_name || null,
      role,
      is_active: body.is_active !== false
    });
    if (!saved.ok) return res.status(saved.status || 500).json({ ok: false, error: saved.error });
    await writeAuditLog(req, 'staff.upsert', 'staff_user', userId, null, saved.data);
    return res.status(200).json({ ok: true, staff: saved.data });
  });

  app.get('/api/admin/audit-logs', requireAdminAuth, requireOwnerAdmin, async (req, res) => {
    if (typeof store.listAuditLogs !== 'function') {
      return res.status(200).json({ ok: true, logs: [] });
    }
    const result = await store.listAuditLogs(Number(req.query.limit || 100));
    if (!result.ok) return res.status(result.status || 500).json({ ok: false, error: result.error });
    return res.status(200).json({ ok: true, logs: result.data });
  });

  app.get('/api/admin/catalog-feed-preview.json', requireAdminAuth, async (req, res) => {
    const merged = await buildMergedCatalog();
    return res.status(200).json({
      ok: true,
      totalSkus: merged.products.length,
      eligibleCount: merged.products.filter(p => p.feed_eligible).length,
      products: merged.products.map(p => ({
        sku: p.sku,
        title: p.title,
        priceBDT: p.priceBDT,
        is_available: p.is_available,
        stock_verified: p.stock_verified,
        price_review: p.price_review,
        feed_eligible: p.feed_eligible
      }))
    });
  });

  // =========================================================================
  // MARKETING FEEDS (Strictly gated by stock_verified & approved pricing)
  // =========================================================================
  app.get('/api/catalog-feed.csv', async (req, res) => {
    const baseUrl = getCanonicalBaseUrl(req);
    const merged = await buildMergedCatalog();
    const eligible = merged.products.filter(p => commerce.isFeedEligibleProduct(p));

    const headers = [
      'id',
      'title',
      'description',
      'availability',
      'condition',
      'price',
      'link',
      'image_link',
      'additional_image_link',
      'brand',
      'item_group_id',
      'google_product_category',
      'custom_label_0',
      'custom_label_1',
      'custom_label_2',
      'custom_label_3'
    ];

    const rows = [headers.join(',')];
    for (const p of eligible) {
      const colName = p.collection ? p.collection.name : p.superCategory;
      const unitDisclosure = p.unit ? ` [Selling Unit: ${p.unit}]` : '';
      const cautionDisclosure = p.cautionEn ? ` (${p.cautionEn})` : '';
      const fullDesc = `${p.descriptionEn || p.title}${unitDisclosure}${cautionDisclosure} — ${p.titleBn || ''}`.trim();
      const productLink = `${baseUrl}/products/${encodeURIComponent(p.sku)}`;
      const mainImage = toAbsoluteMediaUrl(baseUrl, p.assets?.socialSquare || p.assets?.main || '');
      const altImage = p.assets?.storyReel ? toAbsoluteMediaUrl(baseUrl, p.assets.storyReel) : '';
      const googleCategory = p.superCategory === 'Fashion'
        ? 'Apparel & Accessories > Clothing > Traditional & Ceremonial Clothing'
        : (p.colId === '06'
          ? 'Home & Garden > Decor > Mirrors'
          : 'Apparel & Accessories > Jewelry');

      rows.push([
        csvEscape(p.sku),
        csvEscape(`${p.title} (${p.unit || '1 pc'})`),
        csvEscape(fullDesc),
        csvEscape(commerce.getProductFeedAvailability(p)),
        csvEscape('new'),
        csvEscape(`${p.priceBDT} BDT`),
        csvEscape(productLink),
        csvEscape(mainImage),
        csvEscape(altImage),
        csvEscape("Fariza's Territory"),
        csvEscape(`COL-${p.colId}`),
        csvEscape(googleCategory),
        csvEscape(p.superCategory),
        csvEscape(colName),
        csvEscape(p.unit || 'standard'),
        csvEscape('approved_price')
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="farizas-territory-catalog-feed.csv"');
    res.status(200).send(rows.join('\n'));
  });

  app.get(['/api/catalog-feed.xml', '/feed.xml'], async (req, res) => {
    const baseUrl = getCanonicalBaseUrl(req);
    const merged = await buildMergedCatalog();
    const eligible = merged.products.filter(p => commerce.isFeedEligibleProduct(p));

    const itemsXml = eligible.map(p => {
      const colName = p.collection ? p.collection.name : p.superCategory;
      const unitDisclosure = p.unit ? ` [Selling Unit: ${p.unit}]` : '';
      const cautionDisclosure = p.cautionEn ? ` (${p.cautionEn})` : '';
      const fullDesc = `${p.descriptionEn || p.title}${unitDisclosure}${cautionDisclosure}`;
      const productLink = `${baseUrl}/products/${encodeURIComponent(p.sku)}`;
      const mainImage = toAbsoluteMediaUrl(baseUrl, p.assets?.socialSquare || p.assets?.main || '');
      const storyImage = toAbsoluteMediaUrl(baseUrl, p.assets?.storyReel || p.assets?.main || '');

      return `    <item>
      <g:id>${xmlEscape(p.sku)}</g:id>
      <g:title>${xmlEscape(`${p.title} — ${p.titleBn || ''}`)}</g:title>
      <g:description>${xmlEscape(fullDesc)}</g:description>
      <g:link>${xmlEscape(productLink)}</g:link>
      <g:image_link>${xmlEscape(mainImage)}</g:image_link>
      <g:additional_image_link>${xmlEscape(storyImage)}</g:additional_image_link>
      <g:availability>${xmlEscape(commerce.getProductFeedAvailability(p))}</g:availability>
      <g:condition>new</g:condition>
      <g:price>${xmlEscape(`${p.priceBDT} BDT`)}</g:price>
      <g:brand>${xmlEscape("Fariza's Territory")}</g:brand>
      <g:item_group_id>${xmlEscape(`COL-${p.colId}`)}</g:item_group_id>
      <g:custom_label_0>${xmlEscape(p.superCategory)}</g:custom_label_0>
      <g:custom_label_1>${xmlEscape(colName)}</g:custom_label_1>
      <g:custom_label_2>${xmlEscape(p.unit || '')}</g:custom_label_2>
      <g:custom_label_3>approved</g:custom_label_3>
    </item>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Fariza's Territory — Verified Product Feed (Dhaka, Bangladesh)</title>
    <link>${xmlEscape(baseUrl)}</link>
    <description>Fashion clothing &amp; handmade artisan accessories based in Mirpur, Dhaka, Bangladesh. Elegance in Every Detail.</description>
${itemsXml}
  </channel>
</rss>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.status(200).send(xml);
  });

  app.get('/api/catalog-feed.json', async (req, res) => {
    const baseUrl = getCanonicalBaseUrl(req);
    const merged = await buildMergedCatalog();
    const eligible = merged.products.filter(p => commerce.isFeedEligibleProduct(p));
    const products = eligible.map(p => ({
      id: p.sku,
      sku: p.sku,
      title: p.title,
      titleBn: p.titleBn,
      superCategory: p.superCategory,
      collectionId: p.colId,
      collectionName: p.collection ? p.collection.name : '',
      collectionNameBn: p.collection ? p.collection.nameBn : '',
      priceBDT: p.priceBDT,
      currency: 'BDT',
      priceStatus: 'approved',
      sellingUnit: p.unit,
      sellingUnitBn: p.unitBn,
      cautionEn: p.cautionEn,
      cautionBn: p.cautionBn,
      availability: commerce.getProductFeedAvailability(p),
      condition: 'new',
      brand: "Fariza's Territory",
      deepLink: `${baseUrl}/products/${encodeURIComponent(p.sku)}`,
      images: {
        main: toAbsoluteMediaUrl(baseUrl, p.assets?.main || ''),
        socialSquare: toAbsoluteMediaUrl(baseUrl, p.assets?.socialSquare || p.assets?.main || ''),
        storyReel: toAbsoluteMediaUrl(baseUrl, p.assets?.storyReel || p.assets?.main || '')
      }
    }));

    res.status(200).json({
      brand: "Fariza's Territory",
      tagline: 'Elegance in Every Detail',
      location: 'Mirpur, Dhaka, Bangladesh',
      datasetId: process.env.META_DATASET_ID || process.env.META_PIXEL_ID || '1657670575734647',
      pixelId: process.env.META_PIXEL_ID || process.env.META_DATASET_ID || '1657670575734647',
      totalCatalogSkus: merged.products.length,
      eligibleFeedSkus: products.length,
      collectionsCount: catalog.COLLECTIONS.length,
      products
    });
  });

  // Return JSON 404 for unknown /api/* routes before SPA fallback
  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: 'API endpoint not found.' });
  });

  // =========================================================================
  // DYNAMIC CANONICAL SEO ROUTES (/products/:sku, /collections/:slug, sitemap)
  // =========================================================================
  app.get('/sitemap.xml', async (req, res) => {
    const baseUrl = getCanonicalBaseUrl(req);
    const nowIso = new Date().toISOString().split('T')[0];
    const merged = await buildMergedCatalog({ includeArchived: false });
    const urls = [
      `${baseUrl}/`,
      `${baseUrl}/shop`,
      `${baseUrl}/collections`,
      `${baseUrl}/policies`,
      `${baseUrl}/track`,
      ...merged.collections.map(c => `${baseUrl}/collections/${encodeURIComponent(c.slug)}`),
      ...merged.products.map(p => `${baseUrl}/products/${encodeURIComponent(p.sku)}`)
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${xmlEscape(u)}</loc>
    <lastmod>${nowIso}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${u === `${baseUrl}/` ? '1.0' : '0.8'}</priority>
  </url>`).join('\n')}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.status(200).send(xml);
  });

  app.get('/robots.txt', (req, res) => {
    const baseUrl = getCanonicalBaseUrl(req);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(
`User-agent: *
Allow: /
Disallow: /admin
Disallow: /admin.html
Disallow: /api/
Disallow: /assets/aistudio/

Sitemap: ${baseUrl}/sitemap.xml
`
    );
  });

  function renderSsrPage(req, meta) {
    const baseUrl = getCanonicalBaseUrl(req);
    let html = getIndexTemplate();
    const fullTitle = `${meta.title} — Fariza's Territory`;
    const canonical = `${baseUrl}${meta.path}`;
    const imageUrl = meta.imagePath
      ? toAbsoluteMediaUrl(baseUrl, meta.imagePath)
      : `${baseUrl}/assets/products/CAT-001/socialSquare.webp`;

    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${htmlTextEscape(fullTitle)}</title>`);
    html = html.replace(
      /<meta name="description" content="[^"]*">/i,
      `<meta name="description" content="${htmlAttrEscape(meta.description)}">`
    );
    html = html.replace(
      /<link rel="canonical" href="[^"]*">/i,
      `<link rel="canonical" href="${htmlAttrEscape(canonical)}">`
    );
    html = html.replace(
      /<meta property="og:url" content="[^"]*">/i,
      `<meta property="og:url" content="${htmlAttrEscape(canonical)}">`
    );
    html = html.replace(
      /<meta property="og:title" content="[^"]*">/i,
      `<meta property="og:title" content="${htmlAttrEscape(fullTitle)}">`
    );
    html = html.replace(
      /<meta property="og:description" content="[^"]*">/i,
      `<meta property="og:description" content="${htmlAttrEscape(meta.description)}">`
    );
    html = html.replace(
      /<meta property="og:image" content="[^"]*">/i,
      `<meta property="og:image" content="${htmlAttrEscape(imageUrl)}">`
    );
    html = html.replace(
      /<meta property="og:image:alt" content="[^"]*">/i,
      `<meta property="og:image:alt" content="${htmlAttrEscape(meta.imageAlt || fullTitle)}">`
    );
    html = html.replace(
      /<meta name="twitter:title" content="[^"]*">/i,
      `<meta name="twitter:title" content="${htmlAttrEscape(fullTitle)}">`
    );
    html = html.replace(
      /<meta name="twitter:description" content="[^"]*">/i,
      `<meta name="twitter:description" content="${htmlAttrEscape(meta.description)}">`
    );
    html = html.replace(
      /<meta name="twitter:image" content="[^"]*">/i,
      `<meta name="twitter:image" content="${htmlAttrEscape(imageUrl)}">`
    );

    const safeRouteScript = `<script>window.__FT_INITIAL_ROUTE__ = ${JSON.stringify(meta.initialHash || '')};</script>`;
    const extraLd = meta.jsonLd
      ? `<script type="application/ld+json">${JSON.stringify(meta.jsonLd).replace(/</g, '\\u003c')}</script>`
      : '';

    html = html.replace('</head>', `${safeRouteScript}\n${extraLd}\n</head>`);
    return html;
  }

  app.get('/products/:sku', async (req, res) => {
    const sku = String(req.params.sku || '').trim().toUpperCase();
    const merged = await buildMergedCatalog({ includeArchived: false });
    const product = merged.productsBySku[sku];
    if (!product) {
      return res.status(404).send('Product not found');
    }
    const baseUrl = getCanonicalBaseUrl(req);
    const canonical = `${baseUrl}/products/${encodeURIComponent(product.sku)}`;
    const imagePath = product.assets?.socialSquare || product.assets?.main || 'assets/products/CAT-001/socialSquare.webp';
    const desc = `${product.descriptionEn || product.title}${product.unit ? ` (Selling Unit: ${product.unit})` : ''} — Order Cash on Delivery across Dhaka & Bangladesh.`;

    const html = renderSsrPage(req, {
      title: `${product.title} (${product.sku})`,
      description: desc,
      path: `/products/${encodeURIComponent(product.sku)}`,
      imagePath,
      imageAlt: product.title,
      initialHash: `#/product/${encodeURIComponent(product.sku)}`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Product',
        sku: product.sku,
        name: product.title,
        description: desc,
        image: toAbsoluteMediaUrl(baseUrl, imagePath),
        brand: {
          '@type': 'Brand',
          name: "Fariza's Territory"
        },
        offers: {
          '@type': 'Offer',
          url: canonical,
          priceCurrency: 'BDT',
          price: String(product.priceBDT || 0),
          availability: (product.is_available === false || (product.stock_count !== undefined && product.stock_count !== null && Number(product.stock_count) <= 0))
            ? 'https://schema.org/OutOfStock'
            : 'https://schema.org/InStock',
          itemCondition: 'https://schema.org/NewCondition'
        }
      }
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  });

  app.get('/collections/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    const merged = await buildMergedCatalog({ includeArchived: false });
    const col = merged.collections.find(c => c.slug === slug);
    if (!col) {
      return res.status(404).send('Collection not found');
    }
    const baseUrl = getCanonicalBaseUrl(req);
    const colProducts = merged.products.filter(p => p.collectionSlug === col.slug || p.colId === col.id);
    const firstImg = colProducts[0]?.assets?.socialSquare || colProducts[0]?.assets?.main || col.heroImage || 'assets/products/CAT-001/socialSquare.webp';

    const html = renderSsrPage(req, {
      title: `${col.name} Collection`,
      description: `${col.name} (${col.nameBn || ''}) — ${col.leadEn || "Curated Fariza's Territory pieces."} (${colProducts.length} pieces)`,
      path: `/collections/${encodeURIComponent(col.slug)}`,
      imagePath: firstImg,
      imageAlt: col.name,
      initialHash: `#/collection/${encodeURIComponent(col.slug)}`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: col.name,
        url: `${baseUrl}/collections/${encodeURIComponent(col.slug)}`,
        description: col.leadEn || col.name
      }
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  });

  // Clean semantic paths mapped cleanly to initial SPA routes with SSR meta tags
  const cleanPageMeta = [
    { path: '/shop', hash: '#/shop', title: 'Shop All Boutique Pieces', desc: 'Browse curated South Asian fashion & handmade accessories with COD delivery across Dhaka & Bangladesh.' },
    { path: '/collections', hash: '#/collections', title: 'Boutique Collections', desc: 'Explore 8 signature fashion, mirrorwork, jewelry, and bangle collections.' },
    { path: '/lookbook', hash: '#/lookbook', title: 'Editorial Lookbook', desc: 'Shop the complete Fariza\'s Territory festive and daily wear lookbook.' },
    { path: '/bag', hash: '#/bag', title: 'Shopping Bag & COD Checkout', desc: 'Review your selected pieces and complete Cash on Delivery checkout across Bangladesh.' },
    { path: '/inquiry', hash: '#/inquiry', title: 'Order Inquiry & Custom Styling', desc: 'Submit a direct boutique inquiry or COD reservation with Fariza\'s Territory.' },
    { path: '/track', hash: '#/track', title: 'Track Your COD Order', desc: 'Verify your Order Reference and phone number to check live courier status.' },
    { path: '/about', hash: '#/about', title: 'About Fariza\'s Territory', desc: 'Boutique fashion and handcrafted accessories curated in Mirpur, Dhaka, Bangladesh.' },
    { path: '/contact', hash: '#/contact', title: 'Contact & Storefront Support', desc: 'Connect with Fariza\'s Territory via Facebook Messenger, inquiry form, or order tracking.' },
    { path: '/faq', hash: '#/faq', title: 'Frequently Asked Questions', desc: 'Answers about COD delivery timelines, selling units, sizing, and order tracking.' },
    { path: '/policies', hash: '#/policies', title: 'Store Policies — Return, COD & Privacy', desc: 'Clear bilingual terms for returns, exchanges, COD refusal, delivery SLA, vouchers, and cookie privacy.' }
  ];

  for (const pg of cleanPageMeta) {
    app.get(pg.path, (req, res) => {
      const html = renderSsrPage(req, {
        title: pg.title,
        description: pg.desc,
        path: pg.path,
        imagePath: 'assets/products/CAT-001/socialSquare.webp',
        imageAlt: pg.title,
        initialHash: pg.hash
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    });
  }

  // Admin Portal Routes (noindex enforced)
  app.get(['/admin', '/admin.html'], (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'admin.html'));
  });

  // GHL Custom HTML Bundle Route
  app.get(['/ghl-bundle', '/ghl-bundle.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'ghl-bundle.html'));
  });

  // Storefront Home & SPA fallback
  app.get('/', (req, res) => {
    const html = renderSsrPage(req, {
      title: "Boutique Fashion & Artisan Accessories",
      description: "Fariza's Territory by Faria & Saiful Islam Shuvo — Curated South Asian boutique fashion & artisan accessories from Mirpur, Dhaka, Bangladesh.",
      path: '/',
      imagePath: 'assets/products/CAT-001/socialSquare.webp',
      imageAlt: "Fariza's Territory — Magenta Plum Printed Three Piece",
      initialHash: ''
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  });

  app.use((req, res) => {
    res.sendFile(indexHtmlPath);
  });

  app.processCapiOutbox = processOutboxEvents;
  return app;
}

let defaultApp = null;
function getDefaultApp() {
  if (!defaultApp) {
    defaultApp = createApp({ enableOutboxWorker: false });
  }
  return defaultApp;
}

if (require.main === module) {
  const app = createApp({ enableOutboxWorker: true });
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Fariza's Territory Boutique Server running on http://0.0.0.0:${PORT}`);
  });
}

function serverHandler(req, res) {
  return getDefaultApp()(req, res);
}

serverHandler.createApp = createApp;
serverHandler.loadCatalogInMemory = loadCatalogInMemory;
serverHandler.getCanonicalBaseUrl = getCanonicalBaseUrl;

module.exports = serverHandler;
