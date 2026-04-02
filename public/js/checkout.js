/* ═══════════════════════════════════════════════════════════════
   CHECKOUT MENTORIA — Frontend Logic
   ═══════════════════════════════════════════════════════════════ */

// ─── State ───────────────────────────────────────────────────────
const state = {
  offerSlug:        null,
  couponCode:       null,
  discount:         0,
  config:           null,
  method:           'credit_card',
  pixCountdownTimer:null,
  pixPollTimer:     null,
  customerName:     '',
  lastOrderId:      '',
  leadId:           null,
  currentStep:      1,
};

// ─── DOM refs ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  // Summary
  mentorName:     $('mentor-name'),
  productName:    $('product-name'),
  priceDisplay:   $('price-display'),
  installDisplay: $('install-display'),
  pixPrice:       $('pix-price'),
  mobileProduct:  $('mobile-product') || $('mobile-brand'),
  mobilePrice:    $('mobile-price'),

  // Form — personal
  name:    $('f-name'),
  email:   $('f-email'),
  cpf:     $('f-cpf'),
  phone:   $('f-phone'),

  // Form — card
  cardNumber:  $('f-card-number'),
  cardName:    $('f-card-name'),
  cardExpiry:  $('f-card-expiry'),
  cardCvv:     $('f-card-cvv'),
  installments:$('f-installments'),

  // Card visual
  card3d:          $('card-3d'),
  cardNumberPrev:  $('card-number-preview'),
  cardHolderPrev:  $('card-holder-preview'),
  cardExpiryPrev:  $('card-expiry-preview'),
  cardCvvPrev:     $('card-cvv-preview'),
  cardBrandLogo:   $('card-brand-logo'),
  cardBackBrand:   $('card-back-brand'),

  // Submit
  btnSubmit:  $('btn-submit'),
  btnText:    document.querySelector('.btn-text'),
  btnSpinner: document.querySelector('.btn-spinner'),

  // Overlays
  overlayLoading: $('overlay-loading'),
  overlaySuccess: $('overlay-success'),
  overlayPix:     $('overlay-pix'),

  // PIX
  pixQrImg:      $('pix-qr-img'),
  pixCodeDisplay:$('pix-code-display'),
  btnCopyPix:    $('btn-copy-pix'),
  pixCountdown:  $('pix-countdown'),

  // Success
  successOrderId: $('success-order-id'),
};

// ─── Init ────────────────────────────────────────────────────────
(async function init() {
  document.body.classList.add('step-1');
  await loadConfig();
  setupMethodTabs();
  setupCardPreview();
  setupMasks();
  setupSubmit();
  setupCloseOverlayOnClick();
  setupCoupon();
  setupSteps();
})();

// ─── Config ──────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const pathParts = window.location.pathname.split('/');
    const isOfferPath = pathParts[1] === 'c' && pathParts[2];
    if (isOfferPath) state.offerSlug = pathParts[2];

    const url = state.offerSlug ? `/api/config?offer=${state.offerSlug}` : '/api/config';
    const res  = await fetch(url);
    const data = await res.json();
    state.config = data;
    applyConfig(data);
  } catch (e) {
    console.error('Erro ao carregar configuração:', e);
  }
}

function applyConfig(cfg) {
  const price   = cfg.productPrice;
  const maxInst = cfg.maxInstallments;

  if (el.mentorName)    el.mentorName.textContent    = cfg.mentorName;
  if (el.productName)   el.productName.textContent   = cfg.productName;
  if (el.mobileProduct) el.mobileProduct.textContent = `✦ ELEVATE MedClub`;

  const priceFormatted = formatCurrency(price);
  if (el.priceDisplay) el.priceDisplay.textContent = priceFormatted;
  if (el.mobilePrice)  el.mobilePrice.textContent  = priceFormatted;
  if (el.pixPrice)     el.pixPrice.textContent     = priceFormatted;

  // Installment hint on summary — usa o mesmo cálculo real do select
  updateInstallDisplay(price, maxInst, cfg.noInterestUpTo, cfg.interestRate);

  // Build select options (step-2, but safe even if hidden)
  buildInstallmentsSelect(price, maxInst, cfg.noInterestUpTo, cfg.interestRate);
}

