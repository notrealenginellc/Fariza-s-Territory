/**
 * Fariza's Territory — Durable Standalone Server Store (SQLite / Atomic File)
 * Implements the exact repository interface as lib/supabaseServer.js so that
 * when SUPABASE_SERVICE_ROLE_KEY is not configured, both the Storefront and
 * the Admin Panel operate with 100% real server-side persistence and secure
 * scrypt-hashed admin authentication (never sessionStorage mocks).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const commerce = require('../assets/js/commerce.js');

const DEFAULT_SETTINGS = {
  id: 'default',
  store_name: "Fariza's Territory",
  tagline: 'Elegance in Every Detail',
  whatsapp_number: '',
  messenger_username: 'farizasterritory143',
  facebook_url: 'https://www.facebook.com/farizasterritory143',
  delivery_fee_dhaka: commerce.DEFAULT_DELIVERY_FEES.dhaka,
  delivery_fee_outside: commerce.DEFAULT_DELIVERY_FEES.outside_dhaka,
  free_delivery_threshold: commerce.DEFAULT_FREE_SHIPPING_THRESHOLD,
  promo_text: 'First-order 25% OFF with code FIRST25 · Free delivery over ৳3,000 (FREESHIP)',
  meta_pixel_id: process.env.META_PIXEL_ID || '1657670575734647',
  ga4_measurement_id: ''
};

function hashPassword(password, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPasswordHash(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(String(password), salt, 64);
  const stored = Buffer.from(keyHex, 'hex');
  if (derived.length !== stored.length) return false;
  return crypto.timingSafeEqual(derived, stored);
}

function timingSafeTextEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(String(a || '')).digest();
  const bufB = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

function sha256Hex(val) {
  return crypto.createHash('sha256').update(String(val || '')).digest('hex');
}

function loadSqliteModule() {
  try {
    return require('node:sqlite');
  } catch (_) {
    return null;
  }
}

function createLocalBoutiqueStore(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const dbPath = options.dbPath || path.join(dataDir, 'boutique.sqlite');
  const jsonFallbackPath = options.jsonPath || path.join(dataDir, 'boutique-state.json');
  const useMemoryOnly = options.dbPath === ':memory:';
  const sessionTtlMs = Number(options.sessionTtlMs || 24 * 60 * 60 * 1000);

  if (!useMemoryOnly) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const sqliteMod = options.forceJsonBackend ? null : loadSqliteModule();
  let db = null;
  let state = null;

  if (sqliteMod && sqliteMod.DatabaseSync) {
    db = new sqliteMod.DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS products (
        sku TEXT PRIMARY KEY,
        price_bdt REAL,
        stock_count INTEGER DEFAULT 15,
        is_available INTEGER DEFAULT 1,
        stock_verified INTEGER DEFAULT 0,
        price_review INTEGER DEFAULT 1,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        order_ref TEXT UNIQUE NOT NULL,
        idempotency_key TEXT UNIQUE,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_email TEXT DEFAULT '',
        customer_district TEXT DEFAULT '',
        customer_address TEXT NOT NULL,
        delivery_zone TEXT DEFAULT 'dhaka',
        delivery_fee REAL DEFAULT 80,
        items_json TEXT NOT NULL,
        subtotal REAL NOT NULL,
        discount_code TEXT,
        discount_amount REAL DEFAULT 0,
        total REAL NOT NULL,
        status TEXT DEFAULT 'pending',
        status_history_json TEXT DEFAULT '[]',
        source TEXT DEFAULT 'web_storefront',
        courier_name TEXT DEFAULT '',
        tracking_number TEXT DEFAULT '',
        contact_channel TEXT DEFAULT 'web_form',
        payment_method TEXT DEFAULT 'Cash on Delivery (COD)',
        customer_notes TEXT DEFAULT '',
        meta_capi_sent INTEGER DEFAULT 0,
        purchase_capi_sent_at TEXT,
        purchase_capi_event_id TEXT,
        attribution_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coupons (
        code TEXT PRIMARY KEY,
        discount_type TEXT NOT NULL,
        discount_value REAL DEFAULT 0,
        min_spend REAL DEFAULT 0,
        max_discount REAL,
        notes TEXT DEFAULT '',
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS store_settings (
        id TEXT PRIMARY KEY,
        store_name TEXT,
        tagline TEXT,
        whatsapp_number TEXT,
        messenger_username TEXT,
        facebook_url TEXT,
        delivery_fee_dhaka REAL,
        delivery_fee_outside REAL,
        free_delivery_threshold REAL,
        promo_text TEXT,
        meta_pixel_id TEXT,
        ga4_measurement_id TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS admin_accounts (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email TEXT NOT NULL,
        full_name TEXT DEFAULT 'Store Owner',
        role TEXT DEFAULT 'admin',
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const existingSettings = db.prepare('SELECT id FROM store_settings WHERE id = ?').get('default');
    if (!existingSettings) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO store_settings (
          id, store_name, tagline, whatsapp_number, messenger_username, facebook_url,
          delivery_fee_dhaka, delivery_fee_outside, free_delivery_threshold,
          promo_text, meta_pixel_id, ga4_measurement_id, updated_at
        ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        DEFAULT_SETTINGS.store_name,
        DEFAULT_SETTINGS.tagline,
        DEFAULT_SETTINGS.whatsapp_number,
        DEFAULT_SETTINGS.messenger_username,
        DEFAULT_SETTINGS.facebook_url,
        DEFAULT_SETTINGS.delivery_fee_dhaka,
        DEFAULT_SETTINGS.delivery_fee_outside,
        DEFAULT_SETTINGS.free_delivery_threshold,
        DEFAULT_SETTINGS.promo_text,
        DEFAULT_SETTINGS.meta_pixel_id,
        DEFAULT_SETTINGS.ga4_measurement_id,
        now
      );
    }

    const couponCount = db.prepare('SELECT COUNT(*) AS cnt FROM coupons').get();
    if (!couponCount || Number(couponCount.cnt) === 0) {
      const now = new Date().toISOString();
      const ins = db.prepare(`
        INSERT OR IGNORE INTO coupons (code, discount_type, discount_value, min_spend, max_discount, notes, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of commerce.DEFAULT_COUPONS) {
        ins.run(c.code, c.discount_type, c.discount_value, c.min_spend, c.max_discount ?? null, c.notes || '', c.is_active ? 1 : 0, now);
      }
    }
  } else {
    state = loadJsonState(jsonFallbackPath, useMemoryOnly);
  }

  function loadJsonState(filePath, memoryOnly) {
    if (!memoryOnly && fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Object.assign({
          products: {},
          orders: [],
          coupons: {},
          settings: Object.assign({}, DEFAULT_SETTINGS),
          adminAccount: null,
          sessions: {}
        }, parsed);
      } catch (_) {}
    }
    const coupons = {};
    const now = new Date().toISOString();
    for (const c of commerce.DEFAULT_COUPONS) {
      coupons[c.code] = Object.assign({ created_at: now }, c);
    }
    return {
      products: {},
      orders: [],
      coupons,
      settings: Object.assign({}, DEFAULT_SETTINGS),
      adminAccount: null,
      sessions: {}
    };
  }

  function flushJsonState() {
    if (!state || useMemoryOnly) return;
    const tmp = `${jsonFallbackPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, jsonFallbackPath);
  }

  function mapSqliteOrder(row) {
    if (!row) return null;
    let items = [];
    let attribution = null;
    let statusHistory = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch (_) {}
    try { attribution = row.attribution_json ? JSON.parse(row.attribution_json) : null; } catch (_) {}
    try { statusHistory = JSON.parse(row.status_history_json || '[]'); } catch (_) {}
    return {
      id: row.id,
      order_ref: row.order_ref,
      idempotency_key: row.idempotency_key || null,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      customer_email: row.customer_email || '',
      customer_district: row.customer_district || '',
      customer_address: row.customer_address,
      delivery_zone: row.delivery_zone || 'dhaka',
      delivery_fee: Number(row.delivery_fee || 0),
      items,
      subtotal: Number(row.subtotal || 0),
      discount_code: row.discount_code || null,
      discount_amount: Number(row.discount_amount || 0),
      total: Number(row.total || 0),
      status: row.status || 'pending',
      status_history: Array.isArray(statusHistory) ? statusHistory : [],
      source: row.source || 'web_storefront',
      courier_name: row.courier_name || '',
      tracking_number: row.tracking_number || '',
      contact_channel: row.contact_channel || 'web_form',
      payment_method: row.payment_method || 'Cash on Delivery (COD)',
      customer_notes: row.customer_notes || '',
      meta_capi_sent: Boolean(row.meta_capi_sent || row.purchase_capi_sent_at),
      purchase_capi_sent_at: row.purchase_capi_sent_at || null,
      purchase_capi_event_id: row.purchase_capi_event_id || null,
      attribution,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  function mapSqliteProduct(row) {
    if (!row) return null;
    return {
      sku: row.sku,
      price_bdt: row.price_bdt !== null && row.price_bdt !== undefined ? Number(row.price_bdt) : undefined,
      stock_count: row.stock_count !== null && row.stock_count !== undefined ? Number(row.stock_count) : 15,
      is_available: Boolean(row.is_available),
      stock_verified: Boolean(row.stock_verified),
      price_review: Boolean(row.price_review),
      updated_at: row.updated_at
    };
  }

  function mapSqliteCoupon(row) {
    if (!row) return null;
    return {
      code: row.code,
      discount_type: row.discount_type,
      discount_value: Number(row.discount_value || 0),
      min_spend: Number(row.min_spend || 0),
      max_discount: row.max_discount !== null && row.max_discount !== undefined ? Number(row.max_discount) : null,
      notes: row.notes || '',
      is_active: Boolean(row.is_active),
      created_at: row.created_at
    };
  }

  function getEnvAdminCredentials() {
    const envPassword = String(process.env.ADMIN_PASSWORD || '').trim();
    if (!envPassword) return null;
    const envEmail = String(process.env.ADMIN_EMAIL || 'owner@farizasterritory.com').trim().toLowerCase();
    return { email: envEmail, password: envPassword, role: 'admin', full_name: 'Store Owner' };
  }

  function getStoredAdminAccount() {
    if (db) {
      return db.prepare('SELECT id, email, full_name, role, password_hash, created_at, updated_at FROM admin_accounts WHERE id = 1').get() || null;
    }
    return state.adminAccount || null;
  }

  function purgeExpiredSessions() {
    const now = Date.now();
    if (db) {
      db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
    } else {
      for (const k of Object.keys(state.sessions)) {
        if (!state.sessions[k] || state.sessions[k].expires_at <= now) {
          delete state.sessions[k];
        }
      }
      flushJsonState();
    }
  }

  function issueSession(email, role) {
    purgeExpiredSessions();
    const rawToken = `ft_adm_${crypto.randomBytes(32).toString('hex')}`;
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = Date.now() + sessionTtlMs;
    const nowIso = new Date().toISOString();
    if (db) {
      db.prepare(`
        INSERT INTO admin_sessions (token_hash, email, role, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(tokenHash, email, role, expiresAt, nowIso);
    } else {
      state.sessions[tokenHash] = { email, role, expires_at: expiresAt, created_at: nowIso };
      flushJsonState();
    }
    return {
      accessToken: rawToken,
      expiresAt: new Date(expiresAt).toISOString(),
      user: { email, role }
    };
  }

  return {
    isDurableConfigured() {
      return true;
    },

    getConfigSummary() {
      return {
        supabaseUrl: '',
        anonConfigured: false,
        serviceRoleConfigured: false,
        storeMode: db ? 'local_sqlite' : 'local_file',
        authMode: 'local'
      };
    },

    async getAuthStatus() {
      const envCreds = getEnvAdminCredentials();
      const stored = getStoredAdminAccount();
      return {
        authMode: 'local',
        storeMode: db ? 'local_sqlite' : 'local_file',
        setupRequired: !envCreds && !stored,
        envManaged: Boolean(envCreds)
      };
    },

    async setupFirstAdmin({ email, password, full_name }) {
      const envCreds = getEnvAdminCredentials();
      if (envCreds) {
        return { ok: false, status: 403, error: 'Admin access is managed via environment credentials. Please sign in.' };
      }
      const existing = getStoredAdminAccount();
      if (existing) {
        return { ok: false, status: 409, error: 'An admin account has already been claimed. Please sign in.' };
      }
      const cleanEmail = String(email || '').trim().toLowerCase();
      const cleanPassword = String(password || '');
      const cleanName = String(full_name || 'Store Owner').trim().slice(0, 80) || 'Store Owner';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return { ok: false, status: 400, error: 'Please enter a valid admin email address.' };
      }
      if (cleanPassword.length < 8) {
        return { ok: false, status: 400, error: 'Password must be at least 8 characters long.' };
      }
      const now = new Date().toISOString();
      const passwordHash = hashPassword(cleanPassword);
      if (db) {
        try {
          db.prepare(`
            INSERT INTO admin_accounts (id, email, full_name, role, password_hash, created_at, updated_at)
            VALUES (1, ?, ?, 'admin', ?, ?, ?)
          `).run(cleanEmail, cleanName, passwordHash, now, now);
        } catch (_) {
          return { ok: false, status: 409, error: 'Admin account was already claimed. Please sign in.' };
        }
      } else {
        state.adminAccount = {
          id: 1,
          email: cleanEmail,
          full_name: cleanName,
          role: 'admin',
          password_hash: passwordHash,
          created_at: now,
          updated_at: now
        };
        flushJsonState();
      }
      const session = issueSession(cleanEmail, 'admin');
      return {
        ok: true,
        token: session.accessToken,
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
        user: { email: cleanEmail, role: 'admin', full_name: cleanName }
      };
    },

    async loginAdmin({ email, password }) {
      const cleanEmail = String(email || '').trim().toLowerCase();
      const cleanPassword = String(password || '');
      if (!cleanEmail || !cleanPassword) {
        return { ok: false, status: 400, error: 'Email and password are required.' };
      }
      const envCreds = getEnvAdminCredentials();
      if (envCreds) {
        const emailOk = timingSafeTextEqual(cleanEmail, envCreds.email);
        const passOk = timingSafeTextEqual(cleanPassword, envCreds.password);
        if (!emailOk || !passOk) {
          return { ok: false, status: 401, error: 'Invalid admin email or password.' };
        }
        const session = issueSession(envCreds.email, envCreds.role);
        return {
          ok: true,
          token: session.accessToken,
          accessToken: session.accessToken,
          expiresAt: session.expiresAt,
          user: { email: envCreds.email, role: envCreds.role, full_name: envCreds.full_name }
        };
      }

      const stored = getStoredAdminAccount();
      if (!stored) {
        return { ok: false, status: 409, error: 'No admin account has been configured yet. Complete first-run setup.' };
      }
      const emailOk = timingSafeTextEqual(cleanEmail, stored.email.toLowerCase());
      const passOk = verifyPasswordHash(cleanPassword, stored.password_hash);
      if (!emailOk || !passOk) {
        return { ok: false, status: 401, error: 'Invalid admin email or password.' };
      }
      const session = issueSession(stored.email, stored.role || 'admin');
      return {
        ok: true,
        token: session.accessToken,
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
        user: { email: stored.email, role: stored.role || 'admin', full_name: stored.full_name || 'Store Owner' }
      };
    },

    async logoutAdmin(authHeader) {
      const token = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
      if (!token) return { ok: true };
      const tokenHash = sha256Hex(token);
      if (db) {
        db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
      } else {
        delete state.sessions[tokenHash];
        flushJsonState();
      }
      return { ok: true };
    },

    async changeAdminPassword({ currentPassword, newPassword }) {
      const envCreds = getEnvAdminCredentials();
      if (envCreds) {
        return { ok: false, status: 400, error: 'Password is controlled by the ADMIN_PASSWORD environment variable.' };
      }
      const stored = getStoredAdminAccount();
      if (!stored) {
        return { ok: false, status: 404, error: 'Admin account not found.' };
      }
      if (!verifyPasswordHash(currentPassword, stored.password_hash)) {
        return { ok: false, status: 401, error: 'Current password is incorrect.' };
      }
      if (String(newPassword || '').length < 8) {
        return { ok: false, status: 400, error: 'New password must be at least 8 characters long.' };
      }
      const newHash = hashPassword(newPassword);
      const now = new Date().toISOString();
      if (db) {
        db.prepare('UPDATE admin_accounts SET password_hash = ?, updated_at = ? WHERE id = 1').run(newHash, now);
      } else {
        state.adminAccount.password_hash = newHash;
        state.adminAccount.updated_at = now;
        flushJsonState();
      }
      return { ok: true };
    },

    async verifyAdminBearerToken(authHeader) {
      const header = String(authHeader || '').trim();
      if (!header.toLowerCase().startsWith('bearer ')) {
        return { ok: false, status: 401, error: 'Missing Bearer authorization token.' };
      }
      const token = header.slice(7).trim();
      if (!token) {
        return { ok: false, status: 401, error: 'Empty Bearer token.' };
      }
      purgeExpiredSessions();
      const tokenHash = sha256Hex(token);
      let sessionRow = null;
      if (db) {
        sessionRow = db.prepare('SELECT email, role, expires_at FROM admin_sessions WHERE token_hash = ?').get(tokenHash);
      } else {
        sessionRow = state.sessions[tokenHash] || null;
      }
      if (!sessionRow || Number(sessionRow.expires_at) <= Date.now()) {
        return { ok: false, status: 401, error: 'Session expired or invalid. Please sign in again.' };
      }
      return {
        ok: true,
        user: {
          id: 'local-admin-1',
          email: sessionRow.email,
          role: sessionRow.role || 'admin'
        }
      };
    },

    async getStoreSettings() {
      if (db) {
        const row = db.prepare('SELECT * FROM store_settings WHERE id = ?').get('default');
        return row ? Object.assign({}, DEFAULT_SETTINGS, row) : Object.assign({}, DEFAULT_SETTINGS);
      }
      return Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
    },

    async updateStoreSettings(updates) {
      const current = (await this.getStoreSettings()) || DEFAULT_SETTINGS;
      const pickText = (field, fallback) => {
        if (updates && updates[field] !== undefined) return String(updates[field] ?? '').trim();
        if (current[field] !== undefined && current[field] !== null) return String(current[field]);
        return fallback;
      };
      const pickNum = (field, fallback) => {
        if (updates && updates[field] !== undefined && updates[field] !== null && updates[field] !== '') {
          return Number(updates[field]);
        }
        if (current[field] !== undefined && current[field] !== null) return Number(current[field]);
        return fallback;
      };
      const merged = {
        id: 'default',
        store_name: pickText('store_name', DEFAULT_SETTINGS.store_name),
        tagline: pickText('tagline', DEFAULT_SETTINGS.tagline),
        whatsapp_number: pickText('whatsapp_number', ''),
        messenger_username: pickText('messenger_username', 'farizasterritory143') || 'farizasterritory143',
        facebook_url: pickText('facebook_url', 'https://www.facebook.com/farizasterritory143'),
        delivery_fee_dhaka: pickNum('delivery_fee_dhaka', commerce.DEFAULT_DELIVERY_FEES.dhaka),
        delivery_fee_outside: pickNum('delivery_fee_outside', commerce.DEFAULT_DELIVERY_FEES.outside_dhaka),
        free_delivery_threshold: pickNum('free_delivery_threshold', commerce.DEFAULT_FREE_SHIPPING_THRESHOLD),
        promo_text: pickText('promo_text', ''),
        meta_pixel_id: pickText('meta_pixel_id', '1657670575734647') || '1657670575734647',
        ga4_measurement_id: pickText('ga4_measurement_id', ''),
        updated_at: new Date().toISOString()
      };
      if (db) {
        db.prepare(`
          UPDATE store_settings
          SET store_name = ?, tagline = ?, whatsapp_number = ?, messenger_username = ?, facebook_url = ?,
              delivery_fee_dhaka = ?, delivery_fee_outside = ?, free_delivery_threshold = ?,
              promo_text = ?, meta_pixel_id = ?, ga4_measurement_id = ?, updated_at = ?
          WHERE id = 'default'
        `).run(
          merged.store_name,
          merged.tagline,
          merged.whatsapp_number,
          merged.messenger_username,
          merged.facebook_url,
          merged.delivery_fee_dhaka,
          merged.delivery_fee_outside,
          merged.free_delivery_threshold,
          merged.promo_text,
          merged.meta_pixel_id,
          merged.ga4_measurement_id,
          merged.updated_at
        );
      } else {
        state.settings = merged;
        flushJsonState();
      }
      return { ok: true, data: merged };
    },

    async listProducts() {
      if (db) {
        const rows = db.prepare('SELECT * FROM products ORDER BY sku ASC').all();
        return rows.map(mapSqliteProduct);
      }
      return Object.values(state.products).sort((a, b) => a.sku.localeCompare(b.sku));
    },

    async updateProduct(sku, updates) {
      const now = new Date().toISOString();
      if (db) {
        const prev = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
        const next = {
          sku,
          price_bdt: updates.price_bdt !== undefined ? Number(updates.price_bdt) : (prev ? prev.price_bdt : null),
          stock_count: updates.stock_count !== undefined ? Number(updates.stock_count) : (prev ? prev.stock_count : 15),
          is_available: updates.is_available !== undefined ? (updates.is_available ? 1 : 0) : (prev ? prev.is_available : 1),
          stock_verified: updates.stock_verified !== undefined ? (updates.stock_verified ? 1 : 0) : (prev ? prev.stock_verified : 0),
          price_review: updates.price_review !== undefined ? (updates.price_review ? 1 : 0) : (prev ? prev.price_review : 1),
          updated_at: now
        };
        db.prepare(`
          INSERT INTO products (sku, price_bdt, stock_count, is_available, stock_verified, price_review, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(sku) DO UPDATE SET
            price_bdt = excluded.price_bdt,
            stock_count = excluded.stock_count,
            is_available = excluded.is_available,
            stock_verified = excluded.stock_verified,
            price_review = excluded.price_review,
            updated_at = excluded.updated_at
        `).run(next.sku, next.price_bdt, next.stock_count, next.is_available, next.stock_verified, next.price_review, next.updated_at);
        return { ok: true, data: mapSqliteProduct(next) };
      }
      const prev = state.products[sku] || { sku, stock_count: 15, is_available: true, stock_verified: false, price_review: true };
      const next = Object.assign({}, prev, updates, { sku, updated_at: now });
      state.products[sku] = next;
      flushJsonState();
      return { ok: true, data: next };
    },

    async bulkUpdateProducts(skus, updates) {
      const updated = [];
      for (const sku of skus) {
        const res = await this.updateProduct(sku, updates);
        if (res.ok && res.data) updated.push(res.data);
      }
      return { ok: true, data: updated };
    },

    async getCouponByCode(code) {
      const clean = String(code || '').trim().toUpperCase();
      if (!clean) return null;
      if (db) {
        const row = db.prepare('SELECT * FROM coupons WHERE code = ?').get(clean);
        return mapSqliteCoupon(row);
      }
      return state.coupons[clean] || null;
    },

    async listCoupons() {
      if (db) {
        const rows = db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all();
        return { ok: true, data: rows.map(mapSqliteCoupon) };
      }
      const list = Object.values(state.coupons).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      return { ok: true, data: list };
    },

    async upsertCoupon(coupon) {
      const cleanCode = String(coupon.code || '').trim().toUpperCase();
      const existing = await this.getCouponByCode(cleanCode);
      const now = (existing && existing.created_at) || new Date().toISOString();
      const rec = {
        code: cleanCode,
        discount_type: coupon.discount_type || (existing && existing.discount_type) || 'fixed',
        discount_value: coupon.discount_value !== undefined ? Number(coupon.discount_value) : (existing ? existing.discount_value : 0),
        min_spend: coupon.min_spend !== undefined ? Number(coupon.min_spend) : (existing ? existing.min_spend : 0),
        max_discount: coupon.max_discount !== undefined ? (coupon.max_discount === null ? null : Number(coupon.max_discount)) : (existing ? existing.max_discount : null),
        notes: coupon.notes !== undefined ? String(coupon.notes) : (existing ? existing.notes : ''),
        is_active: coupon.is_active !== undefined ? Boolean(coupon.is_active) : (existing ? existing.is_active : true),
        created_at: now
      };
      if (db) {
        db.prepare(`
          INSERT INTO coupons (code, discount_type, discount_value, min_spend, max_discount, notes, is_active, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(code) DO UPDATE SET
            discount_type = excluded.discount_type,
            discount_value = excluded.discount_value,
            min_spend = excluded.min_spend,
            max_discount = excluded.max_discount,
            notes = excluded.notes,
            is_active = excluded.is_active
        `).run(rec.code, rec.discount_type, rec.discount_value, rec.min_spend, rec.max_discount, rec.notes, rec.is_active ? 1 : 0, rec.created_at);
        return { ok: true, data: rec };
      }
      state.coupons[cleanCode] = rec;
      flushJsonState();
      return { ok: true, data: rec };
    },

    async deleteCoupon(code) {
      const clean = String(code || '').trim().toUpperCase();
      if (db) {
        const res = db.prepare('DELETE FROM coupons WHERE code = ?').run(clean);
        if (!res || Number(res.changes || 0) === 0) {
          return { ok: false, status: 404, error: 'Coupon not found.' };
        }
        return { ok: true, data: { code: clean } };
      }
      if (!state.coupons[clean]) {
        return { ok: false, status: 404, error: 'Coupon not found.' };
      }
      delete state.coupons[clean];
      flushJsonState();
      return { ok: true, data: { code: clean } };
    },

    async findOrderByIdempotencyKey(key) {
      if (!key) return null;
      if (db) {
        const row = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(key);
        return mapSqliteOrder(row);
      }
      return state.orders.find(o => o.idempotency_key === key) || null;
    },

    async createOrder(record) {
      if (record.idempotency_key) {
        const existing = await this.findOrderByIdempotencyKey(record.idempotency_key);
        if (existing) {
          return { ok: true, idempotent: true, data: existing };
        }
      }
      const now = new Date().toISOString();
      const rec = Object.assign({
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        status: 'pending',
        status_history: [],
        source: 'web_storefront',
        courier_name: '',
        tracking_number: '',
        meta_capi_sent: false,
        purchase_capi_sent_at: null,
        purchase_capi_event_id: null
      }, record);

      if (db) {
        db.prepare(`
          INSERT INTO orders (
            id, order_ref, idempotency_key, customer_name, customer_phone, customer_email,
            customer_district, customer_address, delivery_zone, delivery_fee, items_json,
            subtotal, discount_code, discount_amount, total, status, status_history_json,
            source, courier_name, tracking_number, contact_channel, payment_method,
            customer_notes, meta_capi_sent, purchase_capi_sent_at, purchase_capi_event_id,
            attribution_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          rec.id,
          rec.order_ref,
          rec.idempotency_key || null,
          rec.customer_name,
          rec.customer_phone,
          rec.customer_email || '',
          rec.customer_district || '',
          rec.customer_address,
          rec.delivery_zone || 'dhaka',
          Number(rec.delivery_fee || 0),
          JSON.stringify(rec.items || []),
          Number(rec.subtotal || 0),
          rec.discount_code || null,
          Number(rec.discount_amount || 0),
          Number(rec.total || 0),
          rec.status || 'pending',
          JSON.stringify(rec.status_history || []),
          rec.source || 'web_storefront',
          rec.courier_name || '',
          rec.tracking_number || '',
          rec.contact_channel || 'web_form',
          rec.payment_method || 'Cash on Delivery (COD)',
          rec.customer_notes || '',
          rec.meta_capi_sent ? 1 : 0,
          rec.purchase_capi_sent_at || null,
          rec.purchase_capi_event_id || null,
          rec.attribution ? JSON.stringify(rec.attribution) : null,
          rec.created_at,
          rec.updated_at
        );
        return { ok: true, idempotent: false, data: rec };
      }
      state.orders.unshift(rec);
      flushJsonState();
      return { ok: true, idempotent: false, data: rec };
    },

    async getOrderByRef(orderRef) {
      const clean = String(orderRef || '').trim().toUpperCase();
      let found = null;
      if (db) {
        const row = db.prepare('SELECT * FROM orders WHERE UPPER(order_ref) = ?').get(clean);
        found = mapSqliteOrder(row);
      } else {
        found = state.orders.find(o => String(o.order_ref || '').toUpperCase() === clean) || null;
      }
      if (!found) return { ok: false, status: 404, error: 'Order not found.' };
      return { ok: true, data: found };
    },

    async listOrders(filters = {}) {
      const status = filters && filters.status;
      if (db) {
        const rows = (status && status !== 'all')
          ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 500').all(status)
          : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all();
        return { ok: true, data: rows.map(mapSqliteOrder) };
      }
      let list = state.orders.slice();
      if (status && status !== 'all') {
        list = list.filter(o => o.status === status);
      }
      return { ok: true, data: list.slice(0, 500) };
    },

    async updateOrder(orderRef, patch) {
      const existingRes = await this.getOrderByRef(orderRef);
      if (!existingRes.ok) return existingRes;
      const existing = existingRes.data;
      const merged = Object.assign({}, existing, patch, { updated_at: new Date().toISOString() });
      if (merged.purchase_capi_sent_at) merged.meta_capi_sent = true;
      if (db) {
        db.prepare(`
          UPDATE orders
          SET status = ?, status_history_json = ?, courier_name = ?, tracking_number = ?,
              customer_notes = ?, customer_address = ?, meta_capi_sent = ?,
              purchase_capi_sent_at = ?, purchase_capi_event_id = ?, updated_at = ?
          WHERE order_ref = ?
        `).run(
          merged.status,
          JSON.stringify(merged.status_history || []),
          merged.courier_name || '',
          merged.tracking_number || '',
          merged.customer_notes || '',
          merged.customer_address || '',
          merged.meta_capi_sent ? 1 : 0,
          merged.purchase_capi_sent_at || null,
          merged.purchase_capi_event_id || null,
          merged.updated_at,
          existing.order_ref
        );
        return { ok: true, data: merged };
      }
      const idx = state.orders.findIndex(o => o.order_ref === existing.order_ref);
      if (idx >= 0) state.orders[idx] = merged;
      flushJsonState();
      return { ok: true, data: merged };
    }
  };
}

module.exports = {
  createLocalBoutiqueStore
};
