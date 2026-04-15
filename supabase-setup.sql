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
  interest_rate        numeric default 1.99,
  mentor_name          text default '',
  whatsapp_contact     text default '',
  pix_expires_in       integer default 3600,
  boleto_due_days      integer default 3,
  show_instagram       boolean default false,
  guarantee_title      text default '',
  guarantee_text       text default '',
  guarantee_sub        text default '',
  active               boolean default true,
  created_at           timestamptz default now(),
  updated_at           timestamptz
);

-- Migração: adicionar show_instagram se tabela já existir
alter table offers add column if not exists show_instagram boolean default false;

-- Migração: adicionar campos de garantia
alter table offers add column if not exists guarantee_title text default '';
alter table offers add column if not exists guarantee_text  text default '';
alter table offers add column if not exists guarantee_sub   text default '';

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

-- Tabela de leads (CRM)
create table if not exists leads (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text not null,
  phone      text,
  specialty  text,
  crm        text,
  instagram  text,
  offer_slug text,
  order_id   uuid references orders(id) on delete set null,
  status     text default 'lead',
  notes      text,
  created_at timestamptz default now(),
  updated_at timestamptz
);

-- Desabilitar RLS (app server-side, acesso apenas pelo backend)
alter table offers  disable row level security;
alter table coupons disable row level security;
alter table orders  disable row level security;
alter table leads   disable row level security;

-- Migração: adicionar instagram se tabela já existir
alter table leads add column if not exists instagram text;