function updateInstallDisplay(price, max, noInterestUpTo, interestRate) {
  if (!el.installDisplay) return;
  const rate = interestRate ?? 1.99;
  const { amount, hasInterest } = calcInstallment(price, max, noInterestUpTo, rate);
  const suffix = hasInterest ? `com juros` : `sem juros`;
  el.installDisplay.textContent = `ou ${max}× de ${formatCurrency(amount)} ${suffix}`;
}

function calcInstallment(price, n, noInterestUpTo, monthlyRate) {
  if (n <= noInterestUpTo || monthlyRate <= 0) {
    return { amount: Math.ceil(price / n), total: Math.ceil(price / n) * n, hasInterest: false };
  }
  // Juros compostos: PMT = PV * [r(1+r)^n] / [(1+r)^n - 1]
  const r    = monthlyRate / 100;
  const pmt  = Math.ceil(price * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
  return { amount: pmt, total: pmt * n, hasInterest: true };
}

function buildInstallmentsSelect(price, max, noInterestUpTo, monthlyRate) {
  if (!el.installments) return;
  el.installments.innerHTML = '';
  const rate = monthlyRate ?? 1.99;
  for (let i = 1; i <= max; i++) {
    const { amount, total, hasInterest } = calcInstallment(price, i, noInterestUpTo, rate);
    const label = hasInterest
      ? `${i}× de ${formatCurrency(amount)} (total ${formatCurrency(total)})`
      : `${i}× de ${formatCurrency(amount)} sem juros`;
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = label;
    el.installments.appendChild(opt);
  }
}

// ─── Method tabs ─────────────────────────────────────────────────
function setupMethodTabs() {
  document.querySelectorAll('.method-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const method = tab.dataset.method;
      state.method = method;

      document.querySelectorAll('.method-tab').forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });

      document.querySelectorAll('.method-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `panel-${method}`);
      });
    });
  });
}

// ─── Card preview ────────────────────────────────────────────────
function setupCardPreview() {
  el.cardNumber.addEventListener('input', () => {
    updateCardNumberPreview();
    detectBrand(el.cardNumber.value);
  });

  el.cardName.addEventListener('input', () => {
    const name = el.cardName.value.toUpperCase() || 'NOME DO TITULAR';
    el.cardHolderPrev.textContent = name.slice(0, 22);
  });

  el.cardExpiry.addEventListener('input', () => {
    const val = el.cardExpiry.value || 'MM/AA';
    el.cardExpiryPrev.textContent = val;
  });

  el.cardCvv.addEventListener('focus',  () => el.card3d.classList.add('flipped'));
  el.cardCvv.addEventListener('blur',   () => el.card3d.classList.remove('flipped'));

  el.cardCvv.addEventListener('input', () => {
    const dots = '•'.repeat(el.cardCvv.value.length) || '•••';
    el.cardCvvPrev.textContent = dots;
  });
}

function updateCardNumberPreview() {
  const raw  = el.cardNumber.value.replace(/\D/g, '').padEnd(16, '•');
  const fmt  = raw.match(/.{1,4}/g).join(' ');
  el.cardNumberPrev.textContent = fmt;
}

const BRANDS = [
  { name: 'Visa',       re: /^4/,              logo: 'VISA'  },
  { name: 'Mastercard', re: /^5[1-5]|^2[2-7]/, logo: 'MC'    },
  { name: 'Amex',       re: /^3[47]/,           logo: 'AMEX'  },
  { name: 'Elo',        re: /^4011|^431274|^438935|^451416|^457393|^4576|^457631|^457632|^504175|^627780|^636297|^636368|^6504|^6505|^6507|^6509|^6516|^6550/, logo: 'ELO' },
  { name: 'Hipercard',  re: /^6062/,            logo: 'HIPER' },
  { name: 'Discover',   re: /^6(?:011|5)/,      logo: 'DISC'  },
];

function detectBrand(number) {
  const clean = number.replace(/\D/g, '');
  const match = BRANDS.find((b) => b.re.test(clean));
  const logo  = match ? match.logo : '';
  el.cardBrandLogo.textContent = logo;
  if (el.cardBackBrand) el.cardBackBrand.textContent = logo;
}

// ─── Input masks ─────────────────────────────────────────────────
function setupMasks() {
  el.cardNumber.addEventListener('input', maskCardNumber);
  el.cardExpiry.addEventListener('input', maskExpiry);
  el.cardName.addEventListener('input',   () => {
    el.cardName.value = el.cardName.value.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ\s]/g, '');
  });
  el.cpf.addEventListener('input',   maskCPF);
  el.phone.addEventListener('input', maskPhone);
}

