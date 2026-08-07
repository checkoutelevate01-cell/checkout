require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const path     = require('path');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const QRCode   = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;
const PAGARME_URL = 'https://api.pagar.me/core/v5';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── Mappers (snake_case DB → camelCase app) ─────────────────────────────────
function mapOffer(row) {
  if (!row) return null;
  return {
    id:                  row.id,
    slug:                row.slug,
    name:                row.name,
    description:         row.description,
    price:               row.price,
    statementDescriptor: row.statement_descriptor,
    maxInstallments:     row.max_installments,
    noInterestUpTo:      row.no_interest_up_to,
    interestRate:        row.interest_rate ?? 1.99,
    mentorName:          row.mentor_name,
    whatsappContact:     row.whatsapp_contact,
    pixExpiresIn:        row.pix_expires_in,
    boletoDueDays:       row.boleto_due_days,
    showInstagram:       row.show_instagram || false,
    showMedicalFields:   row.show_medical_fields ?? true,
    showCoupon:          row.show_coupon ?? true,
    showEmail:           row.show_email ?? true,
    showPhone:           row.show_phone ?? true,
    guaranteeTitle:      row.guarantee_title || '',
    guaranteeText:       row.guarantee_text  || '',
    guaranteeSub:        row.guarantee_sub   || '',
    thankYouMessage:     row.thank_you_message || '',
    pitchEnabled:        row.pitch_enabled === true,
    pitchTitle:          row.pitch_title       || '',
    pitchCopy:           row.pitch_copy        || '',
    pitchCta:            row.pitch_cta         || '',
    pitchTodayLabel:       row.pitch_today_label       ?? 'entrada',
    pitchTodayValue:       row.pitch_today_value       || '',
    pitchTodayBadge:       row.pitch_today_badge       || '',
    pitchTodayNote:        row.pitch_today_note        || '',
    pitchInstallmentLabel: row.pitch_installment_label ?? 'Depois, parcelado em',
    pitchInstallmentValue: row.pitch_installment_value || '',
    pitchAfterLabel:       row.pitch_after_label       ?? 'Valor oficial',
    pitchAfterValue:       row.pitch_after_value       || '',
    pitchSavings:          row.pitch_savings           || '',
    pitchTotalValue:       row.pitch_total_value       || '',
    pitchFootnote:         row.pitch_footnote          || '',
    createdBy:           row.created_by || null,
    trackMeta:           row.track_meta === true,
    metaContentId:       row.meta_content_id || '',
    active:              row.active,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
  };
}

// Áreas do admin que podem ser liberadas por colaborador
const PERM_KEYS = ['dashboard', 'offers', 'coupons', 'orders', 'leads'];
// Colaborador sem permissões definidas mantém o acesso padrão (links + compras)
const DEFAULT_PERMS = { dashboard: false, offers: true, coupons: false, orders: true, leads: false };

function normalizePerms(p) {
  const src = (p && typeof p === 'object' && Object.keys(p).length) ? p : DEFAULT_PERMS;
  const out = {};
  PERM_KEYS.forEach(k => { out[k] = src[k] === true; });
  return out;
}

// Usuário do admin — nunca expõe password_hash
function mapUser(row) {
  if (!row) return null;
  return {
    id:          row.id,
    email:       row.email,
    name:        row.name || '',
    role:        row.role || 'collaborator',
    permissions: normalizePerms(row.permissions),
    active:      row.active !== false,
    createdAt:   row.created_at,
  };
}

// Permissões efetivas do usuário logado (admin = tudo)
async function getEffectivePerms(user) {
  if (!user) return null;
  if (user.role === 'admin') {
    const all = {}; PERM_KEYS.forEach(k => all[k] = true); return all;
  }
  if (!user.userId) return normalizePerms(null);
  try {
    const { data } = await supabase.from('admin_users').select('permissions').eq('id', user.userId).maybeSingle();
    return normalizePerms(data?.permissions);
  } catch { return normalizePerms(null); }
}

// Middleware: exige uma permissão específica (admin passa sempre)
function authPerm(area) {
  return async (req, res, next) => {
    const user = getTokenUser(req);
    if (!user) return res.status(401).json({ error: 'Não autorizado' });
    req.user = user; req.role = user.role;
    if (user.role === 'admin') return next();
    const perms = await getEffectivePerms(user);
    if (perms && perms[area]) return next();
    return res.status(403).json({ error: 'Sem permissão para esta área' });
  };
}

