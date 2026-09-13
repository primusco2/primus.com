// netlify/functions/api.js
//
// This is the ONE backend function that index.html and owner.html both talk
// to through the "/api/*" redirect in netlify.toml. It was missing from the
// deploy, which is why the Owner Console showed:
//   "Couldn't find the server's admin endpoint" (a 404 from /api/admin/state).
//
// Routes handled here (matched against the part of the path after "/api"):
//   GET  /state                        -> public site data (no secrets)
//   POST /state                        -> admin-only: save the full state
//   GET  /admin/state                  -> admin-only: read the full state
//   POST /payments/paymongo/checkout   -> start a PayMongo Checkout Session
//   GET  /payments/paymongo/status     -> poll a checkout session's status
//   POST /payments/manual              -> record a manual bank/GCash transfer
//
// Storage: Netlify Blobs (already listed in package.json). No manual siteID/
// token config is needed — that's handled automatically inside a deployed
// Netlify Function.
//
// Optional environment variable (Site settings -> Environment variables):
//   PAYMONGO_SECRET_KEY   sk_test_... or sk_live_...  (enables live checkout)

const { getStore } = require('@netlify/blobs');

const STATE_KEY = 'app-state';
const PAYMENTS_KEY = 'pending-payments';

// Mirrors index.html's `defaultAppSettings`, so a brand-new deploy (empty
// Blobs store) serves a fully working site immediately.
const DEFAULT_STATE = {
  calendarActive: true,
  membershipActive: true,
  blockedDates: ['2026-12-25', '2026-12-31'],
  subscriptionAmount: 500,
  discountRate: 15,
  currency: '₱',
  businessName: 'Primus Barbershop & Grooming Co.',
  brandName: 'PRIMUS',
  brandInitial: 'P',
  brandLogo: '',
  heroTitle: 'PRECISION CUTS. LIQUID CLASS.',
  heroSub: 'Experience elite grooming tailored to your style. Designed with modern luxury, crafted with timeless expertise.',
  footerBrandDesc: 'Modern luxury and precision grooming tailored to your style. Experience the highest standard of barbershop craftsmanship.',
  ownerName: 'Nasrin Abubakar',
  copyrightText: 'Primus Barbershop & Grooming Co. All rights reserved.',
  contactEmail: 'primus.barbershop@outlook.com',
  contactPhone: '+639473875093',
  socialLinks: {
    instagram: 'https://instagram.com',
    facebook: 'https://facebook.com',
    tiktok: 'https://tiktok.com',
    twitter: 'https://twitter.com'
  },
  chatWelcomeMessage: 'Hello! Welcome to Primus Barbershop. How can I assist you with your booking or reviews today? If you need a human agent, just say so!',
  services: [
    { name: 'Signature Haircut', price: 600, desc: 'Precision cut, hot towel finish, and modern styling.' },
    { name: 'Beard Sculpting', price: 400, desc: 'Beard shaping with razor line finish and nourishing oil.' },
    { name: 'Hot Towel Shave', price: 450, desc: 'Traditional straight razor shave with essential oils and hot towels.' },
    { name: 'Executive Package', price: 1200, desc: 'Full haircut, beard sculpt, scalp treatment, and hot towel shave.' }
  ],
  barbers: ['Master Stylist', 'Senior Barber'],
  barberPositions: ['Master Stylist', 'Senior Barber', 'Barber', 'Apprentice'],
  staffPositions: ['Admin', 'Support'],
  staffStatuses: ['Active', 'Break', 'Lunch', 'Inactive'],
  timeSlots: ['09:00 AM', '10:00 AM', '11:00 AM', '11:30 AM', '01:00 PM', '01:30 PM', '02:30 PM', '03:30 PM', '04:00 PM', '05:00 PM', '06:00 PM', '07:30 PM'],
  hours: [
    { day: 'Monday – Friday', time: '09:00 AM – 08:00 PM' },
    { day: 'Saturday', time: '09:00 AM – 09:00 PM' },
    { day: 'Sunday', time: '10:00 AM – 06:00 PM' }
  ],
  gallery: [
    { title: 'High Skin Fade', desc: 'Clean taper fade paired with textured top styling.', img: 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=600&q=80' },
    { title: 'Beard Sculpt & Lineup', desc: 'Razor sharp edge-up with organic conditioning oil finish.', img: 'https://images.unsplash.com/photo-1621605815971-fbc98d665033?auto=format&fit=crop&w=600&q=80' },
    { title: 'Classic Pompadour', desc: 'Timeless side part with medium hold shine finish.', img: 'https://images.unsplash.com/photo-1599351431202-1e0f0137899a?auto=format&fit=crop&w=600&q=80' }
  ],
  reviews: [
    { author: 'Julian Vance', rating: 5, comment: 'Absolute top-tier service. The skin fade is razor sharp and the hot towel finish is extremely relaxing.', date: 'August 18, 2026', barber: 'Master Stylist' },
    { author: 'Arthur Pendelton', rating: 5, comment: 'Best barbershop experience in town. Clean atmosphere, friendly staff, and world-class beard sculpting.', date: 'September 2, 2026', barber: 'Senior Barber' },
    { author: 'Liam Dawson', rating: 4, comment: 'Great attention to detail. Will definitely be returning for my monthly executive package.', date: 'September 8, 2026', barber: 'Master Stylist' }
  ],
  emailjs: {
    publicKey: 'ufqkqsyyuGHR0c7ek',
    serviceId: 'servicesw_obkc6qi',
    templateId: 'template_qcou40j',
    barberResetTemplateId: ''
  },
  adminPassword: 'primusadmin2026',
  callWaitMinutes: 5,
  members: {
    'MEM-12345': { name: 'Sample User', email: 'sample@example.com', phone: '09171234567', paidDate: '2026-09-01', active: true }
  },
  barberAccounts: [],
  bookings: [],
  merchant: {
    paymongoEnabled: false,
    gcash: { name: '', number: '', qrImage: '', logoImage: '' },
    maya: { name: '', number: '', qrImage: '', logoImage: '' },
    gotyme: { name: '', number: '', qrImage: '', logoImage: '' },
    maribank: { name: '', number: '', qrImage: '', logoImage: '' },
    paypal: { name: '', number: '', qrImage: '' },
    genericQr: { label: 'Scan to Pay (PH QR)', qrImage: '' }
  }
};

function appStore() {
  return getStore({ name: 'primus-barbershop', consistency: 'strong' });
}

async function loadState() {
  const raw = await appStore().get(STATE_KEY, { type: 'json' });
  return raw || JSON.parse(JSON.stringify(DEFAULT_STATE));
}

async function saveState(state) {
  await appStore().setJSON(STATE_KEY, state);
}

async function loadPayments() {
  const raw = await appStore().get(PAYMENTS_KEY, { type: 'json' });
  return raw || {};
}

async function savePayments(payments) {
  await appStore().setJSON(PAYMENTS_KEY, payments);
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return '';
}

function parseJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  return JSON.parse(raw);
}