// Algoritmo de Luhn para validar número do cartão
function luhn(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function maskCardNumber(e) {
  let val = e.target.value.replace(/\D/g, '').slice(0, 16);
  e.target.value = val.match(/.{1,4}/g)?.join(' ') || val;
}

function maskExpiry(e) {
  let val = e.target.value.replace(/\D/g, '').slice(0, 4);
  if (val.length >= 3) val = val.slice(0, 2) + '/' + val.slice(2);
  e.target.value = val;
}

function maskCPF(e) {
  let val = e.target.value.replace(/\D/g, '').slice(0, 11);
  if (val.length > 9) val = val.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, '$1.$2.$3-$4');
  else if (val.length > 6) val = val.replace(/(\d{3})(\d{3})(\d{0,3})/, '$1.$2.$3');
  else if (val.length > 3) val = val.replace(/(\d{3})(\d{0,3})/, '$1.$2');
  e.target.value = val;
}

function maskPhone(e) {
  let val = e.target.value.replace(/\D/g, '').slice(0, 11);
  if (val.length > 10)     val = val.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  else if (val.length > 6) val = val.replace(/(\d{2})(\d{4,5})(\d{0,4})/, '($1) $2-$3');
  else if (val.length > 2) val = val.replace(/(\d{2})(\d{0,5})/, '($1) $2');
  e.target.value = val;
}

// ─── Validation ──────────────────────────────────────────────────
function validateCPF(cpf) {
  cpf = cpf.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i);
  let rest = 11 - (sum % 11);
  if (rest >= 10) rest = 0;
  if (rest !== parseInt(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i);
  rest = 11 - (sum % 11);
  if (rest >= 10) rest = 0;
  return rest === parseInt(cpf[10]);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function setError(input, message) {
  clearError(input);
  input.classList.add('error');
  const err = document.createElement('span');
  err.className = 'field-error';
  err.textContent = message;
  input.closest('.field-wrap').insertAdjacentElement('afterend', err);
}

function clearError(input) {
  input.classList.remove('error');
  const wrap = input.closest('.field-wrap');
  const next = wrap?.nextElementSibling;
  if (next?.classList.contains('field-error')) next.remove();
}

function clearAllErrors() {
  document.querySelectorAll('.field.error').forEach((f) => f.classList.remove('error'));
  document.querySelectorAll('.field-error').forEach((e) => e.remove());
}

function isFreeOrder() {
  const price    = state.config?.productPrice || 0;
  const discount = state.discount || 0;
  return price > 0 && discount >= price;
}

function validateForm() {
  clearAllErrors();
  let valid = true;

  // CPF (step 2)
  if (!validateCPF(el.cpf.value)) {
    setError(el.cpf, 'CPF inválido'); valid = false;
  }

  // Pedido gratuito: não valida cartão
  if (isFreeOrder()) return valid;

  // Card-specific
  if (state.method === 'credit_card') {
    const cardDigits = el.cardNumber.value.replace(/\D/g, '');
    if (cardDigits.length < 14 || !luhn(cardDigits)) {
      setError(el.cardNumber, 'Número do cartão inválido'); valid = false;
    }
    if (!el.cardName.value.trim() || el.cardName.value.trim().length < 3) {
      setError(el.cardName, 'Nome do titular inválido'); valid = false;
    }
    if (!/^\d{2}\/\d{2}$/.test(el.cardExpiry.value)) {
      setError(el.cardExpiry, 'Validade inválida'); valid = false;
    } else {
      const [mm, yy] = el.cardExpiry.value.split('/').map(Number);
      const now      = new Date();
      const expDate  = new Date(2000 + yy, mm - 1);
      if (mm < 1 || mm > 12 || expDate < now) {
        setError(el.cardExpiry, 'Cartão vencido'); valid = false;
      }
    }
    if (el.cardCvv.value.length < 3) {
      setError(el.cardCvv, 'CVV inválido'); valid = false;
    }
  }

  return valid;
}

// ─── 2-Step flow ─────────────────────────────────────────────────
function setupSteps() {
  document.getElementById('btn-step1')?.addEventListener('click', handleStep1);
  document.getElementById('btn-back-step1')?.addEventListener('click', goToStep1);
}

function goToStep1() {
  state.currentStep = 1;
  document.body.className = document.body.className.replace(/step-\d/g, '').trim() + ' step-1';
  document.getElementById('step-1').classList.remove('hidden');
  document.getElementById('step-2').classList.add('hidden');
  document.getElementById('form-title').textContent = 'Seus dados';
  document.getElementById('step-ind-1').classList.add('active');
  document.getElementById('step-ind-1').classList.remove('done');
  document.getElementById('step-ind-2').classList.remove('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goToStep2() {
  state.currentStep = 2;
  document.body.className = document.body.className.replace(/step-\d/g, '').trim() + ' step-2';
  document.getElementById('step-1').classList.add('hidden');
  document.getElementById('step-2').classList.remove('hidden');
  document.getElementById('form-title').textContent = 'Pagamento';
  document.getElementById('step-ind-1').classList.remove('active');
  document.getElementById('step-ind-1').classList.add('done');
  document.getElementById('step-ind-2').classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function handleStep1() {
  const nameEl      = document.getElementById('f-name');
  const emailEl     = document.getElementById('f-email');
  const phoneEl     = document.getElementById('f-phone');
  const specialtyEl = document.getElementById('f-specialty');
  const crmEl       = document.getElementById('f-crm');
  const btn         = document.getElementById('btn-step1');

  clearAllErrors();
  let valid = true;

  if (!nameEl.value.trim() || nameEl.value.trim().length < 3) {
    setError(nameEl, 'Informe seu nome completo'); valid = false;
  }
  if (!validateEmail(emailEl.value)) {
    setError(emailEl, 'E-mail inválido'); valid = false;
  }
  if (phoneEl.value.replace(/\D/g, '').length < 10) {
    setError(phoneEl, 'Telefone inválido'); valid = false;
  }
  if (!valid) return;

  // Save lead
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Salvando…';
  btn.querySelector('.btn-spinner')?.classList.remove('hidden');

  try {
    const res = await fetch('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:      nameEl.value.trim(),
        email:     emailEl.value.trim().toLowerCase(),
        phone:     phoneEl.value.trim(),
        specialty: specialtyEl?.value.trim() || '',
        crm:       crmEl?.value.trim() || '',
        offerSlug: state.offerSlug || null,
      }),
    });
    const data = await res.json();
    if (data.id) state.leadId = data.id;
  } catch (e) {
    console.warn('[Lead]', e.message);
  }

  btn.disabled = false;
  btn.querySelector('.btn-text').textContent = 'Continuar para pagamento';
  btn.querySelector('.btn-spinner')?.classList.add('hidden');

  goToStep2();
}

