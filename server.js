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
    guaranteeTitle:      row.guarantee_title || '',
    guaranteeText:       row.guarantee_text  || '',
    guaranteeSub:        row.guarantee_sub   || '',
    active:              row.active,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
  };
}

function mapCoupon(row) {
  if (!row) return null;
  return {
    id:        row.id,
    code:      row.code,
    type:      row.type,
    value:     row.value,
    maxUses:   row.max_uses,
    usedCount: row.used_count,
    offerId:   row.offer_id,
    active:    row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  const { error } = await supabase.from('orders').insert({
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
    created_at:         record.createdAt,
  });
  if (error) throw error;
  // Mark lead as converted
  if (record.leadId) {
    await supabase.from('leads')
      .update({ status: 'convertido', order_id: record.id, updated_at: new Date().toISOString() })
      .eq('id', record.leadId);
  }
}

function newId() { return crypto.randomUUID(); }

// ─── Admin Auth ───────────────────────────────────────────────────────────────
const JWT_SECRET            = process.env.ADMIN_JWT_SECRET       || 'elevate-jwt-secret-change-me';
const ADMIN_PASSWORD        = process.env.ADMIN_PASSWORD         || '';
const COLLABORATOR_PASSWORD = process.env.COLLABORATOR_PASSWORD  || '';

function getTokenRole(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try { return jwt.verify(token, JWT_SECRET).role || 'admin'; }
  catch { return null; }
}

function authAdmin(req, res, next) {
  const role = getTokenRole(req);
  if (!role) return res.status(401).json({ error: 'Não autorizado' });
  req.role = role;
  next();
}

function authOnlyAdmin(req, res, next) {
  const role = getTokenRole(req);
  if (role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  req.role = role;
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

function buildCustomer(data) {
  let phone = data.phone.replace(/\D/g, '');
  // Remove country code 55 se vier na frente (ex: 5511999999999 → 11999999999)
  if (phone.length >= 12 && phone.startsWith('55')) phone = phone.slice(2);
  return {
    name:          data.name.trim(),
    email:         data.email.trim().toLowerCase(),
    document:      data.document.replace(/\D/g, ''),
    document_type: 'CPF',
    type:          'individual',
    phones: {
      mobile_phone: {
        country_code: '55',
        area_code:    phone.slice(0, 2),
        number:       phone.slice(2),
      },
    },
  };
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
function validateCustomer(data) {
  if (!data?.name || data.name.trim().length < 3) return 'Nome inválido';
  if (!data?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return 'E-mail inválido';
  if (!data?.document || data.document.replace(/\D/g, '').length !== 11) return 'CPF inválido';
  if (!data?.phone || data.phone.replace(/\D/g, '').length < 10) return 'Telefone inválido';
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
      offerSlug:          slug || null,
    });
  } catch (err) {
    console.error('[Config]', err.message);
    res.status(500).json({ error: 'Erro ao carregar configurações' });
  }
});

app.post('/api/order', async (req, res) => {
  const { customer: customerData, payment, offerSlug, couponCode, leadId } = req.body;

  const customerError = validateCustomer(customerData);
  if (customerError) return res.status(400).json({ error: customerError });

  const paymentError = validatePayment(payment);
  if (paymentError) return res.status(400).json({ error: paymentError });

  try {
    // Resolve offer
    let offer = null;
    if (offerSlug) {
      const offers = await getOffers();
      offer = offers.find(o => o.slug === offerSlug && o.active !== false);
      if (!offer) return res.status(404).json({ error: 'Oferta não encontrada' });
    }

    // Resolve coupon
    let discount = 0;
    let appliedCoupon = null;
    if (couponCode) {
      const coupons = await getCoupons();
      const coupon  = coupons.find(c =>
        c.code.toUpperCase() === couponCode.toUpperCase() &&
        c.active !== false &&
        (c.maxUses == null || c.usedCount < c.maxUses) &&
        (c.offerId == null || c.offerId === offer?.id)
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
        createdAt: new Date().toISOString(),
      };
      appendOrder(orderRecord).catch(e => console.error('[Orders]', e.message));
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
      createdAt: new Date().toISOString(),
    };
    appendOrder(orderRecord).catch(e => console.error('[Orders] Falha ao salvar:', e.message));

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
  const { error } = await supabase.from('orders')
    .update({ status: 'paid', charge_status: 'paid' })
    .eq('pagarme_order_id', pagarmeOrderId);
  if (error) console.error('[markOrderPaid]', error.message);
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
    if (!name || !email) return res.status(400).json({ error: 'Nome e e-mail obrigatórios' });
    const { data, error } = await supabase.from('leads').insert({
      name:       name.trim(),
      email:      email.trim().toLowerCase(),
      phone:      (phone || '').replace(/\D/g, ''),
      specialty:  specialty || null,
      crm:        crm || null,
      instagram:  instagram || null,
      offer_slug: offerSlug || null,
      status:     'lead',
    }).select().single();
    if (error) throw error;
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
      (c.offerId == null || c.offerId === offer?.id)
    );

    if (!coupon) return res.status(404).json({ error: 'Cupom inválido ou expirado' });

    const basePrice = offer ? offer.price : (parseInt(process.env.PRODUCT_PRICE, 10) || 350000);
    const discount  = coupon.type === 'percent'
      ? Math.round(basePrice * coupon.value / 100)
      : Math.min(coupon.value, basePrice);

    res.json({
      valid: true,
      code:  coupon.code,
      type:  coupon.type,
      value: coupon.value,
      discount,
      finalPrice: basePrice - discount,
    });
  } catch (err) {
    console.error('[Coupon]', err.message);
    res.status(500).json({ error: 'Erro ao validar cupom' });
  }
});

