-- ══════════════════════════════════════════════════════
-- Elevate MedClub — Supabase Schema
-- Cole este SQL no Editor SQL do painel Supabase e execute.
-- ══════════════════════════════════════════════════════

-- Tabela de ofertas
create table if not exists offers (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text unique not null,
  name                 text not null default 'Nova Oferta',
  description          text default '',
  price                integer not null default 350000,
  statement_descriptor text default 'MENTORIA',
  max_installments     integer default 12,
  no_interest_up_to    integer default 12,
  mentor_name          text default '',
  whatsapp_contact     text default '',
  pix_expires_in       integer default 3600,
  boleto_due_days      integer default 3,
  active               boolean default true,
  created_at           timestamptz default now(),
  updated_at           timestamptz
);

-- Tabela de cupons
create table if not exists coupons (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  type       text not null default 'percent',
  value      numeric not null default 10,
  max_uses   integer,
  used_count integer default 0,
  offer_id   uuid references offers(id) on delete set null,
  active     boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz
);

-- Tabela de pedidos
create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  pagarme_order_id   text,
  status             text,
  charge_status      text,
  payment_method     text,
  installments       integer default 1,
  amount_cents       integer,
  discount_cents     integer default 0,
  final_amount_cents integer,
  customer           jsonb,
  offer              jsonb,
  coupon             jsonb,
  pix                jsonb,
  boleto             jsonb,
  simulated          boolean default false,
  created_at         timestamptz default now()
);

-- Desabilitar RLS (app server-side, acesso apenas pelo backend)
alter table offers  disable row level security;
alter table coupons disable row level security;
alter table orders  disable row level security;