// ─── Coupon ──────────────────────────────────────────────────────
function setupCoupon() {
  const btnApply  = document.getElementById('btn-apply-coupon');
  const inputCode = document.getElementById('f-coupon');
  const resultEl  = document.getElementById('coupon-result');
  if (!btnApply || !inputCode) return;

  btnApply.addEventListener('click', async () => {
    const code = inputCode.value.trim().toUpperCase();
    if (!code) return;

    btnApply.disabled = true;
    btnApply.textContent = '...';
    resultEl.className = 'coupon-result hidden';

    try {
      const res  = await fetch('/api/coupon/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, offerSlug: state.offerSlug }),
      });
      const data = await res.json();

      if (!res.ok) {
        resultEl.className = 'coupon-result error';
        resultEl.textContent = data.error || 'Cupom inválido';
        state.couponCode = null;
        state.discount   = 0;
        resetPriceDisplay();
      } else {
        state.couponCode = data.code;
        state.discount   = data.discount;
        resultEl.className = 'coupon-result success';
        resultEl.textContent = `✓ Cupom aplicado! Desconto de ${formatCurrency(data.discount)}`;
        applyDiscountDisplay(data.finalPrice);
        toggleFreeOrderUI();
      }
    } catch (e) {
      resultEl.className = 'coupon-result error';
      resultEl.textContent = 'Erro ao validar cupom';
    } finally {
      btnApply.disabled = false;
      btnApply.textContent = 'Aplicar';
    }
  });
}

function applyDiscountDisplay(finalPrice) {
  const original = state.config?.productPrice || 0;
  const fmt      = formatCurrency(finalPrice);
  const fmtOrig  = formatCurrency(original);
  if (el.priceDisplay) el.priceDisplay.innerHTML = `<span class="price-original">${fmtOrig}</span> ${fmt}`;
  if (el.mobilePrice)  el.mobilePrice.innerHTML  = `<span class="price-original">${fmtOrig}</span> ${fmt}`;
  if (el.pixPrice)     el.pixPrice.textContent   = fmt;
  const max  = state.config?.maxInstallments || 12;
  const noInt = state.config?.noInterestUpTo || 12;
  const rate  = state.config?.interestRate;
  updateInstallDisplay(finalPrice, max, noInt, rate);
  buildInstallmentsSelect(finalPrice, max, noInt, rate);
}