function mapCoupon(row) {
  if (!row) return null;
  return {
    id:          row.id,
    code:        row.code,
    type:        row.type,
    value:       row.value,
    maxUses:     row.max_uses,
    usedCount:   row.used_count,
    offerId:     row.offer_id,
    offerIds:    (Array.isArray(row.offer_ids) && row.offer_ids.length) ? row.offer_ids : (row.offer_id ? [row.offer_id] : []),
    bannerTitle: row.banner_title || null,
    bannerText:  row.banner_text  || null,
    active:      row.active,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

// Cupom vale para a oferta? Sem ofertas vinculadas = vale para todas.
function couponMatchesOffer(coupon, offerId) {
  const ids = coupon.offerIds || [];
  if (!ids.length) return true;
  return !!offerId && ids.includes(offerId);
}

// Normaliza a lista de ofertas vinculadas (aceita array novo ou offerId legado)
function sanitizeOfferIds(arr, legacySingle) {
  let ids = Array.isArray(arr) ? arr : (arr ? [arr] : []);
  if (!ids.length && legacySingle) ids = [legacySingle];
  return [...new Set(ids.filter(x => typeof x === 'string' && x))].slice(0, 100);
}

// ─── Storage helpers ──────────────────────────────────────────────────────────
async function getOffers() {
  const { data, error } = await supabase.from('offers').select('*').order('created_at');
  if (error) throw error;
  return (data || []).map(mapOffer);
}

async function getCoupons() {
  const { data, error } = await supabase.from('coupons').select('*').order('created_at');
  if (error) throw error;
  return (data || []).map(mapCoupon);
}

async function getOrders(filters = {}) {
  let q = supabase.from('orders').select('*');
  if (filters.method) q = q.eq('payment_method', filters.method);
  if (filters.from)   q = q.gte('created_at', filters.from);
  if (filters.to)     q = q.lte('created_at', filters.to + 'T23:59:59Z');
  q = q.order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function appendOrder(record) {
  const row = {
    id:                 record.id,
    pagarme_order_id:   record.pagarmeOrderId,
    status:             record.status,
    charge_status:      record.chargeStatus,
    payment_method:     record.paymentMethod,
    installments:       record.installments,
    amount_cents:       record.amountCents,
    discount_cents:     record.discountCents,
    final_amount_cents: record.finalAmountCents,
    customer:           record.customer,
    offer:              record.offer,
    coupon:             record.coupon,
    pix:                record.pix,
    boleto:             record.boleto,
    simulated:          record.simulated || false,
    failure_reason:     record.failureReason || null,
    meta:               record.meta || {},
    created_at:         record.createdAt,
  };
  let { error } = await supabase.from('orders').insert(row);
  // Resiliência: se uma coluna opcional ainda não foi migrada, salva o pedido sem ela
  if (error && /column|schema cache/i.test(error.message || '')) {
    const m = (error.message || '').match(/'([a-z_]+)' column/i);
    const col = m ? m[1] : 'meta';
    if (col in row) {
      console.warn(`[Orders] coluna "${col}" ausente — salvando pedido sem ela. Rode a migração do Supabase.`);
      delete row[col];
      ({ error } = await supabase.from('orders').insert(row));
    }
  }
  if (error) throw error;
  // Mark lead as converted
  if (record.leadId) {
    await supabase.from('leads')
      .update({ status: 'convertido', order_id: record.id, updated_at: new Date().toISOString() })
      .eq('id', record.leadId);
  }
}

function newId() { return crypto.randomUUID(); }

// ─── Meta — Pixel + Conversions API ───────────────────────────────────────────
// Pixel ID é público (já aparece no client). Token da CAPI é secreto: vem de env
// ou da aba Integrações (app_settings), NUNCA do código (vazaria no GitHub).
const META_PIXEL_ID    = process.env.META_PIXEL_ID    || '1810657219916478';
const META_CAPI_TOKEN  = process.env.META_CAPI_TOKEN  || '';
const META_API_VERSION = 'v21.0';

function metaHash(v) {
  return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
}

// ─── Configurações globais (aba Integrações) — cache curto ────────────────────
let _settingsCache = null, _settingsCacheAt = 0;
async function getSettings() {
  if (_settingsCache && Date.now() - _settingsCacheAt < 30000) return _settingsCache;
  try {
    const { data } = await supabase.from('app_settings').select('*').eq('id', 'global').maybeSingle();
    _settingsCache = data || {};
  } catch { _settingsCache = {}; }
  _settingsCacheAt = Date.now();
  return _settingsCache;
}
function invalidateSettings() { _settingsCache = null; }

// Credenciais Meta: settings do banco têm prioridade; env é fallback
async function metaCreds() {
  const s = await getSettings();
  return {
    pixelId: s.meta_pixel_id  || META_PIXEL_ID   || '',
    token:   s.meta_capi_token || META_CAPI_TOKEN || '',
  };
}

// Monta o payload enviado à Clint (chaves em EN e PT p/ facilitar o mapeamento)
function buildClintPayload(lead, origin, offerName) {
  const phone = lead.phone || '';
  const slug  = lead.offer_slug || null;
  const oName = offerName || slug || null;
  return {
    event:        'lead',
    origin:       origin || 'Checkout',
    origem:       origin || 'Checkout',
    name:         lead.name,
    nome:         lead.name,
    email:        lead.email,
    phone,
    telefone:     phone,
    whatsapp:     phone,
    specialty:    lead.specialty || null,
    especialidade:lead.specialty || null,
    crm:          lead.crm || null,
    instagram:    lead.instagram || null,
    offer:        slug,
    oferta:       slug,
    offer_name:   oName,
    oferta_nome:  oName,
    status:       lead.status || 'lead',
    created_at:   lead.created_at,
  };
}

// Envia o lead capturado para o webhook da Clint (se configurado)
async function sendClintLead(lead) {
  try {
    const s = await getSettings();
    if (!s.clint_enabled || !s.clint_webhook_url) return;
    let offerName = null;
    if (lead.offer_slug) {
      const offers = await getOffers();
      offerName = offers.find(o => o.slug === lead.offer_slug)?.name || null;
    }
    await axios.post(s.clint_webhook_url, buildClintPayload(lead, s.clint_origin, offerName), {
      timeout: 8000,
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('[Clint] Lead enviado:', lead.email, '| oferta:', offerName || lead.offer_slug || '—');
  } catch (e) {
    console.error('[Clint]', e.response?.status || e.message);
  }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// Contexto do navegador para melhorar o match da CAPI
function extractMetaContext(req, clientMeta = {}) {
  const cookies = parseCookies(req.headers.cookie || '');
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return {
    ip:        fwd || req.socket?.remoteAddress || null,
    ua:        req.headers['user-agent'] || null,
    fbp:       clientMeta.fbp || cookies._fbp || null,
    fbc:       clientMeta.fbc || cookies._fbc || null,
    sourceUrl: clientMeta.sourceUrl || req.headers.referer || null,
  };
}

// Envia o evento Purchase para a Conversions API (somente ofertas com track_meta)
async function sendMetaPurchase(record) {
  try {
    const { pixelId, token } = await metaCreds();
    if (!pixelId || !token) return;
    if (!record?.offer) return;

    const offers = await getOffers();
    const off = offers.find(o => o.id === record.offer.id || o.slug === record.offer.slug);
    if (!off || off.trackMeta !== true) return;

    const value = (off.price || 0) / 100; // valor cheio do plano
    if (value <= 0) return;

    const meta  = record.meta || {};
    const user_data = {};
    if (record.customer?.email) user_data.em = [metaHash(record.customer.email)];
    const digits = (record.customer?.phone || '').replace(/\D/g, '');
    if (digits) user_data.ph = [metaHash(digits.startsWith('55') ? digits : '55' + digits)];
    if (meta.fbp) user_data.fbp = meta.fbp;
    if (meta.fbc) user_data.fbc = meta.fbc;
    if (meta.ip)  user_data.client_ip_address = meta.ip;
    if (meta.ua)  user_data.client_user_agent = meta.ua;

    const payload = {
      data: [{
        event_name:     'Purchase',
        event_time:     Math.floor(Date.now() / 1000),
        action_source:  'website',
        event_id:       record.pagarmeOrderId,           // dedup com o Pixel (eventID)
        ...(meta.sourceUrl ? { event_source_url: meta.sourceUrl } : {}),
        user_data,
        custom_data: {
          currency:     'BRL',
          value:        value.toFixed(2),
          content_name: record.offer.name || off.name,
          content_ids:  [off.metaContentId || record.offer.slug || off.slug],
          content_type: 'product',
          order_id:     record.pagarmeOrderId,
        },
      }],
    };

    await axios.post(
      `https://graph.facebook.com/${META_API_VERSION}/${pixelId}/events`,
      payload,
      { params: { access_token: token } }
    );
    console.log('[Meta CAPI] Purchase enviado:', record.pagarmeOrderId, off.slug);
  } catch (e) {
    console.error('[Meta CAPI]', e.response?.data?.error?.message || e.message);
  }
}

// ─── Admin Auth ───────────────────────────────────────────────────────────────
const JWT_SECRET     = process.env.ADMIN_JWT_SECRET || 'elevate-jwt-secret-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD   || '';
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();

// Hash de senha com módulo nativo crypto (scrypt) — sem dependência extra
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuf   = Buffer.from(hash, 'hex');
  const verifyBuf = crypto.scryptSync(String(plain), salt, 64);
  return hashBuf.length === verifyBuf.length && crypto.timingSafeEqual(hashBuf, verifyBuf);
}

// Identidade do token: { userId, email, role, name }
function getTokenUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return { userId: p.userId || null, email: p.email || null, role: p.role || 'admin', name: p.name || '' };
  } catch { return null; }
}

function authAdmin(req, res, next) {
  const user = getTokenUser(req);
  if (!user) return res.status(401).json({ error: 'Não autorizado' });
  req.user = user;
  req.role = user.role;
  next();
}

function authOnlyAdmin(req, res, next) {
  const user = getTokenUser(req);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  req.user = user;
  req.role = user.role;
  next();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function pagarmeHeaders() {
  const encoded = Buffer.from(`${process.env.PAGARME_API_KEY}:`).toString('base64');
  return {
    Authorization: `Basic ${encoded}`,
    'Content-Type': 'application/json',
  };
}

// Monta o customer só com os campos que o lead de fato informou —
// email/telefone podem estar desligados por oferta (ver showEmail/showPhone); CPF é sempre obrigatório
function buildCustomer(data) {
  const customer = { name: data.name.trim(), type: 'individual' };

  if (data.email) customer.email = data.email.trim().toLowerCase();

  if (data.document) {
    customer.document      = data.document.replace(/\D/g, '');
    customer.document_type = 'CPF';
  }

  if (data.phone) {
    let phone = data.phone.replace(/\D/g, '');
    // Remove country code 55 se vier na frente (ex: 5511999999999 → 11999999999)
    if (phone.length >= 12 && phone.startsWith('55')) phone = phone.slice(2);
    if (phone) {
      customer.phones = {
        mobile_phone: {
          country_code: '55',
          area_code:    phone.slice(0, 2),
          number:       phone.slice(2),
        },
      };
    }
  }

  return customer;
}

function buildItems(offer) {
  const price = offer
    ? offer.price
    : (parseInt(process.env.PRODUCT_PRICE, 10) || 350000);
  const desc = (offer?.description || process.env.PRODUCT_DESCRIPTION || '').trim() || 'Mentoria Premium';
  return [{ amount: price, description: desc, quantity: 1, code: 'MENTORIA_001' }];
}

function buildPayment(payment, offer) {
  const { method } = payment;

  if (method === 'credit_card') {
    const { card, installments } = payment;
    const [expMonth, expYearRaw] = (card.expiry || '').split('/');
    const expYear = expYearRaw?.trim().length === 4 ? expYearRaw.trim() : `20${expYearRaw?.trim()}`;
    const descriptor = offer
      ? (offer.statementDescriptor || 'MENTORIA').slice(0, 13)
      : (process.env.STATEMENT_DESCRIPTOR || 'MENTORIA').slice(0, 13);
    return [{
      payment_method: 'credit_card',
      credit_card: {
        installments:         parseInt(installments, 10) || 1,
        statement_descriptor: descriptor,
        card: {
          number:      card.number.replace(/\D/g, ''),
          holder_name: card.holder_name.toUpperCase().trim(),
          exp_month:   parseInt(expMonth, 10),
          exp_year:    parseInt(expYear, 10),
          cvv:         card.cvv,
          billing_address: {
            line_1:   'Av. Paulista, 1106',
            zip_code: '01310100',
            city:     'São Paulo',
            state:    'SP',
            country:  'BR',
          },
        },
      },
    }];
  }

  if (method === 'pix') {
    const expiresIn = offer
      ? (offer.pixExpiresIn || 3600)
      : (parseInt(process.env.PIX_EXPIRES_IN, 10) || 3600);
    return [{ payment_method: 'pix', pix: { expires_in: expiresIn } }];
  }

  return null;
}

// ─── Validation ───────────────────────────────────────────────────────────────
function validateCustomer(data, offer) {
  const showEmail = offer ? (offer.showEmail ?? true) : true;
  const showPhone = offer ? (offer.showPhone ?? true) : true;

  if (!data?.name || data.name.trim().length < 3) return 'Nome inválido';
  if (showEmail && (!data?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))) return 'E-mail inválido';
  if (!data?.document || data.document.replace(/\D/g, '').length !== 11) return 'CPF inválido';
  if (showPhone && (!data?.phone || data.phone.replace(/\D/g, '').length < 10)) return 'Telefone inválido';
  return null;
}

function validatePayment(payment) {
  if (!['credit_card', 'pix'].includes(payment?.method)) return 'Método de pagamento inválido';
  if (payment.method === 'credit_card') {
    const { card } = payment;
    if (!card?.number || card.number.replace(/\D/g, '').length < 14) return 'Número do cartão inválido';
    if (!card?.holder_name || card.holder_name.trim().length < 3) return 'Nome do titular inválido';
    if (!card?.expiry || !/^\d{2}\/\d{2}$/.test(card.expiry)) return 'Data de validade inválida';
    if (!card?.cvv || card.cvv.length < 3) return 'CVV inválido';
  }
  return null;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/config', async (req, res) => {
  try {
    const slug = req.query.offer;
    let offer = null;

    if (slug) {
      const offers = await getOffers();
      offer = offers.find(o => o.slug === slug && o.active !== false);
      if (!offer) return res.status(404).json({ error: 'Oferta não encontrada' });
    }

    const price          = offer ? offer.price          : (parseInt(process.env.PRODUCT_PRICE, 10) || 350000);
    const maxInstall     = offer ? offer.maxInstallments : (parseInt(process.env.MAX_INSTALLMENTS, 10) || 12);
    const noInterestUpTo = offer ? offer.noInterestUpTo  : (parseInt(process.env.MAX_INSTALLMENTS_NO_INTEREST, 10) || 12);
    const interestRate   = offer ? offer.interestRate : 1.99;
    const meta           = await metaCreds();

    res.json({
      productName:        offer ? offer.name        : (process.env.PRODUCT_NAME        || 'Mentoria Estratégica Premium'),
      productDescription: offer ? offer.description : (process.env.PRODUCT_DESCRIPTION || 'Mentoria individual intensiva'),
      productPrice:       price,
      mentorName:         offer ? offer.mentorName  : (process.env.MENTOR_NAME || 'Mentor'),
      maxInstallments:    maxInstall,
      noInterestUpTo,
      interestRate,
      whatsappContact:    offer ? (offer.whatsappContact || '') : (process.env.WHATSAPP_CONTACT || ''),
      showInstagram:      offer ? (offer.showInstagram || false) : false,
      showMedicalFields:  offer ? (offer.showMedicalFields ?? true) : true,
      showCoupon:         offer ? (offer.showCoupon ?? true) : true,
      showEmail:          offer ? (offer.showEmail ?? true) : true,
      showPhone:          offer ? (offer.showPhone ?? true) : true,
      guaranteeTitle:     offer ? (offer.guaranteeTitle || '') : '',
      guaranteeText:      offer ? (offer.guaranteeText  || '') : '',
      guaranteeSub:       offer ? (offer.guaranteeSub   || '') : '',
      thankYouMessage:    offer ? (offer.thankYouMessage || '') : '',
      metaPixelId:        (offer && offer.trackMeta) ? meta.pixelId : '',
      trackMeta:          offer ? offer.trackMeta === true : false,
      metaContentId:      offer ? (offer.metaContentId || offer.slug) : '',
      pitch: {
        enabled:          offer ? offer.pitchEnabled === true : false,
        title:            offer ? (offer.pitchTitle            || '') : '',
        copy:             offer ? (offer.pitchCopy             || '') : '',
        cta:              offer ? (offer.pitchCta              || '') : '',
        todayLabel:       offer ? (offer.pitchTodayLabel       ?? 'entrada') : 'entrada',
        todayValue:       offer ? (offer.pitchTodayValue       || '') : '',
        todayBadge:       offer ? (offer.pitchTodayBadge       || '') : '',
        todayNote:        offer ? (offer.pitchTodayNote        || '') : '',
        installmentLabel: offer ? (offer.pitchInstallmentLabel ?? 'Depois, parcelado em') : 'Depois, parcelado em',
        installmentValue: offer ? (offer.pitchInstallmentValue || '') : '',
        afterLabel:       offer ? (offer.pitchAfterLabel       ?? 'Valor oficial') : 'Valor oficial',
        afterValue:       offer ? (offer.pitchAfterValue       || '') : '',
        savings:          offer ? (offer.pitchSavings          || '') : '',
        totalValue:       offer ? (offer.pitchTotalValue       || '') : '',
        footnote:         offer ? (offer.pitchFootnote         || '') : '',
      },
      offerSlug:          slug || null,
    });
  } catch (err) {
    console.error('[Config]', err.message);
    res.status(500).json({ error: 'Erro ao carregar configurações' });
  }
});

app.post('/api/order', async (req, res) => {
  const { customer: customerData, payment, offerSlug, couponCode, leadId } = req.body;
  const capiMeta = extractMetaContext(req, req.body.meta || {});

  try {
    // Resolve offer
    let offer = null;
    if (offerSlug) {
      const offers = await getOffers();
      offer = offers.find(o => o.slug === offerSlug && o.active !== false);
      if (!offer) return res.status(404).json({ error: 'Oferta não encontrada' });
    }

    const customerError = validateCustomer(customerData, offer);
    if (customerError) return res.status(400).json({ error: customerError });

    const paymentError = validatePayment(payment);
    if (paymentError) return res.status(400).json({ error: paymentError });

    // Resolve coupon
    let discount = 0;
    let appliedCoupon = null;
    if (couponCode) {
      const coupons = await getCoupons();
      const coupon  = coupons.find(c =>
        c.code.toUpperCase() === couponCode.toUpperCase() &&
        c.active !== false &&
        (c.maxUses == null || c.usedCount < c.maxUses) &&
        couponMatchesOffer(c, offer?.id)
      );
      if (coupon) {
        const basePrice = offer ? offer.price : (parseInt(process.env.PRODUCT_PRICE, 10) || 350000);
        if (coupon.type === 'percent') {
          discount = Math.round(basePrice * coupon.value / 100);
        } else {
          discount = Math.min(coupon.value, basePrice);
        }
        appliedCoupon = coupon;
      }
    }

    // Apply discount to items
    let items = buildItems(offer);
    const basePrice = items[0].amount;
    const finalPrice = Math.max(basePrice - discount, 0);

    if (discount > 0) {
      items = items.map(item => ({ ...item, amount: Math.max(item.amount - discount, 100) }));
    }

    // ── Pedido 100% gratuito (cupom cobre tudo) ───────────────────────────────
    if (finalPrice === 0) {
      const freeId = 'free_' + newId();
      const orderRecord = {
        id: newId(), pagarmeOrderId: freeId,
        status: 'paid', chargeStatus: 'paid',
        paymentMethod: payment.method,
        installments: 1,
        amountCents: basePrice,
        discountCents: discount, finalAmountCents: 0,
        customer: { name: customerData.name.trim(), email: customerData.email.trim().toLowerCase(), document: customerData.document.replace(/\D/g,''), phone: customerData.phone.replace(/\D/g,'') },
        offer:  offer ? { id: offer.id, slug: offer.slug, name: offer.name } : null,
        coupon: appliedCoupon ? { code: appliedCoupon.code, type: appliedCoupon.type, value: appliedCoupon.value } : null,
        leadId: leadId || null,
        createdAt: new Date().toISOString(),
      };
      if (appliedCoupon) {
        await supabase.from('coupons')
          .update({ used_count: (appliedCoupon.usedCount || 0) + 1, updated_at: new Date().toISOString() })
          .eq('id', appliedCoupon.id);
      }
      appendOrder(orderRecord).catch(e => console.error('[Orders]', e.message));
      console.log('[Free] Pedido gratuito via cupom:', freeId);
      return res.json({ orderId: freeId, status: 'paid', chargeStatus: 'paid', discount, free: true });
    }
    // ─────────────────────────────────────────────────────────────────────────

    const payments = buildPayment(payment, offer);
    const customer  = buildCustomer(customerData);

    // ── Modo simulação ────────────────────────────────────────────────────────
    const SIMULATE = process.env.SIMULATE_MODE === 'true';
    if (SIMULATE) {
      const fakeId     = 'sim_' + newId();
      const finalPrice = items[0].amount;
      const result = {
        orderId:      fakeId,
        status:       'paid',
        chargeStatus: payment.method === 'credit_card' ? 'paid' : 'pending',
        discount,
      };
      if (payment.method === 'pix') {
        result.qrCode    = '00020126580014br.gov.bcb.pix0136simulacao-pix-key@teste.com.br5204000053039865802BR5913MENTORIA TEST6009SAO PAULO62070503***6304ABCD';
        result.qrCodeUrl = await QRCode.toDataURL(result.qrCode, { width: 280, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
        result.expiresIn = 3600;
      }
      if (payment.method === 'boleto') {
        result.boletoUrl  = 'https://boleto.simulado/boleto.pdf';
        result.boletoPdf  = 'https://boleto.simulado/boleto.pdf';
        result.boletoLine = '34191.09008 63521.350947 61522.190001 7 00000000000100';
      }
      const orderRecord = {
        id: newId(), pagarmeOrderId: fakeId,
        status: result.status, chargeStatus: result.chargeStatus,
        paymentMethod: payment.method,
        installments: payment.method === 'credit_card' ? (parseInt(payment.installments, 10) || 1) : 1,
        amountCents: offer ? offer.price : (parseInt(process.env.PRODUCT_PRICE, 10) || 350000),
        discountCents: discount, finalAmountCents: finalPrice,
        customer: { name: customerData.name.trim(), email: customerData.email.trim().toLowerCase(), document: customerData.document.replace(/\D/g,''), phone: customerData.phone.replace(/\D/g,'') },
        offer:  offer ? { id: offer.id, slug: offer.slug, name: offer.name } : null,
        coupon: appliedCoupon ? { code: appliedCoupon.code, type: appliedCoupon.type, value: appliedCoupon.value } : null,
        pix:    payment.method === 'pix' ? { qrCode: result.qrCode, qrCodeUrl: result.qrCodeUrl, expiresIn: result.expiresIn } : null,
        simulated: true,
        leadId: leadId || null,
        meta:   capiMeta,
        createdAt: new Date().toISOString(),
      };
      appendOrder(orderRecord).catch(e => console.error('[Orders]', e.message));
      if (result.chargeStatus === 'paid') sendMetaPurchase(orderRecord).catch(() => {});
      console.log('[SIMULATE] Pedido simulado:', fakeId, payment.method);
      return res.json(result);
    }
    // ─────────────────────────────────────────────────────────────────────────

    const pagarmePayload = { items, customer, payments };
    console.log('[Pagar.me] Payload enviado:', JSON.stringify(pagarmePayload, null, 2));
    const { data: order } = await axios.post(
      `${PAGARME_URL}/orders`,
      pagarmePayload,
      { headers: pagarmeHeaders() }
    );

    // Increment coupon usage
    if (appliedCoupon) {
      await supabase.from('coupons')
        .update({ used_count: (appliedCoupon.usedCount || 0) + 1, updated_at: new Date().toISOString() })
        .eq('id', appliedCoupon.id);
    }

    const charge = order.charges?.[0];
    const tx     = charge?.last_transaction;

    // Cartão recusado: retorna erro com mensagem do banco
    if (payment.method === 'credit_card' && charge?.status === 'failed') {
      const acquirerMsg = tx?.acquirer_message || 'Pagamento recusado pelo banco emissor.';
      console.error('[Pagar.me] Cartão recusado:', acquirerMsg, '| code:', tx?.acquirer_return_code);
      // Salva o pedido como falhou no banco
      appendOrder({
        id: newId(), pagarmeOrderId: order.id,
        status: 'failed', chargeStatus: 'failed',
        paymentMethod: payment.method,
        installments: parseInt(payment.installments, 10) || 1,
        amountCents: offer ? offer.price : (parseInt(process.env.PRODUCT_PRICE, 10) || 350000),
        discountCents: discount, finalAmountCents: items[0].amount,
        customer: { name: customerData.name.trim(), email: customerData.email.trim().toLowerCase(), document: customerData.document.replace(/\D/g,''), phone: customerData.phone.replace(/\D/g,'') },
        offer: offer ? { id: offer.id, slug: offer.slug, name: offer.name } : null,
        coupon: appliedCoupon ? { code: appliedCoupon.code, type: appliedCoupon.type, value: appliedCoupon.value } : null,
        failureReason: acquirerMsg,
        leadId: leadId || null,
        createdAt: new Date().toISOString(),
      }).catch(e => console.error('[Orders]', e.message));
      return res.status(402).json({ error: acquirerMsg });
    }

    const result = {
      orderId:      order.id,
      status:       order.status,
      chargeStatus: charge?.status,
      discount,
    };

    if (payment.method === 'pix') {
      result.qrCode    = tx?.qr_code;
      result.expiresIn = offer ? (offer.pixExpiresIn || 3600) : (parseInt(process.env.PIX_EXPIRES_IN, 10) || 3600);
      result.qrCodeUrl = tx?.qr_code
        ? await QRCode.toDataURL(tx.qr_code, { width: 280, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
        : (tx?.qr_code_url || '');
    }
    const orderRecord = {
      id:               newId(),
      pagarmeOrderId:   order.id,
      status:           order.status,
      chargeStatus:     charge?.status || null,
      paymentMethod:    payment.method,
      installments:     payment.method === 'credit_card' ? (parseInt(payment.installments, 10) || 1) : 1,
      amountCents:      offer ? offer.price : (parseInt(process.env.PRODUCT_PRICE, 10) || 350000),
      discountCents:    discount,
      finalAmountCents: finalPrice,
      customer: {
        name:     customerData.name.trim(),
        email:    customerData.email.trim().toLowerCase(),
        document: customerData.document.replace(/\D/g, ''),
        phone:    customerData.phone.replace(/\D/g, ''),
      },
      offer:  offer ? { id: offer.id, slug: offer.slug, name: offer.name } : null,
      coupon: appliedCoupon ? { code: appliedCoupon.code, type: appliedCoupon.type, value: appliedCoupon.value } : null,
      pix:    payment.method === 'pix' ? { qrCode: result.qrCode, qrCodeUrl: result.qrCodeUrl, expiresIn: result.expiresIn } : null,
      leadId: leadId || null,
      meta:   capiMeta,
      createdAt: new Date().toISOString(),
    };
    appendOrder(orderRecord).catch(e => console.error('[Orders] Falha ao salvar:', e.message));

    // Meta CAPI: cartão aprovado dispara Purchase na hora (PIX dispara ao confirmar)
    if (charge?.status === 'paid') sendMetaPurchase(orderRecord).catch(() => {});

    notifyCustomerWA(customerData, result, payment.method).catch(e => console.error('[WA Cliente]', e.message));
    notifyAdminWA(customerData, result, payment.method, finalPrice, offer?.name).catch(e => console.error('[WA Admin]', e.message));

    res.json(result);
  } catch (err) {
    const pagarmeData   = err.response?.data;
    const pagarmeMsg    = pagarmeData?.message;
    const pagarmeErrors = pagarmeData?.errors;
    console.error('[Pagar.me] Status:', err.response?.status);
    console.error('[Pagar.me] Mensagem:', pagarmeMsg || err.message);
    if (pagarmeErrors) console.error('[Pagar.me] Erros:', JSON.stringify(pagarmeErrors, null, 2));
    if (pagarmeData)   console.error('[Pagar.me] Full response:', JSON.stringify(pagarmeData, null, 2));
    res.status(err.response?.status || 500).json({
      error:  pagarmeMsg || 'Erro ao processar pagamento. Tente novamente.',
      errors: pagarmeErrors || undefined,
    });
  }
});

// ─── Atualiza status do pedido no DB ─────────────────────────────────────────
async function markOrderPaid(pagarmeOrderId) {
  // Lê o pedido antes para disparar a CAPI só na transição para "pago" (evita duplicar)
  const { data: row } = await supabase.from('orders')
    .select('*').eq('pagarme_order_id', pagarmeOrderId).maybeSingle();
  if (!row) return;
  if (row.charge_status === 'paid') return; // já estava pago

  const { error } = await supabase.from('orders')
    .update({ status: 'paid', charge_status: 'paid' })
    .eq('pagarme_order_id', pagarmeOrderId);
  if (error) { console.error('[markOrderPaid]', error.message); return; }

  // Meta CAPI (PIX/boleto confirmados)
  sendMetaPurchase({
    pagarmeOrderId:   row.pagarme_order_id,
    finalAmountCents: row.final_amount_cents,
    customer:         row.customer,
    offer:            row.offer,
    meta:             row.meta || {},
  }).catch(() => {});
}

// ─── Status do pedido (polling PIX) ──────────────────────────────────────────
app.get('/api/order/:orderId/status', async (req, res) => {
  const { orderId } = req.params;
  try {
    const SIMULATE = process.env.SIMULATE_MODE === 'true';
    if (SIMULATE) {
      const orders = await getOrders();
      const record = orders.find(o => o.pagarme_order_id === orderId || o.id === orderId);
      if (!record) return res.status(404).json({ error: 'Pedido não encontrado' });

      // Já estava pago no DB
      if (record.charge_status === 'paid') {
        return res.json({ status: 'paid', chargeStatus: 'paid', paid: true });
      }

      // Simula aprovação após 15s
      const age  = Date.now() - new Date(record.created_at).getTime();
      const paid = age >= 15000;
      if (paid) await markOrderPaid(orderId);
      return res.json({ status: paid ? 'paid' : 'pending', chargeStatus: paid ? 'paid' : 'pending', paid });
    }

    const { data: order } = await axios.get(
      `${PAGARME_URL}/orders/${orderId}`,
      { headers: pagarmeHeaders() }
    );
    const charge       = order.charges?.[0];
    const chargeStatus = charge?.status || null;
    const paid         = chargeStatus === 'paid';
    if (paid) await markOrderPaid(orderId);
    return res.json({ status: order.status, chargeStatus, paid });
  } catch (err) {
    console.error('[Status]', err.message);
    res.status(500).json({ error: 'Erro ao consultar status' });
  }
});

// ─── Webhook Pagar.me (confirmação server-side) ───────────────────────────────
app.post('/api/webhook/pagarme', async (req, res) => {
  try {
    const event = req.body;
    const type  = event?.type || '';
    if (type === 'charge.paid' || type === 'order.paid') {
      const pagarmeOrderId = event?.data?.order?.id || event?.data?.id;
      if (pagarmeOrderId) {
        await markOrderPaid(pagarmeOrderId);
        console.log('[Webhook] Pagamento confirmado:', pagarmeOrderId);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook]', err.message);
    res.sendStatus(500);
  }
});

// ─── Lead capture ─────────────────────────────────────────────────────────────
app.post('/api/lead', async (req, res) => {
  try {
    const { name, email, phone, specialty, crm, instagram, offerSlug } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const { data, error } = await supabase.from('leads').insert({
      name:       name.trim(),
      email:      (email || '').trim().toLowerCase() || null,
      phone:      (phone || '').replace(/\D/g, '') || null,
      specialty:  specialty || null,
      crm:        crm || null,
      instagram:  instagram || null,
      offer_slug: offerSlug || null,
      status:     'lead',
    }).select().single();
    if (error) throw error;
    sendClintLead(data).catch(() => {}); // webhook Clint (captura do lead)
    res.json({ id: data.id });
  } catch (err) {
    console.error('[Lead]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Coupon validation ────────────────────────────────────────────────────────
app.post('/api/coupon/validate', async (req, res) => {
  try {
    const { code, offerSlug } = req.body;
    if (!code) return res.status(400).json({ error: 'Código inválido' });

    let offer = null;
    if (offerSlug) {
      const offers = await getOffers();
      offer = offers.find(o => o.slug === offerSlug && o.active !== false);
    }

    const coupons = await getCoupons();
    const coupon  = coupons.find(c =>
      c.code.toUpperCase() === code.toUpperCase() &&
      c.active !== false &&
      (c.maxUses == null || c.usedCount < c.maxUses) &&
      couponMatchesOffer(c, offer?.id)
    );

    if (!coupon) return res.status(404).json({ error: 'Cupom inválido ou expirado' });

    const basePrice = offer ? offer.price : (parseInt(process.env.PRODUCT_PRICE, 10) || 350000);
    const discount  = coupon.type === 'percent'
      ? Math.round(basePrice * coupon.value / 100)
      : Math.min(coupon.value, basePrice);

    res.json({
      valid:       true,
      code:        coupon.code,
      type:        coupon.type,
      value:       coupon.value,
      discount,
      finalPrice:  basePrice - discount,
      bannerTitle: coupon.bannerTitle || null,
      bannerText:  coupon.bannerText  || null,
    });
  } catch (err) {
    console.error('[Coupon]', err.message);
    res.status(500).json({ error: 'Erro ao validar cupom' });
  }
});

// ─── Admin API ────────────────────────────────────────────────────────────────
app.post('/admin/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const id = String(email || '').trim().toLowerCase();

    // Super-admin do env: usuário "admin" (configurável) OU e-mail em branco + senha do .env
    if ((id === ADMIN_USERNAME || id === '') && ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
      const payload = { userId: null, email: null, role: 'admin', name: 'Admin' };
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
      return res.json({ token, ...payload });
    }

    // Conta por e-mail (admin_users)
    if (id) {
      const { data: user } = await supabase.from('admin_users')
        .select('*').eq('email', id).maybeSingle();
      if (!user || user.active === false || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'E-mail ou senha incorretos' });
      }
      const payload = { userId: user.id, email: user.email, role: user.role || 'collaborator', name: user.name || '' };
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
      return res.json({ token, ...payload });
    }

    // Fallback legado (e-mail em branco + senha do env)
    if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
      const payload = { userId: null, email: null, role: 'admin', name: 'Admin' };
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
      return res.json({ token, ...payload });
    }

    res.status(401).json({ error: 'E-mail ou senha incorretos' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Identidade do usuário logado (para o front calcular propriedade/gating)
app.get('/admin/api/me', authAdmin, async (req, res) => {
  const permissions = await getEffectivePerms(req.user);
  res.json({ ...req.user, permissions });
});

// ─── Admin Users CRUD (somente admin) ─────────────────────────────────────────
app.get('/admin/api/users', authOnlyAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase.from('admin_users')
      .select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json((data || []).map(mapUser));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/users', authOnlyAdmin, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres' });
    const role = req.body.role === 'admin' ? 'admin' : 'collaborator';

    const { data, error } = await supabase.from('admin_users').insert({
      email,
      name:          req.body.name || '',
      role,
      password_hash: hashPassword(password),
      permissions:   role === 'admin' ? {} : normalizePerms(req.body.permissions),
      active:        req.body.active !== false,
    }).select().single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'E-mail já cadastrado' });
      throw error;
    }
    res.json(mapUser(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/admin/api/users/:id', authOnlyAdmin, async (req, res) => {
  try {
    const updates = { updated_at: new Date().toISOString() };
    if (req.body.name   !== undefined) updates.name   = req.body.name;
    if (req.body.role   !== undefined) updates.role   = req.body.role === 'admin' ? 'admin' : 'collaborator';
    if (req.body.active !== undefined) updates.active = req.body.active === true;
    if (req.body.permissions !== undefined) updates.permissions = normalizePerms(req.body.permissions);
    if (req.body.password) {
      if (req.body.password.length < 6) return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres' });
      updates.password_hash = hashPassword(req.body.password);
    }
    const { data, error } = await supabase.from('admin_users').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(mapUser(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/api/users/:id', authOnlyAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('admin_users').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Integrações (configurações globais) — somente admin ──────────────────────
app.get('/admin/api/settings', authOnlyAdmin, async (_req, res) => {
  try {
    const s = await getSettings();
    res.json({
      metaPixelId:     s.meta_pixel_id     || '',
      metaCapiToken:   s.meta_capi_token   || '',
      clintEnabled:    s.clint_enabled === true,
      clintWebhookUrl: s.clint_webhook_url || '',
      clintOrigin:     s.clint_origin      || '',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/admin/api/settings', authOnlyAdmin, async (req, res) => {
  try {
    const updates = { id: 'global', updated_at: new Date().toISOString() };
    if (req.body.metaPixelId     !== undefined) updates.meta_pixel_id     = (req.body.metaPixelId || '').trim();
    if (req.body.metaCapiToken   !== undefined) updates.meta_capi_token   = (req.body.metaCapiToken || '').trim();
    if (req.body.clintEnabled    !== undefined) updates.clint_enabled     = req.body.clintEnabled === true;
    if (req.body.clintWebhookUrl !== undefined) updates.clint_webhook_url = (req.body.clintWebhookUrl || '').trim();
    if (req.body.clintOrigin     !== undefined) updates.clint_origin      = (req.body.clintOrigin || '').trim();

    let { error } = await supabase.from('app_settings').upsert(updates, { onConflict: 'id' });
    // Resiliência: se uma coluna nova ainda não foi migrada, salva o resto
    if (error && /column|schema cache/i.test(error.message || '')) {
      const m = (error.message || '').match(/'([a-z_]+)' column/i);
      const col = m ? m[1] : null;
      if (col && col in updates) {
        console.warn(`[Settings] coluna "${col}" ausente — salvando sem ela. Rode a migração.`);
        delete updates[col];
        ({ error } = await supabase.from('app_settings').upsert(updates, { onConflict: 'id' }));
      }
    }
    if (error) throw error;
    invalidateSettings();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Envia um lead de exemplo para a URL informada (testar/conectar a Clint)
app.post('/admin/api/settings/test-clint', authOnlyAdmin, async (req, res) => {
  try {
    const url = (req.body.clintWebhookUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Informe uma URL de webhook válida' });
    const sample = buildClintPayload({
      name: 'Lead de Teste', email: 'teste@exemplo.com', phone: '11999999999',
      specialty: 'Cardiologia', crm: '123456', instagram: '@teste',
      offer_slug: 'teste', status: 'lead', created_at: new Date().toISOString(),
    }, (req.body.clintOrigin || '').trim(), 'Oferta de Teste');
    const r = await axios.post(url, sample, { timeout: 8000, headers: { 'Content-Type': 'application/json' }, validateStatus: () => true });
    res.json({ ok: r.status >= 200 && r.status < 300, status: r.status });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.code || err.message });
  }
});

// Offers CRUD
app.get("/admin/api/offers", authAdmin, async (_req, res) => {
  try { res.json(await getOffers()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/api/offers", authPerm('offers'), async (req, res) => {
  try {
    const slug = (req.body.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return res.status(400).json({ error: 'Slug inválido' });

    const { data, error } = await supabase.from('offers').insert({
      slug,
      created_by:          req.user.userId || null,
      name:                req.body.name                || 'Nova Oferta',
      description:         req.body.description         || '',
      price:               parseInt(req.body.price, 10) || 350000,
      statement_descriptor: (req.body.statementDescriptor || 'MENTORIA').slice(0, 13),
      max_installments:    parseInt(req.body.maxInstallments, 10)  || 12,
      no_interest_up_to:   parseInt(req.body.noInterestUpTo, 10)    || 12,
      interest_rate:       parseFloat(req.body.interestRate)        || 1.99,
      mentor_name:         req.body.mentorName          || '',
      whatsapp_contact:    req.body.whatsappContact     || '',
      pix_expires_in:      parseInt(req.body.pixExpiresIn, 10)     || 3600,
      boleto_due_days:     parseInt(req.body.boletoDueDays, 10)    || 3,
      show_instagram:       req.body.showInstagram === true,
      show_medical_fields:  req.body.showMedicalFields !== false,
      show_coupon:          req.body.showCoupon !== false,
      show_email:           req.body.showEmail !== false,
      show_phone:           req.body.showPhone !== false,
      guarantee_title:      req.body.guaranteeTitle  || '',
      guarantee_text:       req.body.guaranteeText   || '',
      guarantee_sub:        req.body.guaranteeSub    || '',
      thank_you_message:    req.body.thankYouMessage || '',
      pitch_enabled:        req.body.pitchEnabled === true,
      pitch_title:          req.body.pitchTitle      || '',
      pitch_copy:           req.body.pitchCopy       || '',
      pitch_cta:            req.body.pitchCta        || '',
      pitch_today_label:       req.body.pitchTodayLabel       ?? 'entrada',
      pitch_today_value:       req.body.pitchTodayValue       || '',
      pitch_today_badge:       req.body.pitchTodayBadge       || '',
      pitch_today_note:        req.body.pitchTodayNote        || '',
      pitch_installment_label: req.body.pitchInstallmentLabel ?? 'Depois, parcelado em',
      pitch_installment_value: req.body.pitchInstallmentValue || '',
      pitch_after_label:       req.body.pitchAfterLabel       ?? 'Após o evento',
      pitch_after_value:       req.body.pitchAfterValue       || '',
      pitch_savings:           req.body.pitchSavings          || '',
      pitch_total_value:       req.body.pitchTotalValue       || '',
      pitch_footnote:          req.body.pitchFootnote         || '',
      track_meta:          req.body.trackMeta === true,
      meta_content_id:     (req.body.metaContentId || '').trim(),
      active:              req.body.active !== false,
    }).select().single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Slug já existe' });
      throw error;
    }
    res.json(mapOffer(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/admin/api/offers/:id", authPerm('offers'), async (req, res) => {
  try {
    // Colaborador só edita os links que ele mesmo criou
    if (req.user.role === 'collaborator') {
      const { data: owner } = await supabase.from('offers').select('created_by').eq('id', req.params.id).maybeSingle();
      if (!owner) return res.status(404).json({ error: 'Oferta não encontrada' });
      if (owner.created_by !== req.user.userId) {
        return res.status(403).json({ error: 'Você só pode editar os links que criou' });
      }
    }
    const updates = {};
    if (req.body.name                !== undefined) updates.name                 = req.body.name;
    if (req.body.description         !== undefined) updates.description          = req.body.description;
    if (req.body.price               !== undefined) updates.price                = parseInt(req.body.price, 10);
    if (req.body.statementDescriptor !== undefined) updates.statement_descriptor = req.body.statementDescriptor.slice(0, 13);
    if (req.body.maxInstallments     !== undefined) updates.max_installments     = parseInt(req.body.maxInstallments, 10);
    if (req.body.noInterestUpTo      !== undefined) updates.no_interest_up_to    = parseInt(req.body.noInterestUpTo, 10);
    if (req.body.interestRate        !== undefined) updates.interest_rate        = parseFloat(req.body.interestRate);
    if (req.body.mentorName          !== undefined) updates.mentor_name          = req.body.mentorName;
    if (req.body.whatsappContact     !== undefined) updates.whatsapp_contact     = req.body.whatsappContact;
    if (req.body.pixExpiresIn        !== undefined) updates.pix_expires_in       = parseInt(req.body.pixExpiresIn, 10);
    if (req.body.boletoDueDays       !== undefined) updates.boleto_due_days      = parseInt(req.body.boletoDueDays, 10);
    if (req.body.showInstagram        !== undefined) updates.show_instagram        = req.body.showInstagram === true;
    if (req.body.showMedicalFields    !== undefined) updates.show_medical_fields   = req.body.showMedicalFields === true;
    if (req.body.showCoupon           !== undefined) updates.show_coupon           = req.body.showCoupon === true;
    if (req.body.showEmail            !== undefined) updates.show_email            = req.body.showEmail === true;
    if (req.body.showPhone            !== undefined) updates.show_phone            = req.body.showPhone === true;
    if (req.body.guaranteeTitle       !== undefined) updates.guarantee_title       = req.body.guaranteeTitle;
    if (req.body.guaranteeText        !== undefined) updates.guarantee_text        = req.body.guaranteeText;
    if (req.body.guaranteeSub         !== undefined) updates.guarantee_sub         = req.body.guaranteeSub;
    if (req.body.thankYouMessage      !== undefined) updates.thank_you_message     = req.body.thankYouMessage;
    if (req.body.pitchEnabled         !== undefined) updates.pitch_enabled         = req.body.pitchEnabled === true;
    if (req.body.pitchTitle           !== undefined) updates.pitch_title           = req.body.pitchTitle;
    if (req.body.pitchCopy            !== undefined) updates.pitch_copy            = req.body.pitchCopy;
    if (req.body.pitchCta             !== undefined) updates.pitch_cta             = req.body.pitchCta;
    if (req.body.pitchTodayLabel       !== undefined) updates.pitch_today_label       = req.body.pitchTodayLabel;
    if (req.body.pitchTodayValue       !== undefined) updates.pitch_today_value       = req.body.pitchTodayValue;
    if (req.body.pitchTodayBadge       !== undefined) updates.pitch_today_badge       = req.body.pitchTodayBadge;
    if (req.body.pitchTodayNote        !== undefined) updates.pitch_today_note        = req.body.pitchTodayNote;
    if (req.body.pitchInstallmentLabel !== undefined) updates.pitch_installment_label = req.body.pitchInstallmentLabel;
    if (req.body.pitchInstallmentValue !== undefined) updates.pitch_installment_value = req.body.pitchInstallmentValue;
    if (req.body.pitchAfterLabel       !== undefined) updates.pitch_after_label       = req.body.pitchAfterLabel;
    if (req.body.pitchAfterValue       !== undefined) updates.pitch_after_value       = req.body.pitchAfterValue;
    if (req.body.pitchSavings          !== undefined) updates.pitch_savings           = req.body.pitchSavings;
    if (req.body.pitchTotalValue       !== undefined) updates.pitch_total_value       = req.body.pitchTotalValue;
    if (req.body.pitchFootnote         !== undefined) updates.pitch_footnote          = req.body.pitchFootnote;
    if (req.body.trackMeta           !== undefined) updates.track_meta           = req.body.trackMeta === true;
    if (req.body.metaContentId       !== undefined) updates.meta_content_id      = (req.body.metaContentId || '').trim();
    if (req.body.active              !== undefined) updates.active               = req.body.active;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('offers').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Oferta não encontrada' });
    res.json(mapOffer(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/api/offers/:id', authOnlyAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('offers').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Coupons CRUD
app.get('/admin/api/coupons', authPerm('coupons'), async (_req, res) => {
  try { res.json(await getCoupons()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/coupons', authPerm('coupons'), async (req, res) => {
  try {
    const code = (req.body.code || '').toUpperCase().replace(/\s/g, '');
    if (!code) return res.status(400).json({ error: 'Código obrigatório' });

    const { data, error } = await supabase.from('coupons').insert({
      code,
      type:      req.body.type === 'fixed' ? 'fixed' : 'percent',
      value:     parseFloat(req.body.value) || 10,
      max_uses:  req.body.maxUses != null && req.body.maxUses !== '' ? parseInt(req.body.maxUses, 10) : null,
      used_count: 0,
      ...(() => { const ids = sanitizeOfferIds(req.body.offerIds, req.body.offerId);
                  return { offer_ids: ids, offer_id: ids.length === 1 ? ids[0] : null }; })(),
      banner_title: req.body.bannerTitle?.trim() || null,
      banner_text:  req.body.bannerText?.trim()  || null,
      active:       req.body.active !== false,
    }).select().single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Cupom já existe' });
      throw error;
    }
    res.json(mapCoupon(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/admin/api/coupons/:id', authPerm('coupons'), async (req, res) => {
  try {
    const updates = {};
    if (req.body.type    !== undefined) updates.type      = req.body.type;
    if (req.body.value   !== undefined) updates.value     = parseFloat(req.body.value);
    if (req.body.maxUses !== undefined) updates.max_uses  = req.body.maxUses === '' || req.body.maxUses == null ? null : parseInt(req.body.maxUses, 10);
    if (req.body.offerIds !== undefined || req.body.offerId !== undefined) {
      const ids = sanitizeOfferIds(req.body.offerIds, req.body.offerId);
      updates.offer_ids = ids;
      updates.offer_id  = ids.length === 1 ? ids[0] : null;
    }
    if (req.body.bannerTitle  !== undefined) updates.banner_title = req.body.bannerTitle?.trim() || null;
    if (req.body.bannerText   !== undefined) updates.banner_text  = req.body.bannerText?.trim()  || null;
    if (req.body.active       !== undefined) updates.active       = req.body.active;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('coupons').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Cupom não encontrado' });
    res.json(mapCoupon(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/api/coupons/:id', authPerm('coupons'), async (req, res) => {
  try {
    const { error } = await supabase.from('coupons').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard
app.get('/admin/api/dashboard', authPerm('dashboard'), async (req, res) => {
  try {
    const { data: orders } = await supabase.from('orders').select('*');
    const all = orders || [];

    const paid = all.filter(o => o.charge_status === 'paid' || o.status === 'paid');
    const revenue = paid.reduce((s, o) => s + (o.final_amount_cents || 0), 0);
    const doctors = all.filter(o => o.customer?.isDoctor);

    // Método de pagamento
    const methodMap = {};
    all.forEach(o => {
      const m = o.payment_method || 'desconhecido';
      methodMap[m] = (methodMap[m] || 0) + 1;
    });

    // Especialidades
    const specMap = {};
    doctors.forEach(o => {
      const s = (o.customer?.specialty || '').trim();
      if (s) specMap[s] = (specMap[s] || 0) + 1;
    });
    const specialties = Object.entries(specMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    res.json({
      total:       all.length,
      paid:        paid.length,
      revenue,
      avgTicket:   paid.length ? Math.round(revenue / paid.length) : 0,
      doctors:     doctors.length,
      methodMap,
      specialties,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync — verifica pedidos PIX pendentes no Pagar.me e atualiza
app.post('/admin/api/orders/sync', authOnlyAdmin, async (req, res) => {
  try {
    const { data: pending } = await supabase.from('orders')
      .select('id, pagarme_order_id, simulated')
      .eq('payment_method', 'pix')
      .neq('charge_status', 'paid');

    if (!pending?.length) return res.json({ updated: 0 });

    let updated = 0;
    for (const order of pending) {
      if (order.simulated) continue;
      try {
        const { data: pg } = await axios.get(
          `${PAGARME_URL}/orders/${order.pagarme_order_id}`,
          { headers: pagarmeHeaders() }
        );
        const chargeStatus = pg.charges?.[0]?.status;
        if (chargeStatus === 'paid') {
          await markOrderPaid(order.pagarme_order_id);
          updated++;
        }
      } catch (_) { /* ignora erros individuais */ }
    }

    res.json({ updated, total: pending.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Orders — somente leitura
app.get('/admin/api/orders', authPerm('orders'), async (req, res) => {
  try {
    const { method, status, q, from, to, offerSlug } = req.query;
    const all = await getOrders({ method, from, to });

    let filtered = all;
    if (status)    filtered = filtered.filter(o => o.status === status || o.charge_status === status);
    if (offerSlug) filtered = filtered.filter(o => (o.offer?.slug || '') === offerSlug);
    if (q) {
      const lq = q.toLowerCase();
      filtered = filtered.filter(o =>
        (o.customer?.name  || '').toLowerCase().includes(lq) ||
        (o.customer?.email || '').toLowerCase().includes(lq) ||
        (o.pagarme_order_id || '').toLowerCase().includes(lq)
      );
    }

    // Normalize field names for frontend compatibility
    // (colaborador vê os pedidos com valores, porém só leitura — sem editar/excluir)
    const orders = filtered.map(o => ({
      id:               o.id,
      pagarmeOrderId:   o.pagarme_order_id,
      status:           o.status,
      chargeStatus:     o.charge_status,
      paymentMethod:    o.payment_method,
      installments:     o.installments,
      amountCents:      o.amount_cents,
      discountCents:    o.discount_cents,
      finalAmountCents: o.final_amount_cents,
      customer:         o.customer,
      offer:            o.offer,
      coupon:           o.coupon,
      pix:              o.pix,
      boleto:           o.boleto,
      simulated:        o.simulated,
      failureReason:    o.failure_reason || null,
      createdAt:        o.created_at,
    }));

    res.json({ total: orders.length, filtered: orders.length, orders });
  } catch (err) {
    console.error('[Orders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin Leads (CRM) ────────────────────────────────────────────────────────
app.get('/admin/api/leads', authPerm('leads'), async (req, res) => {
  try {
    const { status, q, specialty, offer } = req.query;
    let query = supabase.from('leads')
      .select('*, orders(id, payment_method, final_amount_cents, installments, status, charge_status, created_at)')
      .order('created_at', { ascending: false });
    if (status)    query = query.eq('status', status);
    if (specialty) query = query.ilike('specialty', `%${specialty}%`);
    if (offer)     query = query.eq('offer_slug', offer);
    const { data, error } = await query;
    if (error) throw error;
    let leads = data || [];
    if (q) {
      const lq = q.toLowerCase();
      leads = leads.filter(l =>
        (l.name    || '').toLowerCase().includes(lq) ||
        (l.email   || '').toLowerCase().includes(lq) ||
        (l.phone   || '').includes(lq)
      );
    }
    // Resolve o nome amigável da oferta pelo slug (pra exibir/filtrar no CRM)
    const offers = await getOffers();
    const nameBySlug = {};
    offers.forEach(o => { nameBySlug[o.slug] = o.name; });
    leads = leads.map(l => ({ ...l, offer_name: l.offer_slug ? (nameBySlug[l.offer_slug] || l.offer_slug) : null }));

    res.json({ total: leads.length, leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/admin/api/leads/:id', authPerm('leads'), async (req, res) => {
  try {
    const { status, notes } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (status !== undefined) updates.status = status;
    if (notes  !== undefined) updates.notes  = notes;
    const { data, error } = await supabase.from('leads').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/api/leads/:id', authOnlyAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('leads').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/api/orders/:id', authOnlyAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('orders').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin panel SPA
app.get('/admin',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

// Dynamic checkout URL: /c/:slug → serve checkout with offer
app.get('/c/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── WhatsApp (Evolution API) ────────────────────────────────────────────────
function phone55(raw) {
  const d = raw.replace(/\D/g, '');
  return d.startsWith('55') ? d : `55${d}`;
}

function currencyBRL(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function evolutionBase() {
  return {
    baseUrl:  (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''),
    instance: process.env.EVOLUTION_INSTANCE,
    apiKey:   process.env.EVOLUTION_API_KEY,
  };
}

async function sendEvolution(rawPhone, message) {
  const { baseUrl, instance, apiKey } = evolutionBase();
  if (!baseUrl || !instance || !apiKey) {
    console.warn('[WA] Evolution API não configurada');
    return;
  }
  const url  = `${baseUrl}/message/sendText/${instance}`;
  const body = { number: phone55(rawPhone), text: message };
  console.log(`[WA] → POST ${url} | para: ${phone55(rawPhone)}`);
  const { data } = await axios.post(url, body, {
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    timeout: 40000,
  });
  console.log('[WA] ✓ Resposta:', JSON.stringify(data));
}

const METHOD_LABEL = {
  credit_card: 'Cartão de crédito',
  pix:         'PIX',
};

async function notifyCustomerWA(customerData, result, method) {
  if (!customerData.phone) return; // oferta não coleta telefone — sem WhatsApp de confirmação

  const firstName  = customerData.name.trim().split(' ')[0];
  const isPending  = method !== 'credit_card';
  const statusLine = isPending
    ? `⏳ Pedido registrado. Aguardando confirmação do pagamento (${METHOD_LABEL[method]}).`
    : `✅ *Pagamento aprovado!* Sua vaga está garantida.`;

  const msg = [
    `✦ *Elevate MedClub*`,
    ``,
    `Olá, *${firstName}*! 🎉`,
    ``,
    statusLine,
    ``,
    `*Seus próximos passos:*`,
    `1️⃣ Verifique seu e-mail — enviamos as instruções`,
    `2️⃣ Nossa equipe entrará em contato em até 24h`,
    `3️⃣ Você receberá o link para agendar sua 1ª sessão`,
    `4️⃣ Será adicionado(a) ao grupo VIP da turma`,
    ``,
    `Dúvidas? É só responder esta mensagem 💬`,
    ``,
    `_Equipe Elevate MedClub_ ✦`,
  ].join('\n');

  await sendEvolution(customerData.phone, msg);
}

async function notifyAdminWA(customerData, result, method, finalPrice, offerName) {
  const adminPhone = process.env.WHATSAPP_ADMIN;
  if (!adminPhone) return;

  const price = currencyBRL(finalPrice || parseInt(process.env.PRODUCT_PRICE, 10) || 350000);
  const now   = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const msg = [
    `🔔 *Nova venda — Elevate MedClub*`,
    ``,
    offerName ? `📦 *Oferta:* ${offerName}` : null,
    `👤 *Cliente:* ${customerData.name}`,
    customerData.email ? `📧 *E-mail:* ${customerData.email}` : null,
    customerData.phone ? `📱 *Telefone:* ${customerData.phone}` : null,
    `💰 *Valor:* ${price}`,
    `💳 *Método:* ${METHOD_LABEL[method] || method}`,
    `🗂 *Pedido:* ${result.orderId}`,
    `📅 *Data:* ${now}`,
  ].filter(Boolean).join('\n');

  await sendEvolution(adminPhone, msg);
}

// ─── Test WhatsApp ───────────────────────────────────────────────────────────
app.get('/api/test-wa', async (req, res) => {
  const phone = req.query.phone || process.env.WHATSAPP_ADMIN;
  const name  = req.query.name  || 'Visitante';
  if (!phone) return res.status(400).json({ error: 'Informe ?phone=11999999999 ou configure WHATSAPP_ADMIN no .env' });

  try {
    await sendEvolution(phone, `✅ *Teste Elevate MedClub*\n\nOlá, *${name}*! Se recebeu esta mensagem, a integração Evolution API está funcionando! 🎉\n\n_${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}_`);
    res.json({ sentTo: phone55(phone), name, result: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Checkout rodando em → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