// ─── Admin API ────────────────────────────────────────────────────────────────
app.post('/admin/api/login', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD não configurada no .env' });
  if (password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token, role: 'admin' });
  }
  if (COLLABORATOR_PASSWORD && password === COLLABORATOR_PASSWORD) {
    const token = jwt.sign({ role: 'collaborator' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token, role: 'collaborator' });
  }
  res.status(401).json({ error: 'Senha incorreta' });
});

// Offers CRUD
app.get("/admin/api/offers", authAdmin, async (_req, res) => {
  try { res.json(await getOffers()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/api/offers", authOnlyAdmin, async (req, res) => {
  try {
    const slug = (req.body.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return res.status(400).json({ error: 'Slug inválido' });

    const { data, error } = await supabase.from('offers').insert({
      slug,
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
      show_instagram:      req.body.showInstagram === true,
      guarantee_title:     req.body.guaranteeTitle  || '',
      guarantee_text:      req.body.guaranteeText   || '',
      guarantee_sub:       req.body.guaranteeSub    || '',
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

app.put("/admin/api/offers/:id", authOnlyAdmin, async (req, res) => {
  try {
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
    if (req.body.guaranteeTitle       !== undefined) updates.guarantee_title       = req.body.guaranteeTitle;
    if (req.body.guaranteeText        !== undefined) updates.guarantee_text        = req.body.guaranteeText;
    if (req.body.guaranteeSub         !== undefined) updates.guarantee_sub         = req.body.guaranteeSub;
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
app.get('/admin/api/coupons', authOnlyAdmin, async (_req, res) => {
  try { res.json(await getCoupons()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/coupons', authOnlyAdmin, async (req, res) => {
  try {
    const code = (req.body.code || '').toUpperCase().replace(/\s/g, '');
    if (!code) return res.status(400).json({ error: 'Código obrigatório' });

    const { data, error } = await supabase.from('coupons').insert({
      code,
      type:      req.body.type === 'fixed' ? 'fixed' : 'percent',
      value:     parseFloat(req.body.value) || 10,
      max_uses:  req.body.maxUses != null && req.body.maxUses !== '' ? parseInt(req.body.maxUses, 10) : null,
      used_count: 0,
      offer_id:  req.body.offerId || null,
      active:    req.body.active !== false,
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

app.put('/admin/api/coupons/:id', authOnlyAdmin, async (req, res) => {
  try {
    const updates = {};
    if (req.body.type    !== undefined) updates.type      = req.body.type;
    if (req.body.value   !== undefined) updates.value     = parseFloat(req.body.value);
    if (req.body.maxUses !== undefined) updates.max_uses  = req.body.maxUses === '' || req.body.maxUses == null ? null : parseInt(req.body.maxUses, 10);
    if (req.body.offerId !== undefined) updates.offer_id  = req.body.offerId || null;
    if (req.body.active  !== undefined) updates.active    = req.body.active;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('coupons').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Cupom não encontrado' });
    res.json(mapCoupon(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/api/coupons/:id', authOnlyAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('coupons').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard
app.get('/admin/api/dashboard', authOnlyAdmin, async (req, res) => {
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
app.get('/admin/api/orders', authAdmin, async (req, res) => {
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

    const isCollaborator = req.role === 'collaborator';

    // Normalize field names for frontend compatibility
    const orders = filtered.map(o => ({
      id:               o.id,
      pagarmeOrderId:   o.pagarme_order_id,
      status:           o.status,
      chargeStatus:     o.charge_status,
      paymentMethod:    o.payment_method,
      installments:     o.installments,
      amountCents:      isCollaborator ? null : o.amount_cents,
      discountCents:    isCollaborator ? null : o.discount_cents,
      finalAmountCents: isCollaborator ? null : o.final_amount_cents,
      customer:         o.customer,
      offer:            o.offer,
      coupon:           o.coupon,
      pix:              o.pix,
      boleto:           o.boleto,
      simulated:        o.simulated,
      createdAt:        o.created_at,
    }));

    res.json({ total: orders.length, filtered: orders.length, orders });
  } catch (err) {
    console.error('[Orders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin Leads (CRM) ────────────────────────────────────────────────────────
app.get('/admin/api/leads', authAdmin, async (req, res) => {
  try {
    const { status, q, specialty } = req.query;
    let query = supabase.from('leads')
      .select('*, orders(id, payment_method, final_amount_cents, installments, status, charge_status, created_at)')
      .order('created_at', { ascending: false });
    if (status)    query = query.eq('status', status);
    if (specialty) query = query.ilike('specialty', `%${specialty}%`);
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
    res.json({ total: leads.length, leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/admin/api/leads/:id', authAdmin, async (req, res) => {
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
    `📧 *E-mail:* ${customerData.email}`,
    `📱 *Telefone:* ${customerData.phone}`,
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