function resetPriceDisplay() {
  if (state.config) applyConfig(state.config);
  toggleFreeOrderUI();
}

function toggleFreeOrderUI() {
  const free    = isFreeOrder();
  const banner  = document.getElementById('free-order-banner');
  const section = document.getElementById('payment-section');
  if (banner)  banner.classList.toggle('hidden', !free);
  if (section) section.classList.toggle('hidden', free);
}

// ─── Submit ──────────────────────────────────────────────────────
function setupSubmit() {
  el.btnSubmit.addEventListener('click', handleSubmit);
}

async function handleSubmit() {
  if (!validateForm()) return;

  // Get data from step 1 fields
  const nameVal  = document.getElementById('f-name')?.value.trim()  || '';
  const emailVal = document.getElementById('f-email')?.value.trim() || '';
  const phoneVal = document.getElementById('f-phone')?.value.trim() || '';
  state.customerName = nameVal;

  setLoading(true);

  const payload = {
    customer: {
      name:     nameVal,
      email:    emailVal,
      document: el.cpf.value,
      phone:    phoneVal,
    },
    payment: {
      method: state.method,
      ...(state.method === 'credit_card' && {
        card: {
          number:      el.cardNumber.value,
          holder_name: el.cardName.value,
          expiry:      el.cardExpiry.value,
          cvv:         el.cardCvv.value,
        },
        installments: el.installments.value,
      }),
    },
    ...(state.offerSlug  && { offerSlug:  state.offerSlug }),
    ...(state.couponCode && { couponCode: state.couponCode }),
    ...(state.leadId     && { leadId:     state.leadId }),
  };

  try {
    const res  = await fetch('/api/order', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();

    setLoading(false);

    if (!res.ok) {
      const rawMsg = (data.error || '').toLowerCase();
      let friendlyMsg = data.error || 'Erro ao processar. Tente novamente.';
      if (rawMsg.includes('inválido') || rawMsg.includes('invalid') || rawMsg.includes('1011')) {
        friendlyMsg = 'Cartão inválido. Verifique os dados e tente novamente.';
      } else if (rawMsg.includes('saldo') || rawMsg.includes('limit') || rawMsg.includes('insufici')) {
        friendlyMsg = 'Cartão sem limite suficiente. Tente outro cartão.';
      } else if (rawMsg.includes('recusad') || rawMsg.includes('denied') || rawMsg.includes('not_authorized')) {
        friendlyMsg = 'Pagamento recusado pelo banco. Tente outro cartão ou entre em contato com seu banco.';
      } else if (rawMsg.includes('bloqueado') || rawMsg.includes('blocked') || rawMsg.includes('restrict')) {
        friendlyMsg = 'Cartão bloqueado. Entre em contato com seu banco.';
      } else if (rawMsg.includes('timeout') || rawMsg.includes('time out')) {
        friendlyMsg = 'Tempo esgotado. Tente novamente.';
      }
      showAlert(friendlyMsg);
      return;
    }

    state.lastOrderId = data.orderId || '';

    if (state.method === 'credit_card') {
      // Cartão aprovado → redireciona direto para obrigado
      goToThankyou(data.orderId);
    } else if (state.method === 'pix') {
      showPIX(data);
    }
  } catch (e) {
    setLoading(false);
    showAlert('Erro de conexão. Verifique sua internet e tente novamente.');
    console.error(e);
  }
}

// ─── Loading ─────────────────────────────────────────────────────
function setLoading(on) {
  el.btnSubmit.disabled = on;
  el.btnText.classList.toggle('hidden', on);
  el.btnSpinner.classList.toggle('hidden', !on);
  el.overlayLoading.classList.toggle('hidden', !on);
}

// ─── Redirect → página de Obrigado ───────────────────────────────
function goToThankyou(orderId) {
  const priceRaw = state.config?.productPrice || 0;
  const discount = state.discount || 0;
  const finalCents = Math.max(priceRaw - discount, 0);
  const params = new URLSearchParams({
    name:   state.customerName,
    order:  orderId || '',
    method: state.method,
    wa:     state.config?.whatsappContact || '',
    value:  (finalCents / 100).toFixed(2),
  });
  window.location.href = `/obrigado?${params.toString()}`;
}

// ─── Success overlays ────────────────────────────────────────────
function showSuccess(orderId) {
  if (orderId) el.successOrderId.textContent = `Pedido: ${orderId}`;
  el.overlaySuccess.classList.remove('hidden');
}

function showPIX(data) {
  el.pixQrImg.src = data.qrCodeUrl || '';
  el.pixCodeDisplay.textContent = data.qrCode || '';

  const seconds = data.expiresIn || 3600;
  startPIXCountdown(seconds);
  startPIXPolling(data.orderId || state.lastOrderId);

  el.overlayPix.classList.remove('hidden');
}

function startPIXPolling(orderId) {
  if (state.pixPollTimer) clearInterval(state.pixPollTimer);
  if (!orderId) return;

  state.pixPollTimer = setInterval(async () => {
    try {
      const res  = await fetch(`/api/order/${orderId}/status`);
      const data = await res.json();
      if (data.paid) {
        clearInterval(state.pixPollTimer);
        if (state.pixCountdownTimer) clearInterval(state.pixCountdownTimer);

        // Mostra feedback visual antes de redirecionar
        el.overlayPix.querySelector('.overlay-box').innerHTML = `
          <div class="success-circle" style="margin:0 auto 16px">
            <svg viewBox="0 0 24 24" fill="none" stroke="#1F1F1F" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h3 style="margin-bottom:8px">Pagamento confirmado!</h3>
          <p style="color:var(--text-mid)">Redirecionando…</p>
        `;
        setTimeout(() => goToThankyou(orderId), 1500);
      }
    } catch (_) { /* mantém polling em erros de rede */ }
  }, 5000);
}

// ─── PIX countdown ───────────────────────────────────────────────
function startPIXCountdown(totalSeconds) {
  if (state.pixCountdownTimer) clearInterval(state.pixCountdownTimer);
  let remaining = totalSeconds;

  function tick() {
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    el.pixCountdown.textContent = `${m}:${s}`;
    if (remaining <= 0) {
      clearInterval(state.pixCountdownTimer);
      el.pixCountdown.textContent = 'expirado';
    }
    remaining--;
  }

  tick();
  state.pixCountdownTimer = setInterval(tick, 1000);
}

// ─── Copy buttons + redirect buttons ────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-copy-pix')?.addEventListener('click', () => {
    copyText(el.pixCodeDisplay.textContent, el.btnCopyPix);
  });

  // PIX: "Já paguei → próximos passos"
  document.getElementById('btn-pix-done')?.addEventListener('click', () => {
    if (state.pixCountdownTimer) clearInterval(state.pixCountdownTimer);
    if (state.pixPollTimer)      clearInterval(state.pixPollTimer);
    goToThankyou(state.lastOrderId);
  });

});