function matchesMember(m, email, phone) {
  const last10 = s => (s || '').replace(/\D/g, '').slice(-10);
  return (m.email && email && m.email.toLowerCase() === email.toLowerCase()) ||
    (m.phone && phone && last10(m.phone) === last10(phone) && last10(phone).length > 0);
}

function newMembershipNumber() {
  return 'MEM-' + Math.floor(10000 + Math.random() * 90000);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleGetState() {
  const state = await loadState();
  const pub = Object.assign({}, state);
  delete pub.adminPassword;
  delete pub.ownerFaceDescriptor;
  pub.paymongoAvailable = !!process.env.PAYMONGO_SECRET_KEY;
  return respond(200, pub);
}

async function handlePostState(event) {
  const state = await loadState();
  const pwd = getHeader(event, 'x-admin-password');
  if (pwd !== (state.adminPassword || DEFAULT_STATE.adminPassword)) {
    return respond(401, { error: 'Invalid admin password.' });
  }
  let incoming;
  try {
    incoming = parseJsonBody(event);
  } catch (e) {
    return respond(400, { error: 'Invalid JSON body.' });
  }
  if (!incoming || typeof incoming !== 'object') {
    return respond(400, { error: 'Request body must be a JSON object.' });
  }
  await saveState(incoming);
  return respond(200, { ok: true });
}

async function handleGetAdminState(event) {
  const state = await loadState();
  const pwd = getHeader(event, 'x-admin-password');
  if (pwd !== (state.adminPassword || DEFAULT_STATE.adminPassword)) {
    return respond(401, { error: 'Invalid admin password.' });
  }
  return respond(200, state);
}

async function handlePaymongoCheckout(event) {
  const secretKey = process.env.PAYMONGO_SECRET_KEY;
  if (!secretKey) {
    return respond(400, { error: 'Online payments are not configured on this server yet.' });
  }

  let body;
  try {
    body = parseJsonBody(event);
  } catch (e) {
    return respond(400, { error: 'Invalid JSON body.' });
  }
  const { method, name, email, phone } = body || {};
  if (!method || !name || !email || !phone) {
    return respond(400, { error: 'Missing name, email, phone, or payment method.' });
  }

  const state = await loadState();
  if (!state.merchant || !state.merchant.paymongoEnabled) {
    return respond(400, { error: 'Online payments are currently disabled by the shop.' });
  }

  const methodMap = { card: 'card', gcash: 'gcash', maya: 'paymaya' };
  const pmType = methodMap[method];
  if (!pmType) {
    return respond(400, { error: 'That payment method does not support online checkout.' });
  }

  const amountCentavos = Math.round(Number(state.subscriptionAmount || 500) * 100);
  const reference = 'PM' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();

  const siteUrl = process.env.URL || `https://${getHeader(event, 'host')}`;
  const success_url = `${siteUrl}/?paymongo=success&ref=${encodeURIComponent(reference)}`;
  const cancel_url = `${siteUrl}/?paymongo=cancelled&ref=${encodeURIComponent(reference)}`;

  const payload = {
    data: {
      attributes: {
        line_items: [{ name: `${state.brandName || 'Shop'} Membership`, amount: amountCentavos, currency: 'PHP', quantity: 1 }],
        payment_method_types: [pmType],
        success_url,
        cancel_url,
        reference_number: reference,
        billing: { name, email, phone },
        description: 'Barbershop membership signup'
      }
    }
  };

  let resp, data;
  try {
    resp = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(secretKey + ':').toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    data = await resp.json();
  } catch (e) {
    return respond(502, { error: 'Could not reach PayMongo. Please try again.' });
  }

  if (!resp.ok) {
    const msg = (data && data.errors && data.errors[0] && data.errors[0].detail) || 'PayMongo rejected the checkout request.';
    return respond(400, { error: msg });
  }

  const sessionId = data.data.id;
  const checkoutUrl = data.data.attributes.checkout_url;

  const payments = await loadPayments();
  payments[reference] = { sessionId, method, name, email, phone, fulfilled: false, createdAt: Date.now() };
  await savePayments(payments);

  return respond(200, { checkoutUrl, reference });
}

async function handlePaymongoStatus(event) {
  const ref = (event.queryStringParameters || {}).ref;
  if (!ref) return respond(400, { error: 'Missing ref.' });

  const payments = await loadPayments();
  const entry = payments[ref];
  if (!entry) return respond(404, { error: 'Unknown reference.' });

  if (entry.fulfilled && entry.membershipNumber) {
    return respond(200, { status: 'paid', membershipNumber: entry.membershipNumber });
  }

  const secretKey = process.env.PAYMONGO_SECRET_KEY;
  if (!secretKey) return respond(200, { status: 'pending' });

  let resp, data;
  try {
    resp = await fetch(`https://api.paymongo.com/v2/checkout_sessions/${entry.sessionId}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(secretKey + ':').toString('base64') }
    });
    data = await resp.json();
  } catch (e) {
    return respond(200, { status: 'pending' });
  }
  if (!resp.ok) return respond(200, { status: 'pending' });

  const attrs = (data.data && data.data.attributes) || {};
  const paymentsArr = attrs.payments || [];
  const isPaid =
    attrs.status === 'paid' ||
    paymentsArr.some(p => (p.attributes && p.attributes.status === 'paid') || p.status === 'paid') ||
    (attrs.payment_intent && attrs.payment_intent.attributes && attrs.payment_intent.attributes.status === 'succeeded');

  if (!isPaid) return respond(200, { status: 'pending' });

  // Payment confirmed: activate (or create) the membership.
  const state = await loadState();
  state.members = state.members || {};
  let memNum = null;
  for (const [num, m] of Object.entries(state.members)) {
    if (matchesMember(m, entry.email, entry.phone)) { memNum = num; break; }
  }
  if (!memNum) memNum = newMembershipNumber();

  state.members[memNum] = {
    name: entry.name,
    email: entry.email,
    phone: entry.phone,
    method: entry.method,
    referenceNumber: ref,
    paidDate: new Date().toISOString().slice(0, 10),
    active: true,
    pendingVerification: false
  };
  await saveState(state);

  entry.fulfilled = true;
  entry.membershipNumber = memNum;
  payments[ref] = entry;
  await savePayments(payments);

  return respond(200, { status: 'paid', membershipNumber: memNum });
}

async function handleManualPayment(event) {
  let body;
  try {
    body = parseJsonBody(event);
  } catch (e) {
    return respond(400, { error: 'Invalid JSON body.' });
  }
  const { method, name, email, phone, referenceNumber } = body || {};
  if (!method || !name || !email || !phone || !referenceNumber) {
    return respond(400, { error: 'Missing required fields.' });
  }

  const state = await loadState();
  state.members = state.members || {};

  let memNum = null;
  for (const [num, m] of Object.entries(state.members)) {
    if (matchesMember(m, email, phone)) { memNum = num; break; }
  }
  if (!memNum) memNum = newMembershipNumber();

  state.members[memNum] = {
    name,
    email,
    phone,
    method,
    referenceNumber,
    paidDate: new Date().toISOString().slice(0, 10),
    active: false,
    pendingVerification: true
  };
  await saveState(state);

  return respond(200, { membershipNumber: memNum });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  // Netlify resolves the "/api/*" redirect to this function with the full
  // rewritten path in event.path. Strip whichever prefix is present so this
  // works whether event.path is "/.netlify/functions/api/state",
  // "/api/state", or (when hit directly) "/state".
  let path = event.path || '/';
  path = path.replace(/^\/\.netlify\/functions\/api/, '');
  path = path.replace(/^\/api/, '');
  if (!path) path = '/';

  const method = event.httpMethod;

  try {
    if (path === '/state' && method === 'GET') return await handleGetState();
    if (path === '/state' && method === 'POST') return await handlePostState(event);
    if (path === '/admin/state' && method === 'GET') return await handleGetAdminState(event);
    if (path === '/payments/paymongo/checkout' && method === 'POST') return await handlePaymongoCheckout(event);
    if (path === '/payments/paymongo/status' && method === 'GET') return await handlePaymongoStatus(event);
    if (path === '/payments/manual' && method === 'POST') return await handleManualPayment(event);

    return respond(404, { error: `No API route for ${method} ${path}` });
  } catch (err) {
    console.error('api function error:', err);
    return respond(500, { error: 'Internal server error.' });
  }
};
