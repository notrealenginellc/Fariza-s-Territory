/**
 * Fariza's Territory — Production Store Operations & Admin Cockpit Controller
 * 100% Server-Backed Persistence (Standalone SQLite or Supabase PostgreSQL)
 * Dual-Mode Authentication:
 *   - Standalone Local Owner Auth (/api/auth/setup, /api/auth/login, /api/auth/logout)
 *   - Supabase Cloud Staff Auth (public.staff_users + /api/auth/session)
 * Bearer tokens are held strictly in JavaScript memory (never in localStorage/sessionStorage).
 */
(function (window, document) {
  'use strict';

  let currentOrders = [];
  let currentCoupons = [];
  let selectedOrder = null;
  let selectedProductSku = null;
  let currentAccessToken = '';
  let currentStaffUser = null;
  let authStatusState = {
    authMode: 'local',
    storeMode: 'local_sqlite',
    setupRequired: false,
    envManaged: false
  };
  let latestReadiness = null;
  let orderPipelineViewMode = 'table'; // 'table' | 'kanban'
  let manualExtraItems = [];
  let cancelOrderArmed = false;
  let pendingDeleteCouponCode = '';

  const HIGH_RISK_UNIT_SET = new Set([
    'CAT-001',
    'FT-BA-001',
    'FT-BA-011',
    'FT-JWL-001',
    'FT-JWL-002',
    'FT-JWL-005'
  ]);

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function showAdminToast(message, type) {
    const wrap = document.getElementById('admin-toast-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'admin-toast ' + (type || 'ok');
    el.innerHTML = `<span>${escHtml(message)}</span><button type="button" style="background:none;border:none;color:inherit;cursor:pointer;font-size:14px" onclick="this.parentNode.remove()">✕</button>`;
    wrap.appendChild(el);
    if (window.Motion && typeof window.Motion.animate === 'function') {
      try {
        window.Motion.animate(el, { opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0px)'] }, { duration: 0.22 });
      } catch (_) {}
    }
    setTimeout(() => { if (el.parentNode) el.remove(); }, 4600);
  }

  function openExternalUrl(url) {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function copyToClipboard(text, successMsg) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showAdminToast(successMsg || 'Copied to clipboard!', 'ok');
      }).catch(() => {
        fallbackCopy(text, successMsg);
      });
    } else {
      fallbackCopy(text, successMsg);
    }
  }

  function fallbackCopy(text, successMsg) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showAdminToast(successMsg || 'Copied to clipboard!', 'ok');
    } catch (_) {
      showAdminToast('Copy failed — please copy manually.', 'err');
    }
    ta.remove();
  }

  function downloadCsvFile(filename, headers, rows) {
    const escapeCell = (val) => {
      const s = String(val == null ? '' : val);
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const lines = [
      headers.map(escapeCell).join(','),
      ...rows.map(r => r.map(escapeCell).join(','))
    ];
    // Prepend UTF-8 BOM so Microsoft Excel displays Bangla & ৳ cleanly
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ===================================================================== */
  /* AUTHENTICATED API CLIENT                                              */
  /* ===================================================================== */
  async function adminApiFetch(url, options) {
    const opts = options || {};
    if (!currentAccessToken) {
      showAuthGate('Please sign in to access boutique admin operations.');
      throw new Error('Authentication required.');
    }
    const headers = Object.assign(
      { Authorization: 'Bearer ' + currentAccessToken },
      opts.body ? { 'Content-Type': 'application/json' } : {},
      opts.headers || {}
    );
    const resp = await fetch(url, Object.assign({}, opts, { headers }));
    const json = await resp.json().catch(() => ({}));
    if (resp.status === 401 || resp.status === 403) {
      currentAccessToken = '';
      currentStaffUser = null;
      showAuthGate((json && json.error) || 'Your session expired. Please sign in again.');
      throw new Error((json && json.error) || 'Unauthorized');
    }
    if (!resp.ok || json.ok === false) {
      throw new Error((json && json.error) || `Request failed (${resp.status})`);
    }
    return json;
  }

  /* ===================================================================== */
  /* DUAL-MODE AUTHENTICATION GATE                                         */
  /* ===================================================================== */
  function configureAuthGateUI() {
    const kicker = document.getElementById('auth-mode-kicker');
    const title = document.getElementById('pin-gate-title');
    const desc = document.getElementById('auth-mode-desc');
    const fullNameWrap = document.getElementById('auth-fullname-wrap');
    const confirmWrap = document.getElementById('auth-confirm-wrap');
    const passInput = document.getElementById('admin-auth-password');
    const btn = document.getElementById('admin-signin-btn');

    if (authStatusState.authMode === 'local' && authStatusState.setupRequired) {
      if (kicker) kicker.textContent = 'First-Run Store Owner Setup';
      if (title) title.textContent = "Initialize Fariza's Territory Admin";
      if (desc) desc.textContent = 'Create your private Store Owner account once. Credentials are hashed server-side with scrypt and stored securely in your boutique database.';
      if (fullNameWrap) fullNameWrap.style.display = 'block';
      if (confirmWrap) confirmWrap.style.display = 'block';
      if (passInput) passInput.setAttribute('autocomplete', 'new-password');
      if (btn) btn.textContent = 'Create Owner Account & Enter Admin';
    } else if (authStatusState.authMode === 'local') {
      if (kicker) kicker.textContent = authStatusState.envManaged ? 'Store Admin Login (Env Managed)' : 'Store Owner Authentication';
      if (title) title.textContent = "Fariza's Territory Admin";
      if (desc) desc.textContent = 'Sign in with your Store Owner email and password to manage live orders, 53 SKUs, coupons, courier dispatch, and storefront settings.';
      if (fullNameWrap) fullNameWrap.style.display = 'none';
      if (confirmWrap) confirmWrap.style.display = 'none';
      if (passInput) passInput.setAttribute('autocomplete', 'current-password');
      if (btn) btn.textContent = 'Sign In to Admin Console';
    } else {
      if (kicker) kicker.textContent = 'Supabase Cloud Staff Authentication';
      if (title) title.textContent = "Fariza's Territory Admin";
      if (desc) desc.textContent = 'Sign in with your authorized boutique staff email and password (verified server-side against public.staff_users).';
      if (fullNameWrap) fullNameWrap.style.display = 'none';
      if (confirmWrap) confirmWrap.style.display = 'none';
      if (passInput) passInput.setAttribute('autocomplete', 'current-password');
      if (btn) btn.textContent = 'Sign In with Supabase Cloud';
    }
  }

  function showAuthGate(msg) {
    configureAuthGateUI();
    const gate = document.getElementById('admin-pin-gate');
    const err = document.getElementById('admin-pin-error');
    if (err) err.textContent = msg || '';
    if (gate) gate.classList.add('active');
  }

  function hideAuthGate() {
    const gate = document.getElementById('admin-pin-gate');
    if (gate) gate.classList.remove('active');
  }

  async function refreshAuthStatus() {
    try {
      const resp = await fetch('/api/auth/status', { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        authStatusState = {
          authMode: data.authMode || 'local',
          storeMode: data.storeMode || 'local_sqlite',
          setupRequired: Boolean(data.setupRequired),
          envManaged: Boolean(data.envManaged)
        };
      }
    } catch (_) {}
    configureAuthGateUI();
  }

  async function submitAdminAuthForm() {
    const emailEl = document.getElementById('admin-auth-email');
    const passEl = document.getElementById('admin-auth-password');
    const confirmEl = document.getElementById('admin-auth-password-confirm');
    const nameEl = document.getElementById('admin-auth-fullname');
    const errEl = document.getElementById('admin-pin-error');
    const btn = document.getElementById('admin-signin-btn');

    const email = emailEl ? emailEl.value.trim() : '';
    const password = passEl ? passEl.value : '';
    const confirmPassword = confirmEl ? confirmEl.value : '';
    const fullName = nameEl ? nameEl.value.trim() : '';

    if (!email || !password) {
      if (errEl) errEl.textContent = 'Email and password are required.';
      return;
    }

    if (authStatusState.authMode === 'local' && authStatusState.setupRequired) {
      if (password.length < 8) {
        if (errEl) errEl.textContent = 'Owner password must be at least 8 characters.';
        return;
      }
      if (password !== confirmPassword) {
        if (errEl) errEl.textContent = 'Passwords do not match.';
        return;
      }
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Authenticating…';
    }
    if (errEl) errEl.textContent = '';

    try {
      if (authStatusState.authMode === 'local') {
        const endpoint = authStatusState.setupRequired ? '/api/auth/setup' : '/api/auth/login';
        const payload = authStatusState.setupRequired
          ? { email, password, full_name: fullName || 'Store Owner' }
          : { email, password };
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const json = await resp.json().catch(() => ({}));
        const authToken = (json && (json.token || json.accessToken)) || '';
        if (!resp.ok || !json.ok || !authToken) {
          if (errEl) errEl.textContent = (json && json.error) || 'Authentication failed.';
          return;
        }
        currentAccessToken = authToken;
        currentStaffUser = json.user || { email, role: 'super_admin' };
        authStatusState.setupRequired = false;
        if (passEl) passEl.value = '';
        if (confirmEl) confirmEl.value = '';
        hideAuthGate();
        await bootAdminWorkspace();
        showAdminToast(endpoint === '/api/auth/setup' ? 'Store Owner account created and signed in!' : 'Signed in to Boutique Admin.', 'ok');
      } else {
        const sb = await window.FT_SUPABASE.ensureAuthClient();
        if (!sb || !sb.auth) {
          if (errEl) errEl.textContent = 'Supabase Auth client could not initialize. Check server environment configuration.';
          return;
        }
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error || !data || !data.session) {
          if (errEl) errEl.textContent = (error && error.message) || 'Invalid Supabase credentials.';
          return;
        }
        const ok = await verifyAndEnterSupabaseSession(data.session);
        if (ok && passEl) passEl.value = '';
      }
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Network error while authenticating.';
    } finally {
      if (btn) btn.disabled = false;
      configureAuthGateUI();
    }
  }

  async function verifyAndEnterSupabaseSession(session) {
    if (!session || !session.access_token) {
      showAuthGate('');
      return false;
    }
    currentAccessToken = session.access_token;
    try {
      const resp = await fetch('/api/auth/session', {
        headers: { Authorization: 'Bearer ' + currentAccessToken }
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json.ok) {
        currentAccessToken = '';
        const sb = await window.FT_SUPABASE.ensureAuthClient();
        if (sb && sb.auth) await sb.auth.signOut().catch(() => {});
        showAuthGate((json && json.error) || 'Account does not have boutique staff privileges.');
        return false;
      }
      currentStaffUser = json.user;
      hideAuthGate();
      await bootAdminWorkspace();
      return true;
    } catch (_) {
      currentAccessToken = '';
      showAuthGate('Could not verify staff session with server.');
      return false;
    }
  }

  async function signOutAdminPortal() {
    const token = currentAccessToken;
    currentAccessToken = '';
    currentStaffUser = null;
    currentOrders = [];
    currentCoupons = [];

    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token }
      }).catch(() => {});
    }
    try {
      if (authStatusState.authMode === 'supabase' && window.FT_SUPABASE) {
        const sb = await window.FT_SUPABASE.ensureAuthClient();
        if (sb && sb.auth) await sb.auth.signOut();
      }
    } catch (_) {}

    const staffEl = document.getElementById('admin-staff-email');
    if (staffEl) staffEl.textContent = 'Not signed in';
    const tbody = document.getElementById('orders-table-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--admin-text2)">Sign in to view boutique orders.</td></tr>';
    await refreshAuthStatus();
    showAuthGate('You have been signed out.');
    showAdminToast('Signed out securely.', 'ok');
  }

  async function submitChangeAdminPassword() {
    const curEl = document.getElementById('pwd-current');
    const newEl = document.getElementById('pwd-new');
    const confEl = document.getElementById('pwd-confirm');
    const current_password = curEl ? curEl.value : '';
    const new_password = newEl ? newEl.value : '';
    const confirm = confEl ? confEl.value : '';

    if (new_password.length < 8) {
      showAdminToast('New password must be at least 8 characters.', 'err');
      return;
    }
    if (new_password !== confirm) {
      showAdminToast('New password and confirmation do not match.', 'err');
      return;
    }
    try {
      await adminApiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password, new_password })
      });
      if (curEl) curEl.value = '';
      if (newEl) newEl.value = '';
      if (confEl) confEl.value = '';
      showAdminToast('Admin password updated successfully!', 'ok');
    } catch (err) {
      showAdminToast(err.message || 'Failed to update password.', 'err');
    }
  }

  /* ===================================================================== */
  /* DASHBOARD INITIALIZATION                                              */
  /* ===================================================================== */
  async function initDashboard() {
    await refreshAuthStatus();
    if (authStatusState.authMode === 'supabase' && window.FT_SUPABASE) {
      try {
        const sb = await window.FT_SUPABASE.ensureAuthClient();
        if (sb && sb.auth) {
          const { data } = await sb.auth.getSession();
          if (data && data.session) {
            const entered = await verifyAndEnterSupabaseSession(data.session);
            if (entered) return;
          }
        }
      } catch (_) {}
    }
    showAuthGate('');
  }

  function applyAdminProductOverrides(productsList) {
    if (!window.FT_CATALOG || !Array.isArray(productsList)) return;
    productsList.forEach(row => {
      const p = row && row.sku ? window.FT_CATALOG.PRODUCTS_BY_SKU[row.sku] : null;
      if (!p) return;
      if (row.priceBDT !== undefined && row.priceBDT !== null) p.priceBDT = Number(row.priceBDT);
      if (row.price_bdt !== undefined && row.price_bdt !== null) p.priceBDT = Number(row.price_bdt);
      if (row.is_available !== undefined) p.is_available = Boolean(row.is_available);
      if (row.stock_count !== undefined && row.stock_count !== null) p.stock_count = Number(row.stock_count);
      if (row.stock_verified !== undefined) p.stock_verified = Boolean(row.stock_verified);
      if (row.price_review !== undefined) p.price_review = Boolean(row.price_review);
      p.feed_eligible = row.feed_eligible !== undefined
        ? Boolean(row.feed_eligible)
        : (window.FT_COMMERCE ? window.FT_COMMERCE.isFeedEligibleProduct(p) : false);
    });
  }

  async function bootAdminWorkspace() {
    window.__FT_ADMIN_BOOTED = true;
    let health = null;
    try {
      const hr = await fetch('/api/health', { cache: 'no-store' });
      if (hr.ok) health = await hr.json();
    } catch (_) {}

    const staffEl = document.getElementById('admin-staff-email');
    if (staffEl && currentStaffUser && currentStaffUser.email) {
      staffEl.textContent = currentStaffUser.email;
    }

    const modeBadge = document.getElementById('admin-store-mode-badge');
    const statusText = document.getElementById('cloud-status-text');
    const backendInput = document.getElementById('set-sb-url');
    const pwdCard = document.getElementById('local-password-card');

    const isSupabase = (health && health.storeMode === 'supabase') || authStatusState.storeMode === 'supabase';
    if (statusText) {
      statusText.textContent = isSupabase
        ? 'Supabase PostgreSQL Cloud Connected'
        : 'Standalone SQLite Persistence Active';
      statusText.style.color = 'var(--admin-green)';
    }
    if (modeBadge) {
      modeBadge.textContent = isSupabase ? 'Storage: Supabase Cloud' : 'Storage: Server SQLite DB';
    }
    if (backendInput) {
      backendInput.value = isSupabase
        ? 'Supabase PostgreSQL Cloud (Server Managed)'
        : 'Standalone Server SQLite (data/boutique.sqlite)';
    }
    if (pwdCard) {
      pwdCard.style.display = (authStatusState.authMode === 'local' && !authStatusState.envManaged) ? 'block' : 'none';
    }

    // Load authoritative settings + 53-SKU catalog from server
    try {
      const [setRes, catRes] = await Promise.all([
        adminApiFetch('/api/admin/settings'),
        adminApiFetch('/api/admin/catalog')
      ]);
      if (setRes && setRes.settings) hydrateSettingsInputs(setRes.settings);
      if (catRes && Array.isArray(catRes.products)) applyAdminProductOverrides(catRes.products);
    } catch (err) {
      showAdminToast(err.message || 'Failed to sync store configuration.', 'err');
      return;
    }

    // Initialize Three.js + ThreeUI 3D Spatial Cockpit once
    if (window.FT_COCKPIT_3D && !window.__FT_COCKPIT_3D_READY) {
      window.__FT_COCKPIT_3D_READY = true;
      window.FT_COCKPIT_3D.init('cockpit-3d-canvas');
    }

    await Promise.all([
      refreshAdminData(),
      renderCouponsTable(),
      loadReadinessReport()
    ]);

    renderCatalogTable();
    populateManualOrderProducts();
    runCouponSimulator();
    buildAdCampaignUrl();
  }

  function getLiveDeliveryFees() {
    const d = parseInt((document.getElementById('set-fee-dhaka') || {}).value, 10);
    const o = parseInt((document.getElementById('set-fee-outside') || {}).value, 10);
    return {
      dhaka: Number.isFinite(d) && d >= 0 ? d : 80,
      outside_dhaka: Number.isFinite(o) && o >= 0 ? o : 150
    };
  }

  function hydrateSettingsInputs(settings) {
    if (!settings) return;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined && val !== null) el.value = val;
    };
    if (settings.whatsapp_number && (!window.FT_COMMERCE || !window.FT_COMMERCE.isPlaceholderWhatsapp(settings.whatsapp_number))) {
      setVal('set-wa', settings.whatsapp_number);
    } else {
      setVal('set-wa', '');
    }
    setVal('set-fb', settings.messenger_username || 'farizasterritory143');
    setVal('set-fb-url', settings.facebook_url || 'https://www.facebook.com/farizasterritory143');
    setVal('set-pixel', settings.meta_pixel_id || '1657670575734647');
    setVal('set-ga4', settings.ga4_measurement_id || '');
    setVal('set-fee-dhaka', settings.delivery_fee_dhaka ?? 80);
    setVal('set-fee-outside', settings.delivery_fee_outside ?? 150);
    setVal('set-free-threshold', settings.free_delivery_threshold ?? 3000);
    setVal('set-promo', settings.promo_text || '');

    const capiDs = document.getElementById('capi-dataset');
    if (capiDs && settings.meta_pixel_id) capiDs.value = settings.meta_pixel_id;
  }

  /* ===================================================================== */
  /* LAUNCH READINESS & SELLER SIGN-OFF AUDIT                              */
  /* ===================================================================== */
  async function loadReadinessReport() {
    if (!currentAccessToken) return;
    try {
      const data = await adminApiFetch('/api/admin/readiness');
      latestReadiness = data;
      renderReadinessView(data);
      updateReadinessBanner(data);
    } catch (err) {
      const grid = document.getElementById('readiness-checks-grid');
      if (grid) grid.innerHTML = `<div style="color:var(--admin-red);font-size:13px;">${escHtml(err.message || 'Could not load readiness report.')}</div>`;
    }
  }

  function updateReadinessBanner(readiness) {
    const banner = document.getElementById('setup-readiness-banner');
    if (!banner) return;
    const products = (window.FT_CATALOG && window.FT_CATALOG.PRODUCTS) || [];
    const feedCount = products.filter(p => p.feed_eligible).length;
    const fees = getLiveDeliveryFees();
    const threshold = parseInt((document.getElementById('set-free-threshold') || {}).value, 10);
    const freeThresh = Number.isFinite(threshold) && threshold >= 0 ? threshold : 3000;
    const passed = readiness && readiness.summary ? readiness.summary.passedChecks : 0;
    const totalChecks = readiness && readiness.summary ? readiness.summary.totalChecks : 6;

    const navBadge = document.getElementById('nav-count-readiness');
    if (navBadge && readiness && readiness.summary) {
      navBadge.textContent = `${passed}/${totalChecks}`;
    }

    banner.style.display = 'flex';
    banner.className = (feedCount === products.length && passed === totalChecks) ? 'readiness-banner ready' : 'readiness-banner';
    banner.innerHTML = `
      <div style="font-size:13px">
        <strong>Launch Readiness:</strong>
        <span class="tabular-nums">${passed}/${totalChecks}</span> Checks Passed ·
        <span class="tabular-nums">${feedCount}/${products.length}</span> SKUs Eligible for Meta Feed ·
        Dhaka <span class="tabular-nums">৳${fees.dhaka}</span> / Outside <span class="tabular-nums">৳${fees.outside_dhaka}</span> (Free ≥ <span class="tabular-nums">৳${freeThresh.toLocaleString()}</span>)
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${feedCount < products.length ? `<button type="button" class="btn-admin btn-admin-gold btn-admin-sm" onclick="bulkApproveAllCatalogForFeed()">Approve All 53 SKUs</button>` : ''}
        <button type="button" class="btn-admin btn-admin-sm" onclick="switchTab('readiness')">Open Launch Audit →</button>
      </div>
    `;
  }

  function renderReadinessView(data) {
    const grid = document.getElementById('readiness-checks-grid');
    const hrBody = document.getElementById('readiness-highrisk-body');
    if (!data) return;

    if (grid && Array.isArray(data.checks)) {
      const actionMap = {
        catalog_feed: { label: 'Open Catalog →', tab: 'catalog' },
        high_risk_units: { label: 'Filter 6 Flagged SKUs →', fn: 'jumpToHighRiskSkus()' },
        concierge_channel: { label: 'Configure WhatsApp →', tab: 'settings' },
        meta_capi: { label: 'Test Meta CAPI →', tab: 'settings' },
        coupons: { label: 'Manage Vouchers →', tab: 'coupons' }
      };

      grid.innerHTML = data.checks.map(c => {
        const act = actionMap[c.id];
        const actBtn = act
          ? (act.fn
            ? `<button type="button" class="btn-admin btn-admin-sm" style="margin-top:6px;align-self:flex-start" onclick="${act.fn}">${escHtml(act.label)}</button>`
            : `<button type="button" class="btn-admin btn-admin-sm" style="margin-top:6px;align-self:flex-start" onclick="switchTab('${act.tab}')">${escHtml(act.label)}</button>`)
          : '';
        return `
          <div class="readiness-item ${escHtml(c.status)}">
            <div class="readiness-item-head">
              <span>${escHtml(c.label)}</span>
              <span class="readiness-pill ${escHtml(c.status)}">${c.status === 'pass' ? 'READY' : (c.status === 'fail' ? 'BLOCKED' : 'ACTION')}</span>
            </div>
            <div style="font-size:12.5px;color:var(--admin-text2);line-height:1.45">${escHtml(c.detail)}</div>
            ${actBtn}
          </div>
        `;
      }).join('');
    }

    if (hrBody && Array.isArray(data.highRiskChecklist)) {
      hrBody.innerHTML = data.highRiskChecklist.map(item => `
        <tr>
          <td class="tabular-nums"><strong style="color:var(--admin-gold);cursor:pointer" onclick="openProductDetailModal('${escHtml(item.sku)}')">${escHtml(item.sku)}</strong></td>
          <td><strong>${escHtml(item.title)}</strong></td>
          <td><small style="color:var(--admin-text2)">${escHtml(item.unit)}</small></td>
          <td class="tabular-nums"><strong>৳ ${Number(item.priceBDT || 0).toLocaleString()}</strong></td>
          <td><small style="color:var(--admin-text2)">${escHtml(item.note)}</small></td>
          <td><span class="st-label ${item.verified ? 'st-delivered' : 'st-pending'}">${item.verified ? 'VERIFIED ✓' : 'NEEDS SIGN-OFF'}</span></td>
          <td>
            <button type="button" class="btn-admin btn-admin-sm ${item.verified ? '' : 'btn-admin-gold'}" onclick="openProductDetailModal('${escHtml(item.sku)}')">Inspect &amp; Sign Off</button>
          </td>
        </tr>
      `).join('');
    }
  }

  function jumpToHighRiskSkus() {
    switchTab('catalog');
    const colSel = document.getElementById('cat-col-filter');
    const feedSel = document.getElementById('cat-feed-filter');
    if (colSel) colSel.value = 'all';
    if (feedSel) feedSel.value = 'high_risk';
    renderCatalogTable();
  }

  /* ===================================================================== */
  /* ORDERS PIPELINE (TABLE + KANBAN + INSPECTOR + CANCELLATION)           */
  /* ===================================================================== */
  async function refreshAdminData() {
    if (!currentAccessToken) return;
    try {
      const res = await adminApiFetch('/api/admin/orders');
      currentOrders = Array.isArray(res.orders) ? res.orders : [];
    } catch (err) {
      showAdminToast(err.message || 'Failed to load orders.', 'err');
      return;
    }

    renderKPIs(currentOrders);
    applyOrderFilters();
    renderCustomersTable();
    renderCourierTable();
    syncSidebarCounts();

    if (window.FT_COCKPIT_3D) {
      window.FT_COCKPIT_3D.updateTelemetry({
        orders: currentOrders,
        products: window.FT_CATALOG ? window.FT_CATALOG.PRODUCTS : []
      });
    }
  }

  function syncSidebarCounts() {
    const products = (window.FT_CATALOG && window.FT_CATALOG.PRODUCTS) || [];
    const feedCount = products.filter(p => p.feed_eligible).length;
    const courierReady = currentOrders.filter(o => ['confirmed', 'processing', 'shipped'].includes(o.status)).length;

    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    setText('nav-count-orders', String(currentOrders.length));
    setText('nav-count-catalog', String(products.length));
    setText('nav-count-courier', String(courierReady));
    setText('subbar-feed-summary', `${feedCount}/${products.length} SKUs Feed Ready`);
    setText('kpi-feed-ready', `${feedCount} / ${products.length}`);
  }

  function animateCounter(el, targetVal, prefix, suffix) {
    if (!el) return;
    const pfx = prefix || '';
    const sfx = suffix || '';
    if (!window.anime || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = pfx + Number(targetVal).toLocaleString('en-US') + sfx;
      return;
    }
    const obj = { val: 0 };
    window.anime({
      targets: obj,
      val: targetVal,
      duration: 700,
      easing: 'easeOutExpo',
      update: () => {
        el.textContent = pfx + Math.floor(obj.val).toLocaleString('en-US') + sfx;
      }
    });
  }

  function renderKPIs(orders) {
    const activeOrders = orders.filter(o => o.status !== 'cancelled');
    const pendingCount = orders.filter(o => o.status === 'pending').length;
    const shippedCount = orders.filter(o => o.status === 'shipped').length;
    const totalRev = activeOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    const aov = activeOrders.length > 0 ? Math.round(totalRev / activeOrders.length) : 0;
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayCount = orders.filter(o => (o.created_at || '').startsWith(todayStr)).length;

    animateCounter(document.getElementById('kpi-total-orders'), orders.length);
    animateCounter(document.getElementById('kpi-pending-orders'), pendingCount);
    animateCounter(document.getElementById('kpi-shipped-orders'), shippedCount);
    animateCounter(document.getElementById('kpi-total-revenue'), totalRev, '৳ ');
    const todayEl = document.getElementById('kpi-today-orders');
    if (todayEl) todayEl.textContent = `${todayCount} inquiries today`;
    const aovEl = document.getElementById('kpi-aov-sub');
    if (aovEl) aovEl.textContent = `Avg Order: ৳ ${aov.toLocaleString('en-US')}`;
  }

  function getNextRecommendedAction(order) {
    const st = order.status || 'pending';
    if (st === 'pending') return { next: 'confirmed', label: 'Confirm & CAPI →', cls: 'btn-admin-primary' };
    if (st === 'confirmed') return { next: 'processing', label: 'Pack Order →', cls: '' };
    if (st === 'processing') return { next: 'shipped', label: 'Dispatch Courier →', cls: '' };
    if (st === 'shipped') return { next: 'delivered', label: 'Mark Delivered ✓', cls: '' };
    return null;
  }

  async function quickAdvanceOrderStatus(ref, nextStatus) {
    const order = currentOrders.find(o => o.order_ref === ref);
    if (!order) return;

    if (window.FT_COMMERCE && !window.FT_COMMERCE.isValidStatusTransition(order.status, nextStatus)) {
      showAdminToast(`Cannot transition directly from ${order.status} to ${nextStatus}.`, 'err');
      return;
    }

    try {
      const res = await adminApiFetch('/api/admin/orders/' + encodeURIComponent(ref), {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus })
      });
      await refreshAdminData();
      const capiMsg = res && res.capi_purchase
        ? (res.capi_purchase.success ? ' · Server Purchase CAPI Fired ✓' : ' · CAPI queued/skipped')
        : '';
      showAdminToast(`Order ${ref} → ${nextStatus.toUpperCase()}${capiMsg}`, 'ok');
    } catch (err) {
      showAdminToast(err.message || 'Failed to update status.', 'err');
    }
  }

  function renderOrdersTable(orders) {
    const tbody = document.getElementById('orders-table-body');
    if (!tbody) return;
    if (!orders || orders.length === 0) {
      const isFiltered = (document.getElementById('order-search').value || '').trim() !== '' ||
        document.getElementById('order-status-filter').value !== 'all' ||
        document.getElementById('order-zone-filter').value !== 'all';
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align:center;padding:42px 24px;color:var(--admin-text2)">
            <div style="font-size:15px;font-weight:600;color:var(--admin-text);margin-bottom:6px;">
              ${isFiltered ? 'No orders match your current filters.' : 'No customer orders recorded yet.'}
            </div>
            <div style="font-size:12.5px;margin-bottom:14px;">
              ${isFiltered ? 'Clear your search or status filter to view all orders.' : 'Live storefront COD inquiries and manual concierge orders will appear here instantly.'}
            </div>
            <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
              ${isFiltered ? `<button type="button" class="btn-admin btn-admin-sm" onclick="resetOrderFilters()">Reset Filters</button>` : ''}
              <button type="button" class="btn-admin btn-admin-primary btn-admin-sm" onclick="openNewOrderModal()">+ Create Manual Order</button>
            </div>
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = orders.map(o => {
      const ref = o.order_ref || 'N/A';
      const date = o.created_at ? new Date(o.created_at).toLocaleDateString('en-GB') : 'Recent';
      const name = o.customer_name || 'Guest Customer';
      const phone = o.customer_phone || '';
      const address = o.customer_address || '';
      const total = Number(o.total || 0).toLocaleString();
      const st = o.status || 'pending';
      const piecesCount = Array.isArray(o.items) ? o.items.reduce((s, it) => s + (Number(it.qty) || 1), 0) : 1;
      const firstSku = Array.isArray(o.items) && o.items[0] ? o.items[0].sku : '';
      const nextAct = getNextRecommendedAction(o);

      return `
        <tr class="order-row">
          <td class="tabular-nums">
            <strong style="color:var(--admin-gold);cursor:pointer;" onclick="openOrderDetail('${escHtml(ref)}')">${escHtml(ref)}</strong>
            ${o.purchase_capi_sent_at ? `<span style="font-size:11px;color:var(--admin-green);margin-left:6px;" title="Server Purchase CAPI Sent (${escHtml(o.purchase_capi_event_id || '')})">· CAPI ✓</span>` : ''}
          </td>
          <td class="tabular-nums">${escHtml(date)}</td>
          <td><strong>${escHtml(name)}</strong></td>
          <td class="tabular-nums"><a href="tel:${escHtml(phone)}" style="color:var(--admin-text);text-decoration:underline;">${escHtml(phone)}</a></td>
          <td><small style="color:var(--admin-text2)">${escHtml(address.slice(0, 36))}${address.length > 36 ? '…' : ''}</small></td>
          <td class="tabular-nums">${piecesCount} pc${piecesCount > 1 ? 's' : ''} ${firstSku ? `<span style="color:var(--admin-muted)">· ${escHtml(firstSku)}</span>` : ''}</td>
          <td class="tabular-nums"><strong>৳ ${total}</strong></td>
          <td><span class="st-label st-${escHtml(st)}">${escHtml(st.toUpperCase())}</span></td>
          <td>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:nowrap;">
              ${nextAct ? `<button type="button" class="btn-admin btn-admin-sm ${nextAct.cls}" onclick="quickAdvanceOrderStatus('${escHtml(ref)}', '${nextAct.next}')">${escHtml(nextAct.label)}</button>` : ''}
              <button type="button" class="btn-admin btn-admin-sm" onclick="openOrderDetail('${escHtml(ref)}')">Inspect</button>
              <button type="button" class="btn-admin btn-admin-sm" onclick="quickWhatsAppCustomer('${escHtml(ref)}')" title="Message on WhatsApp" style="color:#2ECC71">WA</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderOrdersKanban(orders) {
    const wrap = document.getElementById('orders-kanban-wrap');
    if (!wrap) return;

    const columns = [
      { key: 'pending', label: '01. Pending Verify', color: 'var(--admin-gold)' },
      { key: 'confirmed', label: '02. Confirmed · CAPI', color: 'var(--admin-blue)' },
      { key: 'processing', label: '03. Packing', color: 'var(--admin-purple)' },
      { key: 'shipped', label: '04. In Transit', color: '#38BDF8' },
      { key: 'delivered', label: '05. Delivered COD', color: 'var(--admin-green)' }
    ];

    wrap.innerHTML = columns.map(col => {
      const colOrders = (orders || []).filter(o => (o.status || 'pending') === col.key);
      const cardsHtml = colOrders.length === 0
        ? `<div style="font-size:12px;color:var(--admin-muted);text-align:center;padding:24px 8px;">No orders in stage</div>`
        : colOrders.map(o => {
            const nextAct = getNextRecommendedAction(o);
            const skus = Array.isArray(o.items) ? o.items.map(i => `${i.sku}×${i.qty || 1}`).join(', ') : '';
            return `
              <div class="kanban-card" onclick="openOrderDetail('${escHtml(o.order_ref)}')">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <strong class="tabular-nums" style="font-size:12px;color:var(--admin-gold)">${escHtml(o.order_ref)}</strong>
                  <span class="tabular-nums" style="font-size:12.5px;font-weight:700">৳ ${Number(o.total || 0).toLocaleString()}</span>
                </div>
                <div style="font-size:13px;font-weight:600">${escHtml(o.customer_name)}</div>
                <div class="tabular-nums" style="font-size:11.5px;color:var(--admin-text2)">${escHtml(o.customer_phone)} · ${escHtml(skus)}</div>
                ${nextAct ? `
                  <div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--admin-border);" onclick="event.stopPropagation()">
                    <button type="button" class="btn-admin btn-admin-sm ${nextAct.cls}" style="width:100%;justify-content:center;" onclick="quickAdvanceOrderStatus('${escHtml(o.order_ref)}', '${nextAct.next}')">${escHtml(nextAct.label)}</button>
                  </div>
                ` : ''}
              </div>
            `;
          }).join('');

      return `
        <div class="kanban-col">
          <div class="kanban-col-head">
            <span style="color:${col.color}">${col.label}</span>
            <span class="tabular-nums" style="color:var(--admin-text2)">${colOrders.length}</span>
          </div>
          ${cardsHtml}
        </div>
      `;
    }).join('');
  }

  function setOrderPipelineView(mode) {
    orderPipelineViewMode = mode === 'kanban' ? 'kanban' : 'table';
    document.getElementById('view-btn-table').classList.toggle('active', orderPipelineViewMode === 'table');
    document.getElementById('view-btn-kanban').classList.toggle('active', orderPipelineViewMode === 'kanban');
    document.getElementById('orders-table-wrap').style.display = orderPipelineViewMode === 'table' ? 'block' : 'none';
    document.getElementById('orders-kanban-wrap').style.display = orderPipelineViewMode === 'kanban' ? 'grid' : 'none';
    applyOrderFilters();
  }

  function applyOrderFilters() {
    const q = (document.getElementById('order-search').value || '').toLowerCase();
    const st = document.getElementById('order-status-filter').value;
    const zone = document.getElementById('order-zone-filter').value;

    const filtered = currentOrders.filter(o => {
      const skuStr = Array.isArray(o.items) ? o.items.map(i => i.sku).join(' ').toLowerCase() : '';
      const matchQ = !q || (o.customer_name || '').toLowerCase().includes(q) ||
                           (o.customer_phone || '').includes(q) ||
                           (o.order_ref || '').toLowerCase().includes(q) ||
                           (o.customer_address || '').toLowerCase().includes(q) ||
                           skuStr.includes(q);
      const matchSt = st === 'all' || (o.status || 'pending') === st;
      const normZone = window.FT_COMMERCE ? window.FT_COMMERCE.normalizeZone(o.delivery_zone, o.customer_district) : (o.delivery_zone || 'dhaka');
      const matchZone = zone === 'all' || normZone === zone;
      return matchQ && matchSt && matchZone;
    });

    renderOrdersTable(filtered);
    if (orderPipelineViewMode === 'kanban') {
      renderOrdersKanban(filtered);
    }
  }

  function resetOrderFilters() {
    document.getElementById('order-search').value = '';
    document.getElementById('order-status-filter').value = 'all';
    document.getElementById('order-zone-filter').value = 'all';
    applyOrderFilters();
  }

  function quickFilterOrdersByStatus(status) {
    switchTab('orders');
    document.getElementById('order-status-filter').value = status || 'all';
    applyOrderFilters();
  }

  function getOrderDeliveryFee(o) {
    if (o && o.delivery_fee !== undefined && o.delivery_fee !== null) {
      return Number(o.delivery_fee);
    }
    const fees = getLiveDeliveryFees();
    const isOut = o && (o.delivery_zone === 'outside' || o.delivery_zone === 'outside_dhaka');
    return isOut ? fees.outside_dhaka : fees.dhaka;
  }

  function openOrderDetail(ref) {
    selectedOrder = currentOrders.find(o => o.order_ref === ref);
    if (!selectedOrder) return;
    cancelOrderArmed = false;

    document.getElementById('modal-order-title').textContent = `Order ${selectedOrder.order_ref} — ${selectedOrder.customer_name}`;

    const cancelBtn = document.getElementById('modal-cancel-order-btn');
    if (cancelBtn) {
      const canCancel = ['pending', 'confirmed', 'processing'].includes(selectedOrder.status);
      cancelBtn.style.display = canCancel ? 'inline-flex' : 'none';
      cancelBtn.textContent = 'Cancel Order';
    }

    let itemsHtml = '';
    if (Array.isArray(selectedOrder.items)) {
      itemsHtml = selectedOrder.items.map(it => {
        const prod = window.FT_CATALOG && window.FT_CATALOG.PRODUCTS_BY_SKU ? window.FT_CATALOG.PRODUCTS_BY_SKU[it.sku] : null;
        const imgPath = it.image || (prod && prod.assets && prod.assets.main) || `assets/products/${it.sku}/main.webp`;
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--admin-border)">
            <img src="/${escHtml(String(imgPath).replace(/^\/+/, ''))}" alt="${escHtml(it.title || it.sku)}" referrerPolicy="no-referrer" style="width:48px;height:60px;object-fit:cover;border-radius:6px;" onerror="this.style.display='none'">
            <div style="flex:1">
              <div style="font-weight:600">${escHtml(it.title || (prod && prod.title) || it.sku)}</div>
              <small class="tabular-nums" style="color:var(--admin-text2)">SKU: ${escHtml(it.sku)} · Qty: ${Number(it.qty || 1)}</small>
            </div>
            <div class="tabular-nums"><strong>৳ ${Number(it.price || (prod && prod.priceBDT) || 0).toLocaleString()}</strong></div>
          </div>
        `;
      }).join('');
    }

    const historyHtml = Array.isArray(selectedOrder.status_history)
      ? selectedOrder.status_history.map(h => `
          <div style="display:flex;justify-content:space-between;gap:12px;font-size:12px;padding:5px 0;border-bottom:1px solid rgba(253,240,221,0.05);">
            <span><strong style="color:var(--admin-gold)">${escHtml((h.status || '').toUpperCase())}</strong> · ${escHtml(h.note || '')}</span>
            <span class="tabular-nums" style="color:var(--admin-muted);white-space:nowrap">${h.time ? new Date(h.time).toLocaleString('en-GB') : ''}</span>
          </div>
        `).join('')
      : '';

    const feeVal = getOrderDeliveryFee(selectedOrder);

    document.getElementById('modal-order-body').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:18px;">
        <div>
          <label style="font-size:12px;color:var(--admin-text2)">Customer Name</label>
          <div style="font-size:16px;font-weight:600;margin-top:2px">${escHtml(selectedOrder.customer_name)}</div>
          <label style="font-size:12px;color:var(--admin-text2);margin-top:10px;display:block">Phone</label>
          <div class="tabular-nums" style="margin-top:2px"><a href="tel:${escHtml(selectedOrder.customer_phone)}" style="color:var(--admin-gold)">${escHtml(selectedOrder.customer_phone)}</a></div>
          <label style="font-size:12px;color:var(--admin-text2);margin-top:10px;display:block">Delivery Address (Editable)</label>
          <textarea id="modal-customer-address" rows="2" class="search-input" style="width:100%;margin-top:4px;min-width:0;">${escHtml(selectedOrder.customer_address || '')}</textarea>
          <label style="font-size:12px;color:var(--admin-text2);margin-top:10px;display:block">Customer / Concierge Notes</label>
          <textarea id="modal-customer-notes" rows="2" class="search-input" style="width:100%;margin-top:4px;min-width:0;" placeholder="Sizing note, preferred delivery time…">${escHtml(selectedOrder.customer_notes || '')}</textarea>
        </div>
        <div>
          <label style="font-size:12px;color:var(--admin-text2)">Order Status (Confirmed fires Server Purchase CAPI)</label>
          <select id="modal-order-status" class="filter-select" style="width:100%;margin-top:4px">
            <option value="pending" ${selectedOrder.status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="confirmed" ${selectedOrder.status === 'confirmed' ? 'selected' : ''}>Confirmed</option>
            <option value="processing" ${selectedOrder.status === 'processing' ? 'selected' : ''}>Processing</option>
            <option value="shipped" ${selectedOrder.status === 'shipped' ? 'selected' : ''}>Shipped</option>
            <option value="delivered" ${selectedOrder.status === 'delivered' ? 'selected' : ''}>Delivered</option>
            <option value="cancelled" ${selectedOrder.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
          </select>
          <label style="font-size:12px;color:var(--admin-text2);margin-top:10px;display:block">Status Update Audit Note (Optional)</label>
          <input type="text" id="modal-status-note" value="" placeholder="e.g. Confirmed via phone call" class="search-input" style="width:100%;margin-top:4px;min-width:0;">
          <label style="font-size:12px;color:var(--admin-text2);margin-top:10px;display:block">Courier Partner</label>
          <select id="modal-courier-name" class="filter-select" style="width:100%;margin-top:4px">
            <option value="Steadfast Courier" ${(selectedOrder.courier_name || '') === 'Steadfast Courier' ? 'selected' : ''}>Steadfast Courier</option>
            <option value="Pathao Courier" ${(selectedOrder.courier_name || '') === 'Pathao Courier' ? 'selected' : ''}>Pathao Courier</option>
            <option value="RedX" ${(selectedOrder.courier_name || '') === 'RedX' ? 'selected' : ''}>RedX Logistics</option>
          </select>
          <label style="font-size:12px;color:var(--admin-text2);margin-top:10px;display:block">Tracking Number</label>
          <input type="text" id="modal-tracking-num" value="${escHtml(selectedOrder.tracking_number || '')}" placeholder="e.g. STF-12345" class="search-input tabular-nums" style="width:100%;margin-top:4px;min-width:0;">
        </div>
      </div>
      <div style="margin:16px 0">
        <label style="font-size:12px;color:var(--admin-text2);font-weight:600">Ordered Pieces</label>
        <div style="margin-top:6px">${itemsHtml}</div>
      </div>
      <div class="tabular-nums" style="background:var(--admin-surface2);padding:16px;border-radius:10px;font-size:13.5px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span>Subtotal:</span> <span>৳ ${Number(selectedOrder.subtotal || 0).toLocaleString()}</span>
        </div>
        ${selectedOrder.discount_amount ? `
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;color:var(--admin-green)">
            <span>Discount (${escHtml(selectedOrder.discount_code || 'Voucher')}):</span> <span>- ৳ ${Number(selectedOrder.discount_amount).toLocaleString()}</span>
          </div>
        ` : ''}
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span>Delivery Fee:</span> <span>৳ ${feeVal.toLocaleString()}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-weight:700;font-size:16px;padding-top:8px;border-top:1px solid var(--admin-border)">
          <span>Total COD Payable:</span> <span style="color:var(--admin-gold)">৳ ${Number(selectedOrder.total || 0).toLocaleString()}</span>
        </div>
      </div>
      ${historyHtml ? `
        <div>
          <label style="font-size:12px;color:var(--admin-text2);font-weight:600">Audit Trail &amp; Status History</label>
          <div style="margin-top:6px;background:var(--admin-bg);padding:10px 14px;border-radius:8px;border:1px solid var(--admin-border)">${historyHtml}</div>
        </div>
      ` : ''}
    `;

    document.getElementById('order-modal').classList.add('open');
  }

  function closeOrderModal() {
    document.getElementById('order-modal').classList.remove('open');
    selectedOrder = null;
    cancelOrderArmed = false;
  }

  async function saveOrderModalChanges() {
    if (!selectedOrder) return;
    const ref = selectedOrder.order_ref;
    const newStatus = document.getElementById('modal-order-status').value;
    const courier = document.getElementById('modal-courier-name').value.trim();
    const tracking = document.getElementById('modal-tracking-num').value.trim();
    const customerAddress = (document.getElementById('modal-customer-address') || {}).value || '';
    const customerNotes = (document.getElementById('modal-customer-notes') || {}).value || '';
    const statusNote = (document.getElementById('modal-status-note') || {}).value || '';

    if (window.FT_COMMERCE && !window.FT_COMMERCE.isValidStatusTransition(selectedOrder.status, newStatus)) {
      showAdminToast(`Invalid transition from '${selectedOrder.status}' to '${newStatus}'.`, 'err');
      return;
    }

    try {
      const payload = {
        status: newStatus,
        courier_name: courier,
        tracking_number: tracking,
        customer_address: customerAddress.trim(),
        customer_notes: customerNotes.trim()
      };
      if (statusNote.trim()) payload.note = statusNote.trim();

      const res = await adminApiFetch('/api/admin/orders/' + encodeURIComponent(ref), {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      closeOrderModal();
      await refreshAdminData();
      const capiNote = res && res.capi_purchase
        ? (res.capi_purchase.success ? ' · Meta Purchase CAPI dispatched' : ' · CAPI queued/skipped')
        : '';
      showAdminToast(`Order ${ref} saved${capiNote}!`, 'ok');
    } catch (err) {
      showAdminToast(err.message || 'Failed to update order.', 'err');
    }
  }

  async function cancelSelectedOrder() {
    if (!selectedOrder) return;
    const btn = document.getElementById('modal-cancel-order-btn');
    if (!cancelOrderArmed) {
      cancelOrderArmed = true;
      if (btn) btn.textContent = 'Click again to confirm cancellation';
      showAdminToast('Click "Cancel Order" again to confirm cancelling ' + selectedOrder.order_ref + '.', 'err');
      return;
    }
    const ref = selectedOrder.order_ref;
    try {
      await adminApiFetch('/api/admin/orders/' + encodeURIComponent(ref), {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'cancelled',
          note: 'Cancelled by staff from Order Inspector'
        })
      });
      closeOrderModal();
      await refreshAdminData();
      showAdminToast(`Order ${ref} has been cancelled.`, 'ok');
    } catch (err) {
      cancelOrderArmed = false;
      if (btn) btn.textContent = 'Cancel Order';
      showAdminToast(err.message || 'Failed to cancel order.', 'err');
    }
  }

  function quickWhatsAppCustomer(ref) {
    const order = currentOrders.find(o => o.order_ref === ref);
    if (!order) return;
    const cleanPhone = (order.customer_phone || '').replace(/[^0-9]/g, '');
    const fullPhone = cleanPhone.startsWith('88') ? cleanPhone : ('88' + cleanPhone);
    const msg = `Assalamu Alaikum ${order.customer_name},\nThis is Fariza's Territory regarding your boutique order ${order.order_ref}.\nTotal amount: ৳ ${Number(order.total || 0).toLocaleString()} (Cash on Delivery).\nDelivery address: ${order.customer_address}.\nPlease let us know if you have any questions!`;
    openExternalUrl(`https://wa.me/${fullPhone}?text=${encodeURIComponent(msg)}`);
  }

  function printCurrentOrderInvoice() {
    if (!selectedOrder) return;
    const o = selectedOrder;
    const printArea = document.getElementById('print-area');
    const feeVal = getOrderDeliveryFee(o);

    printArea.innerHTML = `
      <div style="max-width:700px;margin:0 auto;font-family:sans-serif;color:#111;padding:20px;border:1px solid #ccc">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px">
          <div>
            <h1 style="margin:0;font-size:24px;letter-spacing:1px">FARIZA'S TERRITORY</h1>
            <small>Fashion &amp; Accessories Brand by Faria &amp; Saiful Islam Shuvo · Mirpur, Dhaka</small>
          </div>
          <div style="text-align:right">
            <h3 style="margin:0;color:#C6952B">COD INVOICE</h3>
            <div><b>Ref: ${escHtml(o.order_ref)}</b></div>
            <small>${new Date(o.created_at || Date.now()).toLocaleDateString('en-GB')}</small>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:18px;font-size:13px;">
          <div>
            <div style="font-weight:700;margin-bottom:4px">BILL &amp; SHIP TO:</div>
            <div><b>${escHtml(o.customer_name)}</b></div>
            <div>Phone: ${escHtml(o.customer_phone)}</div>
            <div>${escHtml(o.customer_address)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:700;margin-bottom:4px">FULFILLMENT:</div>
            <div>Courier: ${escHtml(o.courier_name || 'Steadfast Courier')}</div>
            <div>Tracking: ${escHtml(o.tracking_number || 'Pending')}</div>
            <div>Payment: <b>Cash on Delivery (COD)</b></div>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <thead>
            <tr style="background:#f2f2f2;border-bottom:1px solid #ccc;text-align:left">
              <th style="padding:8px">Item</th>
              <th style="padding:8px">SKU</th>
              <th style="padding:8px;text-align:center">Qty</th>
              <th style="padding:8px;text-align:right">Price</th>
              <th style="padding:8px;text-align:right">Total</th>
            </tr>
          </thead>
          <tbody>
            ${(o.items || []).map(it => `
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:8px">${escHtml(it.title || it.sku)}</td>
                <td style="padding:8px">${escHtml(it.sku)}</td>
                <td style="padding:8px;text-align:center">${Number(it.qty || 1)}</td>
                <td style="padding:8px;text-align:right">৳ ${Number(it.price || 0).toLocaleString()}</td>
                <td style="padding:8px;text-align:right">৳ ${(Number(it.price || 0) * Number(it.qty || 1)).toLocaleString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div style="width:300px;margin-left:auto;margin-bottom:24px">
          <div style="display:flex;justify-content:space-between;padding:4px 0"><span>Subtotal:</span> <span>৳ ${Number(o.subtotal || 0).toLocaleString()}</span></div>
          ${o.discount_amount ? `<div style="display:flex;justify-content:space-between;padding:4px 0;color:green"><span>Discount (${escHtml(o.discount_code || 'Voucher')}):</span> <span>- ৳ ${Number(o.discount_amount).toLocaleString()}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;padding:4px 0"><span>Delivery Fee:</span> <span>৳ ${feeVal.toLocaleString()}</span></div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-top:2px solid #111;font-size:18px;font-weight:700"><span>Cash to Collect:</span> <span>৳ ${Number(o.total || 0).toLocaleString()}</span></div>
        </div>
        <div style="text-align:center;border-top:1px dashed #ccc;padding-top:12px;font-size:12px;color:#555">
          Thank you for choosing Fariza's Territory! Mirpur, Dhaka, Bangladesh · facebook.com/farizasterritory143
        </div>
      </div>
    `;

    printArea.style.display = 'block';
    window.print();
    printArea.style.display = 'none';
  }

  function exportOrdersCSV() {
    if (currentOrders.length === 0) {
      showAdminToast('No orders to export yet.', 'err');
      return;
    }
    const headers = ['Order Ref', 'Date', 'Customer Name', 'Phone', 'Address', 'Zone', 'Subtotal', 'Discount', 'Delivery Fee', 'Total', 'Status', 'Courier', 'Tracking'];
    const rows = currentOrders.map(o => [
      o.order_ref,
      o.created_at || '',
      o.customer_name || '',
      o.customer_phone || '',
      o.customer_address || '',
      o.delivery_zone || 'dhaka',
      o.subtotal || 0,
      o.discount_amount || 0,
      getOrderDeliveryFee(o),
      o.total || 0,
      o.status || 'pending',
      o.courier_name || 'Steadfast Courier',
      o.tracking_number || ''
    ]);
    downloadCsvFile(`Farizas_Territory_Orders_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
    showAdminToast('Exported ' + currentOrders.length + ' orders to CSV.', 'ok');
  }

  /* ===================================================================== */
  /* CATALOG (53 SKUS), STOCK MANAGEMENT & ATOMIC BULK APPROVAL            */
  /* ===================================================================== */
  function getFilteredCatalogProducts() {
    const col = (document.getElementById('cat-col-filter') || {}).value || 'all';
    const feedFilter = (document.getElementById('cat-feed-filter') || {}).value || 'all';
    const searchEl = document.getElementById('cat-search');
    const q = (searchEl ? searchEl.value : '').trim().toLowerCase();
    const products = window.FT_CATALOG ? window.FT_CATALOG.PRODUCTS : [];

    return products.filter(p => {
      if (col === 'fashion_all' && p.superCategory !== 'Fashion') return false;
      else if (col === 'acc_all' && p.superCategory !== 'Accessories') return false;
      else if (col !== 'all' && col !== 'fashion_all' && col !== 'acc_all' && p.colId !== col && p.col !== col) return false;

      if (feedFilter === 'eligible' && !p.feed_eligible) return false;
      if (feedFilter === 'pending' && p.feed_eligible) return false;
      if (feedFilter === 'out' && p.is_available !== false && Number(p.stock_count ?? 1) > 0) return false;
      if (feedFilter === 'high_risk' && !HIGH_RISK_UNIT_SET.has(p.sku)) return false;

      if (!q) return true;
      const hay = [p.sku, p.title, p.titleBn, p.fabric, p.unit, p.unitBn, p.collection && p.collection.name].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function renderCatalogTable() {
    const tbody = document.getElementById('catalog-table-body');
    if (!tbody) return;
    const filtered = getFilteredCatalogProducts();

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--admin-text2)">No SKUs match your current filter.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(p => {
      const imgSrc = '/' + ((p.assets && typeof p.assets.main === 'string') ? p.assets.main : ('assets/products/' + p.sku + '/main.webp')).replace(/^\/+/, '');
      const colShort = p.collection ? p.collection.short : (p.collectionShort || '');
      const pillar = p.superCategory || (p.collection ? p.collection.pillar : 'Fashion');
      const unit = p.unitBn || p.unit || '';
      const stockNum = p.stock_count !== undefined && p.stock_count !== null ? Number(p.stock_count) : null;
      const isLive = p.is_available !== false && (stockNum === null || stockNum > 0);
      const isHighRisk = HIGH_RISK_UNIT_SET.has(p.sku);

      return `
        <tr>
          <td><img src="${escHtml(imgSrc)}" alt="${escHtml(p.title)}" referrerPolicy="no-referrer" style="width:42px;height:52px;object-fit:cover;border-radius:6px;cursor:pointer;" onclick="openProductDetailModal('${escHtml(p.sku)}')" onerror="this.style.display='none'"></td>
          <td class="tabular-nums">
            <strong style="color:var(--admin-gold);cursor:pointer;" onclick="openProductDetailModal('${escHtml(p.sku)}')">${escHtml(p.sku)}</strong>
            ${isHighRisk ? `<div style="font-size:10.5px;color:#FBBF24;margin-top:2px;">⚠ Unit Check</div>` : ''}
          </td>
          <td>
            <div style="font-weight:600">${escHtml(p.title)}</div>
            <small style="color:var(--admin-text2)">${escHtml(p.titleBn || '')}</small>
          </td>
          <td>
            <span style="color:var(--admin-text)">${escHtml(colShort)}</span>
            <span style="color:var(--admin-muted)"> · </span>
            <span style="color:var(--admin-gold);font-size:12px">${escHtml(pillar)}</span>
          </td>
          <td><small style="color:var(--admin-text2)">${escHtml(unit)}</small></td>
          <td class="tabular-nums"><strong>৳ ${p.priceBDT ? p.priceBDT.toLocaleString() : 'Inquire'}</strong></td>
          <td class="tabular-nums">
            <span class="st-label ${isLive ? 'st-delivered' : 'st-cancelled'}">${isLive ? 'LIVE' : 'OUT'}</span>
            ${stockNum !== null ? `<span style="color:var(--admin-text2);font-size:12px;margin-left:4px;">(${stockNum})</span>` : ''}
            <span style="color:var(--admin-muted)"> · </span>
            <span style="font-size:12px;color:${p.feed_eligible ? 'var(--admin-green)' : 'var(--admin-gold)'}">${p.feed_eligible ? 'Feed ✓' : 'Hold'}</span>
          </td>
          <td>
            <div style="display:flex;gap:6px;align-items:center;">
              <button type="button" class="btn-admin btn-admin-sm" onclick="quickToggleSkuFeed('${escHtml(p.sku)}')">${p.feed_eligible ? 'Hold Feed' : 'Approve ✓'}</button>
              <button type="button" class="btn-admin btn-admin-sm" onclick="openProductDetailModal('${escHtml(p.sku)}')">3D Inspect</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function quickToggleSkuFeed(sku) {
    if (!window.FT_CATALOG) return;
    const p = window.FT_CATALOG.PRODUCTS_BY_SKU[sku];
    if (!p) return;
    const nextEligible = !p.feed_eligible;

    try {
      await adminApiFetch('/api/admin/products/' + encodeURIComponent(sku), {
        method: 'PATCH',
        body: JSON.stringify({
          price_bdt: p.priceBDT,
          is_available: true,
          stock_verified: nextEligible,
          price_review: !nextEligible
        })
      });
    } catch (err) {
      showAdminToast(err.message || `Failed to update ${sku}.`, 'err');
      return;
    }

    p.is_available = true;
    p.stock_verified = nextEligible;
    p.price_review = !nextEligible;
    p.feed_eligible = window.FT_COMMERCE
      ? window.FT_COMMERCE.isFeedEligibleProduct(p)
      : nextEligible;

    renderCatalogTable();
    syncSidebarCounts();
    loadReadinessReport();
    if (window.FT_COCKPIT_3D) {
      window.FT_COCKPIT_3D.updateTelemetry({ orders: currentOrders, products: window.FT_CATALOG.PRODUCTS });
    }
    showAdminToast(`${sku}: ${p.feed_eligible ? 'Approved for Meta & Google Feeds ✓' : 'Placed on Feed Hold'}`, 'ok');
  }

  async function bulkUpdateFilteredCatalog(approve) {
    const filtered = getFilteredCatalogProducts();
    if (!filtered.length) {
      showAdminToast('No products in the current filter.', 'err');
      return;
    }
    const skus = filtered.map(p => p.sku);
    try {
      await adminApiFetch('/api/admin/products/bulk', {
        method: 'POST',
        body: JSON.stringify({
          skus,
          is_available: true,
          stock_verified: Boolean(approve),
          price_review: !approve
        })
      });
      const catRes = await adminApiFetch('/api/admin/catalog');
      if (catRes && Array.isArray(catRes.products)) applyAdminProductOverrides(catRes.products);
      renderCatalogTable();
      syncSidebarCounts();
      loadReadinessReport();
      if (window.FT_COCKPIT_3D) {
        window.FT_COCKPIT_3D.updateTelemetry({ orders: currentOrders, products: window.FT_CATALOG.PRODUCTS });
      }
      showAdminToast(`${skus.length} SKU(s) ${approve ? 'approved for Meta Commerce Feed ✓' : 'placed on Feed Hold'}.`, 'ok');
    } catch (err) {
      showAdminToast(err.message || 'Bulk catalog update failed.', 'err');
    }
  }

  async function bulkApproveAllCatalogForFeed() {
    try {
      await adminApiFetch('/api/admin/products/bulk', {
        method: 'POST',
        body: JSON.stringify({
          skus: 'ALL',
          is_available: true,
          stock_verified: true,
          price_review: false
        })
      });
      const catRes = await adminApiFetch('/api/admin/catalog');
      if (catRes && Array.isArray(catRes.products)) applyAdminProductOverrides(catRes.products);
      renderCatalogTable();
      syncSidebarCounts();
      loadReadinessReport();
      if (window.FT_COCKPIT_3D) {
        window.FT_COCKPIT_3D.updateTelemetry({ orders: currentOrders, products: window.FT_CATALOG.PRODUCTS });
      }
      showAdminToast('All 53 SKUs verified and approved for Meta & Google Ad Feeds!', 'ok');
    } catch (err) {
      showAdminToast(err.message || 'Bulk approval failed.', 'err');
    }
  }

  function openProductDetailModal(sku) {
    if (!window.FT_CATALOG) return;
    const p = window.FT_CATALOG.PRODUCTS_BY_SKU[sku];
    if (!p) return;
    selectedProductSku = sku;
    const isLive = p.is_available !== false;
    const stockVerified = p.stock_verified === true;
    const priceApproved = p.price_review === false;
    const stockCountVal = p.stock_count !== undefined && p.stock_count !== null ? Number(p.stock_count) : 5;

    document.getElementById('prod-modal-title').textContent = `${p.sku} — ${p.title}`;
    const infoPane = document.getElementById('prod-modal-info');
    if (infoPane) {
      infoPane.innerHTML = `
        <div style="font-size:17px;font-weight:700">${escHtml(p.title)}</div>
        ${p.titleBn ? `<div style="color:var(--admin-gold);font-size:14px;margin-top:4px">${escHtml(p.titleBn)}</div>` : ''}
        <div style="font-size:12.5px;color:var(--admin-text2);margin-top:8px">
          Collection: <strong style="color:var(--admin-text)">${escHtml(p.collection ? p.collection.name : '')}</strong> · ${escHtml(p.superCategory)}
        </div>
        <div style="font-size:12.5px;color:var(--admin-text2);margin-top:4px">
          Selling Unit: <strong style="color:var(--admin-text)">${escHtml(p.unitBn || p.unit || '1 pc')}</strong>
        </div>
        ${p.cautionBn ? `<div style="margin-top:10px;padding:8px 12px;background:var(--admin-gold-bg);border-radius:8px;font-size:12px;color:var(--admin-gold)">Disclosure: ${escHtml(p.cautionBn)}</div>` : ''}
        ${HIGH_RISK_UNIT_SET.has(p.sku) ? `<div style="margin-top:8px;padding:8px 12px;background:rgba(248,113,113,0.12);border:1px solid rgba(248,113,113,0.35);border-radius:8px;font-size:12px;color:#FCA5A5">⚠ Pre-Launch Checklist SKU: Double-check exact selling unit &amp; final price before enabling ads.</div>` : ''}

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:16px;">
          <div>
            <label style="font-size:12px;color:var(--admin-text2);display:block;margin-bottom:4px">Price (BDT)</label>
            <input type="number" id="prod-edit-price" value="${Number(p.priceBDT || 0)}" min="1" class="search-input tabular-nums" style="width:100%;min-width:0;">
          </div>
          <div>
            <label style="font-size:12px;color:var(--admin-text2);display:block;margin-bottom:4px">Stock Count</label>
            <input type="number" id="prod-edit-stock-count" value="${stockCountVal}" min="0" step="1" class="search-input tabular-nums" style="width:100%;min-width:0;">
          </div>
          <div>
            <label style="font-size:12px;color:var(--admin-text2);display:block;margin-bottom:4px">Storefront Status</label>
            <select id="prod-edit-stock" class="filter-select" style="width:100%">
              <option value="true" ${isLive ? 'selected' : ''}>Live (In Stock)</option>
              <option value="false" ${!isLive ? 'selected' : ''}>Out of Stock</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px;">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="prod-edit-stock-verified" ${stockVerified ? 'checked' : ''}> Stock Physically Verified
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="prod-edit-price-approved" ${priceApproved ? 'checked' : ''}> Final Price Approved for Ad Feeds
          </label>
        </div>
      `;
    }

    document.getElementById('product-detail-modal').classList.add('open');
    if (window.FT_COCKPIT_3D) {
      setTimeout(() => window.FT_COCKPIT_3D.inspectSku(p, 'sku-3d-inspector-canvas'), 30);
    }
  }

  function closeProductDetailModal() {
    document.getElementById('product-detail-modal').classList.remove('open');
    selectedProductSku = null;
  }

  async function saveProductDetailChanges() {
    if (!selectedProductSku || !window.FT_CATALOG) return;
    const p = window.FT_CATALOG.PRODUCTS_BY_SKU[selectedProductSku];
    if (!p) return;
    const rawPrice = document.getElementById('prod-edit-price').value.trim();
    const parsedPrice = Number(rawPrice);
    if (rawPrice === '' || !Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      showAdminToast('Please enter a valid positive price in BDT.', 'err');
      return;
    }
    const rawStock = document.getElementById('prod-edit-stock-count').value.trim();
    const parsedStock = parseInt(rawStock, 10);
    if (!Number.isInteger(parsedStock) || parsedStock < 0) {
      showAdminToast('Stock count must be a non-negative integer.', 'err');
      return;
    }
    const newPrice = Math.round(parsedPrice);
    const newAvail = document.getElementById('prod-edit-stock').value === 'true';
    const stockVerified = document.getElementById('prod-edit-stock-verified').checked;
    const priceApproved = document.getElementById('prod-edit-price-approved').checked;

    try {
      await adminApiFetch('/api/admin/products/' + encodeURIComponent(selectedProductSku), {
        method: 'PATCH',
        body: JSON.stringify({
          price_bdt: newPrice,
          stock_count: parsedStock,
          is_available: newAvail,
          stock_verified: stockVerified,
          price_review: !priceApproved
        })
      });
    } catch (err) {
      showAdminToast(err.message || `Failed to save ${p.sku}.`, 'err');
      return;
    }

    p.priceBDT = newPrice;
    p.stock_count = parsedStock;
    p.is_available = newAvail;
    p.stock_verified = stockVerified;
    p.price_review = !priceApproved;
    p.feed_eligible = window.FT_COMMERCE
      ? window.FT_COMMERCE.isFeedEligibleProduct(p)
      : !!(newAvail && parsedStock > 0 && stockVerified && priceApproved && newPrice > 0);

    renderCatalogTable();
    populateManualOrderProducts();
    syncSidebarCounts();
    loadReadinessReport();
    if (window.FT_COCKPIT_3D) {
      window.FT_COCKPIT_3D.updateTelemetry({ orders: currentOrders, products: window.FT_CATALOG.PRODUCTS });
    }
    closeProductDetailModal();
    showAdminToast(`Updated ${p.sku}: ৳${newPrice.toLocaleString()} · Stock ${parsedStock} (Feed ${p.feed_eligible ? 'Eligible ✓' : 'Hold'})`, 'ok');
  }

  /* ===================================================================== */
  /* COUPONS & LIVE SIMULATOR                                              */
  /* ===================================================================== */
  async function renderCouponsTable() {
    const tbody = document.getElementById('coupons-table-body');
    if (!tbody || !currentAccessToken) return;
    try {
      const res = await adminApiFetch('/api/admin/coupons');
      currentCoupons = Array.isArray(res.coupons) ? res.coupons : [];
    } catch (err) {
      showAdminToast(err.message || 'Failed to load coupons.', 'err');
      return;
    }

    const elCoupCount = document.getElementById('nav-count-coupons');
    if (elCoupCount) elCoupCount.textContent = String(currentCoupons.length);

    if (!currentCoupons.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--admin-text2)">No vouchers configured. Click "+ Create Coupon" to add one.</td></tr>`;
      return;
    }

    tbody.innerHTML = currentCoupons.map(c => `
      <tr>
        <td class="tabular-nums"><strong style="color:var(--admin-gold)">${escHtml(c.code)}</strong></td>
        <td>${escHtml(c.discount_type)}</td>
        <td class="tabular-nums"><b>${c.discount_type === 'percentage' ? c.discount_value + '%' : '৳ ' + c.discount_value}</b></td>
        <td class="tabular-nums">৳ ${Number(c.min_spend || 0).toLocaleString()}</td>
        <td class="tabular-nums">${c.max_discount ? '৳ ' + Number(c.max_discount).toLocaleString() : 'None'}</td>
        <td><span class="st-label ${c.is_active ? 'st-delivered' : 'st-cancelled'}">${c.is_active ? 'ACTIVE' : 'DISABLED'}</span></td>
        <td><small style="color:var(--admin-text2)">${escHtml(c.notes || '')}</small></td>
        <td>
          <div style="display:flex;gap:6px;align-items:center;">
            <button type="button" class="btn-admin btn-admin-sm" onclick="openEditCouponModal('${escHtml(c.code)}')">Edit</button>
            <button type="button" class="btn-admin btn-admin-sm" onclick="toggleCouponStatus('${escHtml(c.code)}', ${!c.is_active})">${c.is_active ? 'Disable' : 'Enable'}</button>
            <button type="button" class="btn-admin btn-admin-sm btn-admin-danger" onclick="deleteCouponRow('${escHtml(c.code)}', this)">Delete</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  async function toggleCouponStatus(code, newStatus) {
    const target = currentCoupons.find(c => c.code === code);
    if (!target) return;
    try {
      await adminApiFetch('/api/admin/coupons', {
        method: 'POST',
        body: JSON.stringify(Object.assign({}, target, { is_active: newStatus }))
      });
      await renderCouponsTable();
      runCouponSimulator();
      loadReadinessReport();
      showAdminToast(`Coupon ${code} ${newStatus ? 'enabled' : 'disabled'}.`, 'ok');
    } catch (err) {
      showAdminToast(err.message || `Failed to update coupon ${code}.`, 'err');
    }
  }

  async function deleteCouponRow(code, btnEl) {
    if (pendingDeleteCouponCode !== code) {
      pendingDeleteCouponCode = code;
      if (btnEl) btnEl.textContent = 'Confirm?';
      showAdminToast(`Click "Confirm?" again to permanently delete voucher ${code}.`, 'err');
      return;
    }
    pendingDeleteCouponCode = '';
    try {
      await adminApiFetch('/api/admin/coupons/' + encodeURIComponent(code), { method: 'DELETE' });
      await renderCouponsTable();
      runCouponSimulator();
      loadReadinessReport();
      showAdminToast(`Coupon ${code} deleted.`, 'ok');
    } catch (err) {
      showAdminToast(err.message || `Failed to delete coupon ${code}.`, 'err');
    }
  }

  function openNewCouponModal() {
    document.getElementById('coupon-modal-title').textContent = 'Create Promotional Voucher';
    const form = document.getElementById('coupon-modal-form');
    if (form) form.reset();
    const codeEl = document.getElementById('coup-code');
    if (codeEl) codeEl.readOnly = false;
    document.getElementById('coup-val').value = '20';
    document.getElementById('coup-min').value = '2000';
    document.getElementById('coup-max').value = '500';
    document.getElementById('new-coupon-modal').classList.add('open');
  }

  function openEditCouponModal(code) {
    const c = currentCoupons.find(item => item.code === code);
    if (!c) return;
    document.getElementById('coupon-modal-title').textContent = 'Edit Voucher — ' + c.code;
    const codeEl = document.getElementById('coup-code');
    codeEl.value = c.code;
    codeEl.readOnly = true;
    document.getElementById('coup-type').value = c.discount_type;
    document.getElementById('coup-val').value = c.discount_value;
    document.getElementById('coup-min').value = c.min_spend || 0;
    document.getElementById('coup-max').value = c.max_discount !== null && c.max_discount !== undefined ? c.max_discount : '';
    document.getElementById('coup-notes').value = c.notes || '';
    document.getElementById('new-coupon-modal').classList.add('open');
  }

  function closeNewCouponModal() {
    document.getElementById('new-coupon-modal').classList.remove('open');
  }

  async function submitNewCoupon() {
    const code = document.getElementById('coup-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
      showAdminToast('Coupon code must be 3–24 uppercase letters, numbers, underscores, or hyphens.', 'err');
      return;
    }
    const type = document.getElementById('coup-type').value;
    const val = parseFloat(document.getElementById('coup-val').value);
    const min = parseFloat(document.getElementById('coup-min').value);
    const maxRaw = (document.getElementById('coup-max').value || '').trim();
    const notes = document.getElementById('coup-notes').value.trim();

    if (!Number.isFinite(val) || val < 0) {
      showAdminToast('Discount value must be a valid non-negative number.', 'err');
      return;
    }
    if (type === 'percentage' && (val <= 0 || val > 100)) {
      showAdminToast('Percentage discount must be between 1 and 100.', 'err');
      return;
    }
    if (type === 'fixed' && val <= 0) {
      showAdminToast('Fixed discount value must be greater than 0.', 'err');
      return;
    }
    const minSpend = Number.isFinite(min) && min >= 0 ? min : 0;
    const maxDiscount = maxRaw === '' ? null : Number(maxRaw);
    if (maxDiscount !== null && (!Number.isFinite(maxDiscount) || maxDiscount < 0)) {
      showAdminToast('Max discount cap must be empty or a non-negative number.', 'err');
      return;
    }

    const existing = currentCoupons.find(c => c.code === code);
    const payload = {
      code,
      discount_type: type,
      discount_value: val,
      min_spend: minSpend,
      max_discount: maxDiscount,
      is_active: existing ? existing.is_active : true,
      notes
    };

    try {
      await adminApiFetch('/api/admin/coupons', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      closeNewCouponModal();
      await renderCouponsTable();
      runCouponSimulator();
      loadReadinessReport();
      showAdminToast('Coupon ' + code + ' saved!', 'ok');
    } catch (err) {
      showAdminToast(err.message || `Failed to save coupon ${code}.`, 'err');
    }
  }

  function runCouponSimulator() {
    const sub = Number((document.getElementById('sim-subtotal') || {}).value || 0);
    const zone = (document.getElementById('sim-zone') || {}).value || 'dhaka';
    const code = String((document.getElementById('sim-code') || {}).value || '').trim().toUpperCase();
    const box = document.getElementById('sim-result-box');
    if (!box) return;

    const fees = getLiveDeliveryFees();
    const fee = zone === 'outside_dhaka' ? fees.outside_dhaka : fees.dhaka;
    const found = currentCoupons.find(c => c.code === code);

    if (!code) {
      box.innerHTML = `<div class="tabular-nums">No coupon entered · Payable COD: <strong>৳ ${(sub + fee).toLocaleString()}</strong></div>`;
      return;
    }

    const evalRes = window.FT_COMMERCE
      ? window.FT_COMMERCE.evaluateCoupon(found, sub, fee)
      : { valid: false, discountAmount: 0, message: 'Invalid code' };

    if (!evalRes.valid) {
      box.innerHTML = `<div style="color:var(--admin-red)">✕ ${escHtml(evalRes.message || 'Not eligible')}</div>`;
    } else {
      const finalCod = Math.max(0, sub + fee - evalRes.discountAmount);
      box.innerHTML = `
        <div class="tabular-nums" style="color:var(--admin-green);font-weight:600">✓ ${escHtml(evalRes.message)} (-৳${evalRes.discountAmount})</div>
        <div class="tabular-nums" style="margin-top:4px">Final COD Payable: <strong style="color:var(--admin-gold)">৳ ${finalCod.toLocaleString()}</strong> (incl. ৳${fee} delivery)</div>
      `;
    }
  }

  /* ===================================================================== */
  /* CUSTOMER CRM DIRECTORY                                                */
  /* ===================================================================== */
  function renderCustomersTable() {
    const tbody = document.getElementById('customers-table-body');
    if (!tbody) return;
    const q = (document.getElementById('customer-search').value || '').toLowerCase();
    const customerMap = {};
    currentOrders.forEach(o => {
      const phone = o.customer_phone;
      if (!phone) return;
      if (!customerMap[phone]) {
        customerMap[phone] = {
          name: o.customer_name || 'Customer',
          phone: phone,
          address: o.customer_address || '',
          ordersCount: 0,
          totalSpent: 0
        };
      }
      customerMap[phone].ordersCount++;
      if (o.status !== 'cancelled') {
        customerMap[phone].totalSpent += Number(o.total || 0);
      }
    });

    const allCustomers = Object.values(customerMap);
    const elCustCount = document.getElementById('nav-count-customers');
    if (elCustCount) elCustCount.textContent = String(allCustomers.length);

    const list = allCustomers.filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q) || c.address.toLowerCase().includes(q));
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:34px;color:var(--admin-text2)">${allCustomers.length === 0 ? 'Customer profiles are built automatically as boutique orders arrive.' : 'No customers match your search.'}</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(c => {
      const digits = c.phone.replace(/[^0-9]/g, '');
      const waPhone = digits.startsWith('88') ? digits : ('88' + digits);
      const tier = c.totalSpent >= 3000 || c.ordersCount >= 2 ? 'VIP Patron' : 'Verified Buyer';
      return `
        <tr>
          <td><strong>${escHtml(c.name)}</strong></td>
          <td class="tabular-nums"><a href="tel:${escHtml(c.phone)}" style="color:var(--admin-text);text-decoration:underline;">${escHtml(c.phone)}</a></td>
          <td><small style="color:var(--admin-text2)">${escHtml(c.address.slice(0, 44))}</small></td>
          <td><span style="color:${tier === 'VIP Patron' ? 'var(--admin-gold)' : 'var(--admin-text2)'};font-size:12px;font-weight:600">${tier}</span></td>
          <td class="tabular-nums">${c.ordersCount} order${c.ordersCount > 1 ? 's' : ''}</td>
          <td class="tabular-nums"><strong>৳ ${c.totalSpent.toLocaleString()}</strong></td>
          <td>
            <a href="https://wa.me/${encodeURIComponent(waPhone)}?text=${encodeURIComponent('Assalamu Alaikum ' + c.name + ', greetings from Fariza\'s Territory!')}" target="_blank" rel="noopener noreferrer" class="btn-admin btn-admin-sm" style="color:#2ECC71">WhatsApp Concierge</a>
          </td>
        </tr>
      `;
    }).join('');
  }

  /* ===================================================================== */
  /* COURIER DISPATCH HUB                                                  */
  /* ===================================================================== */
  function renderCourierTable() {
    const tbody = document.getElementById('courier-table-body');
    if (!tbody) return;
    const filter = (document.getElementById('courier-filter') || {}).value || 'all';

    const list = currentOrders.filter(o => {
      if (filter === 'ready') return ['confirmed', 'processing'].includes(o.status);
      if (filter === 'shipped') return o.status === 'shipped';
      if (filter === 'delivered') return o.status === 'delivered';
      return o.status !== 'cancelled';
    });

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:34px;color:var(--admin-text2)">No parcels in this dispatch stage yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(o => `
      <tr>
        <td class="tabular-nums"><strong style="color:var(--admin-gold);cursor:pointer;" onclick="openOrderDetail('${escHtml(o.order_ref)}')">${escHtml(o.order_ref)}</strong></td>
        <td>
          <strong>${escHtml(o.customer_name)}</strong>
          <div class="tabular-nums" style="font-size:12px;color:var(--admin-text2)">${escHtml(o.customer_phone)}</div>
        </td>
        <td><small style="color:var(--admin-text2)">${escHtml(o.customer_address)}</small></td>
        <td class="tabular-nums"><strong>৳ ${Number(o.total || 0).toLocaleString()}</strong></td>
        <td>
          <select class="filter-select" style="padding:5px 8px;font-size:12px;" onchange="quickSaveCourier('${escHtml(o.order_ref)}', this.value, null)">
            <option value="Steadfast Courier" ${(o.courier_name || '') === 'Steadfast Courier' ? 'selected' : ''}>Steadfast Courier</option>
            <option value="Pathao Courier" ${(o.courier_name || '') === 'Pathao Courier' ? 'selected' : ''}>Pathao Courier</option>
            <option value="RedX" ${(o.courier_name || '') === 'RedX' ? 'selected' : ''}>RedX</option>
          </select>
        </td>
        <td>
          <input type="text" class="search-input tabular-nums" value="${escHtml(o.tracking_number || '')}" placeholder="Enter Tracking #" style="min-width:130px;width:140px;padding:5px 8px;font-size:12px;" onchange="quickSaveCourier('${escHtml(o.order_ref)}', null, this.value)">
        </td>
        <td>
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn-admin btn-admin-sm" onclick="copyCourierFormat('${escHtml(o.order_ref)}')">Copy Manifest Line</button>
            ${o.status === 'confirmed' || o.status === 'processing' ? `<button type="button" class="btn-admin btn-admin-primary btn-admin-sm" onclick="quickAdvanceOrderStatus('${escHtml(o.order_ref)}', 'shipped')">Mark Shipped</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
  }

  async function quickSaveCourier(ref, courierName, trackingNum) {
    const o = currentOrders.find(ord => ord.order_ref === ref);
    if (!o) return;
    const nextCourier = courierName !== null ? courierName : o.courier_name;
    const nextTracking = trackingNum !== null ? trackingNum.trim() : o.tracking_number;

    try {
      await adminApiFetch('/api/admin/orders/' + encodeURIComponent(ref), {
        method: 'PATCH',
        body: JSON.stringify({
          courier_name: nextCourier,
          tracking_number: nextTracking
        })
      });
      o.courier_name = nextCourier;
      o.tracking_number = nextTracking;
      showAdminToast(`Updated dispatch info for ${ref}.`, 'ok');
    } catch (err) {
      showAdminToast(err.message || `Failed to update dispatch info for ${ref}.`, 'err');
      renderCourierTable();
    }
  }

  function copyCourierFormat(ref) {
    const o = currentOrders.find(ord => ord.order_ref === ref);
    if (!o) return;
    const text = `${o.order_ref} | ${o.customer_name} | ${o.customer_phone} | ${o.customer_address} | COD: ৳${o.total}`;
    copyToClipboard(text, 'Copied courier booking line to clipboard!');
  }

  function exportCourierManifestCSV() {
    const dispatchable = currentOrders.filter(o => o.status !== 'cancelled');
    if (!dispatchable.length) {
      showAdminToast('No active orders for courier manifest.', 'err');
      return;
    }
    const headers = ['Invoice', 'Recipient Name', 'Recipient Phone', 'Recipient Address', 'COD Amount', 'Note', 'Courier'];
    const rows = dispatchable.map(o => [
      o.order_ref,
      o.customer_name || '',
      o.customer_phone || '',
      o.customer_address || '',
      o.total || 0,
      o.customer_notes || 'Fragile Boutique Apparel/Artisan Piece',
      o.courier_name || 'Steadfast Courier'
    ]);
    downloadCsvFile(`Steadfast_Pathao_Manifest_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
    showAdminToast(`Exported ${dispatchable.length} parcels to Courier Manifest CSV.`, 'ok');
  }

  /* ===================================================================== */
  /* MULTI-ITEM MANUAL ORDER CREATION                                      */
  /* ===================================================================== */
  function populateManualOrderProducts() {
    const sel = document.getElementById('man-product');
    if (!sel || !window.FT_CATALOG) return;
    sel.innerHTML = window.FT_CATALOG.PRODUCTS.map(p => {
      const price = p.priceBDT ? `৳${p.priceBDT.toLocaleString()}` : 'Inquire';
      const cat = p.superCategory || 'Fashion';
      const stockTag = p.is_available === false ? ' [OUT]' : '';
      return `<option value="${escHtml(p.sku)}">[${escHtml(cat)}] ${escHtml(p.sku)} · ${escHtml(p.title)} (${price})${stockTag}</option>`;
    }).join('');
    recalcManualOrderPreview();
  }

  function openNewOrderModal() {
    manualExtraItems = [];
    renderManualExtraLines();
    recalcManualOrderPreview();
    document.getElementById('new-order-modal').classList.add('open');
  }

  function closeNewOrderModal() {
    document.getElementById('new-order-modal').classList.remove('open');
  }

  function addManualOrderLineItem() {
    const sku = document.getElementById('man-product').value;
    const qty = Math.max(1, parseInt(document.getElementById('man-qty').value, 10) || 1);
    if (!sku) return;
    const existing = manualExtraItems.find(x => x.sku === sku);
    if (existing) existing.qty += qty;
    else manualExtraItems.push({ sku, qty });
    document.getElementById('man-qty').value = '1';
    renderManualExtraLines();
    recalcManualOrderPreview();
  }

  function removeManualOrderLineItem(idx) {
    manualExtraItems.splice(idx, 1);
    renderManualExtraLines();
    recalcManualOrderPreview();
  }

  function renderManualExtraLines() {
    const box = document.getElementById('man-extra-lines');
    if (!box) return;
    if (manualExtraItems.length === 0) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = 'block';
    box.innerHTML = `<div style="font-size:11.5px;color:var(--admin-gold);margin-bottom:6px;font-weight:600">Order Lines (${manualExtraItems.length}):</div>` +
      manualExtraItems.map((it, idx) => {
        const p = window.FT_CATALOG && window.FT_CATALOG.PRODUCTS_BY_SKU ? window.FT_CATALOG.PRODUCTS_BY_SKU[it.sku] : null;
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:12.5px;padding:4px 0;border-bottom:1px solid rgba(253,240,221,0.06);">
            <span class="tabular-nums"><strong>${escHtml(it.sku)}</strong> · ${escHtml(p ? p.title : '')} × ${it.qty}</span>
            <button type="button" class="btn-admin btn-admin-sm" onclick="removeManualOrderLineItem(${idx})">Remove</button>
          </div>
        `;
      }).join('');
  }

  function getComposedManualItems() {
    if (manualExtraItems.length > 0) {
      return manualExtraItems.map(x => ({ sku: x.sku, qty: x.qty }));
    }
    const primarySku = (document.getElementById('man-product') || {}).value;
    const primaryQty = Math.max(1, parseInt((document.getElementById('man-qty') || {}).value, 10) || 1);
    return primarySku ? [{ sku: primarySku, qty: primaryQty }] : [];
  }

  function recalcManualOrderPreview() {
    const sumBox = document.getElementById('man-order-summary');
    if (!sumBox || !window.FT_CATALOG || !window.FT_COMMERCE) return;
    const items = getComposedManualItems();
    const zone = (document.getElementById('man-zone') || {}).value || 'dhaka';
    const code = String((document.getElementById('man-discount-code') || {}).value || '').trim().toUpperCase();
    const couponObj = code ? currentCoupons.find(c => c.code === code) : null;

    const calc = window.FT_COMMERCE.computeOrderTotals({
      items,
      productsBySku: window.FT_CATALOG.PRODUCTS_BY_SKU,
      zone,
      district: zone === 'dhaka' ? 'Dhaka' : 'Outside Dhaka',
      deliveryFees: getLiveDeliveryFees(),
      coupon: couponObj
    });

    if (!calc.ok) {
      sumBox.innerHTML = `<span style="color:var(--admin-red)">${escHtml(calc.error)}</span>`;
      return;
    }

    sumBox.innerHTML = `
      <div class="tabular-nums" style="display:flex;justify-content:space-between;">
        <span>Items Subtotal (${calc.items.reduce((s, i) => s + i.qty, 0)} pcs):</span>
        <span>৳ ${calc.subtotal.toLocaleString()}</span>
      </div>
      ${calc.discount_amount > 0 ? `<div class="tabular-nums" style="display:flex;justify-content:space-between;color:var(--admin-green)"><span>Voucher (${escHtml(calc.discount_code)}):</span><span>- ৳ ${calc.discount_amount.toLocaleString()}</span></div>` : ''}
      ${code && !calc.discount_code ? `<div style="font-size:11.5px;color:var(--admin-red)">Voucher "${escHtml(code)}" not applied (inactive or below minimum spend).</div>` : ''}
      <div class="tabular-nums" style="display:flex;justify-content:space-between;">
        <span>Delivery Fee (${zone === 'dhaka' ? 'Inside Dhaka' : 'Outside Dhaka'}):</span>
        <span>৳ ${calc.delivery_fee.toLocaleString()}</span>
      </div>
      <div class="tabular-nums" style="display:flex;justify-content:space-between;font-weight:700;color:var(--admin-gold);margin-top:6px;padding-top:6px;border-top:1px solid var(--admin-border);">
        <span>Total COD Payable:</span>
        <span>৳ ${calc.total.toLocaleString()}</span>
      </div>
    `;
  }

  async function submitNewManualOrder() {
    const name = document.getElementById('man-name').value.trim();
    const phone = document.getElementById('man-phone').value.trim();
    const address = document.getElementById('man-address').value.trim();
    const zone = document.getElementById('man-zone').value;
    const code = document.getElementById('man-discount-code').value.trim().toUpperCase();
    const notes = document.getElementById('man-notes').value.trim();
    const items = getComposedManualItems();

    if (name.length < 2) {
      showAdminToast('Please enter a valid customer name (at least 2 characters).', 'err');
      return;
    }
    if (address.length < 4) {
      showAdminToast('Please enter a complete delivery address.', 'err');
      return;
    }
    const phoneInfo = window.FT_COMMERCE ? window.FT_COMMERCE.normalizePhone(phone) : { isBdMobile: phone.length >= 11, canonical11: phone };
    if (!phoneInfo.isBdMobile) {
      showAdminToast('Please enter a valid 11-digit Bangladeshi mobile number (e.g. 017XXXXXXXX).', 'err');
      return;
    }

    try {
      const res = await adminApiFetch('/api/admin/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: name,
          customer_phone: phoneInfo.canonical11,
          customer_address: address,
          delivery_zone: zone,
          customer_district: zone === 'dhaka' ? 'Dhaka' : 'Outside Dhaka',
          discount_code: code || undefined,
          customer_notes: notes || 'Manual order created from Admin Console',
          items
        })
      });
      document.getElementById('new-order-form').reset();
      manualExtraItems = [];
      renderManualExtraLines();
      closeNewOrderModal();
      await refreshAdminData();
      showAdminToast('Order ' + (res.order && res.order.order_ref) + ' created and persisted!', 'ok');
    } catch (err) {
      showAdminToast(err.message || 'Failed to create manual order.', 'err');
    }
  }

  /* ===================================================================== */
  /* SETTINGS, META CAPI & AD CAMPAIGN UTM BUILDER                         */
  /* ===================================================================== */
  async function saveStoreSettings() {
    const wa = document.getElementById('set-wa').value.trim().replace(/[^0-9]/g, '');
    const fb = document.getElementById('set-fb').value.trim().replace(/^https?:\/\/(www\.)?m\.me\//, '').replace(/\/$/, '');
    const fbUrlInput = (document.getElementById('set-fb-url') || {}).value || '';
    const fbUrl = fbUrlInput.trim() || ('https://www.facebook.com/' + encodeURIComponent(fb || 'farizasterritory143'));
    const pixel = document.getElementById('set-pixel').value.trim();
    const ga4 = document.getElementById('set-ga4').value.trim();
    const dhaka = parseInt(document.getElementById('set-fee-dhaka').value, 10);
    const outside = parseInt(document.getElementById('set-fee-outside').value, 10);
    const threshold = parseInt(document.getElementById('set-free-threshold').value, 10);
    const promo = document.getElementById('set-promo').value.trim();

    if ((Number.isFinite(dhaka) && dhaka < 0) || (Number.isFinite(outside) && outside < 0) || (Number.isFinite(threshold) && threshold < 0)) {
      showAdminToast('Delivery fees and free-delivery threshold must be non-negative.', 'err');
      return;
    }

    const payload = {
      whatsapp_number: wa,
      messenger_username: fb || 'farizasterritory143',
      facebook_url: fbUrl,
      meta_pixel_id: pixel || '1657670575734647',
      ga4_measurement_id: ga4,
      delivery_fee_dhaka: Number.isFinite(dhaka) ? dhaka : 80,
      delivery_fee_outside: Number.isFinite(outside) ? outside : 150,
      free_delivery_threshold: Number.isFinite(threshold) ? threshold : 3000,
      promo_text: promo
    };

    try {
      const res = await adminApiFetch('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      if (res && res.settings) hydrateSettingsInputs(res.settings);
      runCouponSimulator();
      recalcManualOrderPreview();
      loadReadinessReport();
      showAdminToast('Store settings persisted and synced to storefront!', 'ok');
    } catch (err) {
      showAdminToast(err.message || 'Failed to save store settings.', 'err');
    }
  }

  async function testMetaCapi() {
    const out = document.getElementById('capi-output');
    const badge = document.getElementById('capi-status-badge');
    const testCode = document.getElementById('capi-test-code').value.trim();
    const eventType = (document.getElementById('capi-event-type') || {}).value || 'Lead';
    badge.textContent = 'Dispatching…';
    badge.className = 'st-label st-confirmed';
    out.textContent = `Dispatching ${eventType} CAPI diagnostic payload to server…`;

    try {
      const data = await adminApiFetch('/api/admin/capi-test', {
        method: 'POST',
        body: JSON.stringify({
          eventName: eventType,
          eventId: 'ft_admin_test_' + Date.now(),
          test_event_code: testCode,
          userData: { name: 'Fariza Admin', district: 'Dhaka' },
          customData: { currency: 'BDT', value: 2350, content_ids: ['CAT-001'], num_items: 1 }
        })
      });
      badge.textContent = data.success ? 'Verified ✓' : 'Warning';
      badge.className = data.success ? 'st-label st-delivered' : 'st-label st-pending';
      out.textContent = JSON.stringify(data, null, 2);
      showAdminToast(data.success ? `Meta CAPI ${eventType} verified by server.` : 'Meta CAPI returned a warning.', data.success ? 'ok' : 'err');
    } catch (err) {
      badge.textContent = 'Error';
      badge.className = 'st-label st-cancelled';
      out.textContent = JSON.stringify({ success: false, error: err.message || 'CAPI diagnostic failed.' }, null, 2);
      showAdminToast(err.message || 'Meta CAPI diagnostic failed.', 'err');
    }
  }

  function copyFeedUrl(relPath) {
    const fullUrl = window.location.origin + relPath;
    copyToClipboard(fullUrl, 'Copied feed URL: ' + fullUrl);
  }

  function buildAdCampaignUrl() {
    const target = (document.getElementById('utm-target') || {}).value || '';
    const src = ((document.getElementById('utm-source') || {}).value || 'facebook').trim();
    const med = ((document.getElementById('utm-medium') || {}).value || 'paid_social').trim();
    const camp = ((document.getElementById('utm-campaign') || {}).value || 'dhaka_launch').trim();
    const params = new URLSearchParams();
    if (src) params.set('utm_source', src);
    if (med) params.set('utm_medium', med);
    if (camp) params.set('utm_campaign', camp);

    let pathSeg = '/';
    if (target.startsWith('sku:')) pathSeg = '/products/' + encodeURIComponent(target.slice(4));
    else if (target.startsWith('col:')) pathSeg = '/collections/' + encodeURIComponent(target.slice(4));

    const outEl = document.getElementById('utm-result-url');
    if (outEl) {
      const qs = params.toString();
      outEl.value = window.location.origin + pathSeg + (qs ? '?' + qs : '');
    }
    const csvInput = document.getElementById('feed-url-csv');
    if (csvInput) csvInput.value = window.location.origin + '/api/catalog-feed.csv';
    const xmlInput = document.getElementById('feed-url-xml');
    if (xmlInput) xmlInput.value = window.location.origin + '/api/catalog-feed.xml';
  }

  function copyCampaignUrl() {
    buildAdCampaignUrl();
    const outEl = document.getElementById('utm-result-url');
    if (outEl && outEl.value) {
      copyToClipboard(outEl.value, 'Ad campaign URL copied to clipboard!');
    }
  }

  /* ===================================================================== */
  /* NAVIGATION, 3D COCKPIT CONTROLS & COMMAND PALETTE                     */
  /* ===================================================================== */
  function switchTab(tabId) {
    document.querySelectorAll('.view-tab').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.admin-nav-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.cockpit-nav-link').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-top-tab') === tabId);
    });

    const target = document.getElementById('tab-' + tabId);
    if (target) {
      target.classList.add('active');
      if (window.Motion && typeof window.Motion.animate === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        try {
          window.Motion.animate(target, { opacity: [0, 1], transform: ['translateY(6px)', 'translateY(0px)'] }, { duration: 0.18 });
        } catch (_) {}
      }
    }

    const btn = Array.from(document.querySelectorAll('.admin-nav-item')).find(b => (b.getAttribute('onclick') || '').includes("'" + tabId + "'"));
    if (btn) btn.classList.add('active');

    if (tabId === 'readiness' && currentAccessToken) {
      loadReadinessReport();
    }
  }

  function switchCockpit3DMode(mode) {
    document.querySelectorAll('.dock-seg-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-3d-mode') === mode);
    });
    if (window.FT_COCKPIT_3D) {
      window.FT_COCKPIT_3D.setMode(mode);
    }
    const labelEl = document.getElementById('cockpit-3d-mode-label');
    if (labelEl) {
      if (mode === 'collections') labelEl.textContent = 'Click any of the 8 Collection 3D Towers to filter the 53-SKU Catalog';
      else if (mode === 'pipeline') labelEl.textContent = 'Click any Order Stage Card in 3D space to filter the Fulfillment Pipeline';
      else labelEl.textContent = 'Click Inside Dhaka or Outside Dhaka 3D Pillar to filter orders by zone';
    }
  }

  function toggleCockpit3DDeck() {
    const shell = document.getElementById('cockpit-3d-deck');
    const btn = document.getElementById('toggle-3d-btn');
    if (!shell) return;
    const collapsed = shell.classList.toggle('collapsed');
    if (btn) btn.textContent = collapsed ? '▴ Show 3D Cockpit' : '▾ Hide 3D Cockpit';
    if (window.FT_COCKPIT_3D && typeof window.FT_COCKPIT_3D.setPaused === 'function') {
      window.FT_COCKPIT_3D.setPaused(collapsed);
    }
  }

  window.handleCockpit3DAction = function (userData) {
    if (!userData) return;
    if (userData.action === 'filter-collection' && userData.colId) {
      switchTab('catalog');
      const colSelect = document.getElementById('cat-col-filter');
      if (colSelect) {
        colSelect.value = userData.colId;
        renderCatalogTable();
      }
      showAdminToast(`Filtered Catalog to Collection ${userData.colId}: ${userData.colName || ''}`, 'ok');
    } else if (userData.action === 'filter-status') {
      quickFilterOrdersByStatus(userData.status || 'all');
      showAdminToast(`Filtered Pipeline to ${(userData.status || 'all').toUpperCase()}`, 'ok');
    } else if (userData.action === 'filter-zone') {
      switchTab('orders');
      const zSel = document.getElementById('order-zone-filter');
      if (zSel) {
        zSel.value = userData.zone || 'all';
        applyOrderFilters();
      }
      showAdminToast(`Filtered Orders to Zone: ${userData.zone === 'dhaka' ? 'Inside Dhaka' : 'Outside Dhaka'}`, 'ok');
    } else if (userData.action === 'open-tab' && userData.tab) {
      switchTab(userData.tab);
    }
  };

  function openCommandPalette() {
    if (!currentAccessToken) return;
    const modal = document.getElementById('cmd-palette-modal');
    const input = document.getElementById('cmd-palette-input');
    if (!modal) return;
    modal.classList.add('open');
    if (input) {
      input.value = '';
      input.focus();
    }
    renderCommandPaletteResults();
  }

  function closeCommandPalette() {
    const modal = document.getElementById('cmd-palette-modal');
    if (modal) modal.classList.remove('open');
  }

  function renderCommandPaletteResults() {
    const q = ((document.getElementById('cmd-palette-input') || {}).value || '').trim().toLowerCase();
    const box = document.getElementById('cmd-palette-results');
    if (!box) return;

    const actions = [
      { label: 'Create New Manual COD Order', sub: 'Action · Orders', fn: "closeCommandPalette();openNewOrderModal()" },
      { label: 'Open Pre-Launch & Ad Readiness Audit', sub: 'Audit · Launch', fn: "closeCommandPalette();switchTab('readiness')" },
      { label: 'Approve All 53 SKUs for Meta Commerce Feed', sub: 'Action · Catalog', fn: "closeCommandPalette();bulkApproveAllCatalogForFeed()" },
      { label: 'Switch to Kanban Pipeline Board', sub: 'View · Orders', fn: "closeCommandPalette();switchTab('orders');setOrderPipelineView('kanban')" },
      { label: 'Open Courier Booking & Dispatch Hub', sub: 'View · Logistics', fn: "closeCommandPalette();switchTab('courier')" },
      { label: 'Test Meta Conversions API (CAPI)', sub: 'Diagnostic · Settings', fn: "closeCommandPalette();switchTab('settings');testMetaCapi()" }
    ].filter(a => !q || a.label.toLowerCase().includes(q) || a.sub.toLowerCase().includes(q));

    const matchingOrders = currentOrders.filter(o =>
      q && ((o.order_ref || '').toLowerCase().includes(q) || (o.customer_name || '').toLowerCase().includes(q) || (o.customer_phone || '').includes(q))
    ).slice(0, 5);

    const products = (window.FT_CATALOG && window.FT_CATALOG.PRODUCTS) || [];
    const matchingSkus = products.filter(p =>
      !q ? false : (p.sku.toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q))
    ).slice(0, 6);

    let html = '';
    if (actions.length) {
      html += `<div style="font-size:11px;color:var(--admin-muted);margin:6px 0;">Quick Cockpit Commands</div>`;
      html += actions.map(a => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border-radius:8px;cursor:pointer;background:var(--admin-bg);margin-bottom:6px;border:1px solid var(--admin-border)" onclick="${a.fn}">
          <span style="font-size:13px;font-weight:600">${escHtml(a.label)}</span>
          <span style="font-size:11.5px;color:var(--admin-gold)">${escHtml(a.sub)}</span>
        </div>
      `).join('');
    }

    if (matchingOrders.length) {
      html += `<div style="font-size:11px;color:var(--admin-muted);margin:10px 0 6px;">Matching Orders</div>`;
      html += matchingOrders.map(o => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border-radius:8px;cursor:pointer;background:var(--admin-bg);margin-bottom:6px;border:1px solid var(--admin-border)" onclick="closeCommandPalette();openOrderDetail('${escHtml(o.order_ref)}')">
          <span class="tabular-nums"><strong style="color:var(--admin-gold)">${escHtml(o.order_ref)}</strong> · ${escHtml(o.customer_name)} (${escHtml(o.customer_phone)})</span>
          <span class="tabular-nums">৳ ${Number(o.total || 0).toLocaleString()}</span>
        </div>
      `).join('');
    }

    if (matchingSkus.length) {
      html += `<div style="font-size:11px;color:var(--admin-muted);margin:10px 0 6px;">Matching Catalog SKUs</div>`;
      html += matchingSkus.map(p => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border-radius:8px;cursor:pointer;background:var(--admin-bg);margin-bottom:6px;border:1px solid var(--admin-border)" onclick="closeCommandPalette();openProductDetailModal('${escHtml(p.sku)}')">
          <span class="tabular-nums"><strong style="color:var(--admin-gold)">${escHtml(p.sku)}</strong> · ${escHtml(p.title)}</span>
          <span class="tabular-nums">৳ ${Number(p.priceBDT || 0).toLocaleString()}</span>
        </div>
      `).join('');
    }

    if (!html) {
      html = `<div style="text-align:center;padding:24px;color:var(--admin-text2)">No matching commands, orders, or SKUs found.</div>`;
    }
    box.innerHTML = html;
  }

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
    } else if (e.key === 'Escape') {
      closeCommandPalette();
      closeOrderModal();
      closeNewOrderModal();
      closeNewCouponModal();
      closeProductDetailModal();
    }
  });

  // Expose handlers on window for HTML attributes
  Object.assign(window, {
    submitAdminAuthForm,
    signOutAdminPortal,
    submitChangeAdminPassword,
    refreshAdminData,
    loadReadinessReport,
    jumpToHighRiskSkus,
    switchTab,
    switchCockpit3DMode,
    toggleCockpit3DDeck,
    quickFilterOrdersByStatus,
    setOrderPipelineView,
    applyOrderFilters,
    resetOrderFilters,
    quickAdvanceOrderStatus,
    openOrderDetail,
    closeOrderModal,
    saveOrderModalChanges,
    cancelSelectedOrder,
    printCurrentOrderInvoice,
    quickWhatsAppCustomer,
    exportOrdersCSV,
    renderCatalogTable,
    quickToggleSkuFeed,
    bulkUpdateFilteredCatalog,
    bulkApproveAllCatalogForFeed,
    openProductDetailModal,
    closeProductDetailModal,
    saveProductDetailChanges,
    renderCouponsTable,
    toggleCouponStatus,
    deleteCouponRow,
    openNewCouponModal,
    openEditCouponModal,
    closeNewCouponModal,
    submitNewCoupon,
    runCouponSimulator,
    renderCustomersTable,
    renderCourierTable,
    quickSaveCourier,
    copyCourierFormat,
    exportCourierManifestCSV,
    openNewOrderModal,
    closeNewOrderModal,
    addManualOrderLineItem,
    removeManualOrderLineItem,
    recalcManualOrderPreview,
    submitNewManualOrder,
    saveStoreSettings,
    testMetaCapi,
    copyFeedUrl,
    buildAdCampaignUrl,
    copyCampaignUrl,
    openCommandPalette,
    closeCommandPalette,
    renderCommandPaletteResults
  });

  window.addEventListener('DOMContentLoaded', () => {
    initDashboard();
    buildAdCampaignUrl();
  });
})(window, document);