function copyText(text, btn) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copiado!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

// ─── Close overlay on background click ───────────────────────────
function setupCloseOverlayOnClick() {
  [el.overlaySuccess, el.overlayPix].forEach((overlay) => {
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
}

// ─── Alert ───────────────────────────────────────────────────────
function showAlert(message) {
  const existing = document.getElementById('checkout-alert');
  if (existing) existing.remove();

  const alert     = document.createElement('div');
  alert.id        = 'checkout-alert';
  alert.style.cssText = `
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    background: #DC2626; color: white;
    padding: 14px 24px; border-radius: 10px;
    font-size: 14px; font-weight: 500;
    box-shadow: 0 8px 32px rgba(220,38,38,0.35);
    z-index: 2000; max-width: 420px; width: 90%;
    text-align: center; line-height: 1.4;
    animation: slideDown 0.25s ease;
  `;
  alert.textContent = message;
  document.body.appendChild(alert);

  setTimeout(() => alert.remove(), 5000);
  alert.addEventListener('click', () => alert.remove());
}

// ─── Utils ───────────────────────────────────────────────────────
function formatCurrency(cents) {
  return new Intl.NumberFormat('pt-BR', {
    style:    'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

// Alert animation
const styleTag = document.createElement('style');
styleTag.textContent = `@keyframes slideDown { from { opacity:0; transform: translateX(-50%) translateY(-10px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }`;
document.head.appendChild(styleTag);
