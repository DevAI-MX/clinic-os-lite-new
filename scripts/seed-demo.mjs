#!/usr/bin/env node
/**
 * Seed de demo para desarrollo local de clinicOS.
 *
 * Crea (idempotente):
 *   - Usuario demo (owner) + su cuenta → login del panel
 *   - Catálogo de procedimientos con anticipos y notas de venta
 *   - Horario semanal de la clínica
 *   - Contactos de ejemplo (leads y paciente) con conversaciones y mensajes
 *   - Citas de esta semana (confirmada, pendiente de anticipo) y un pago pendiente
 *
 * Uso:  node scripts/seed-demo.mjs   (lee .env.local)
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// --- env ------------------------------------------------------------
const envFile = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
const env = Object.fromEntries(
  envFile
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey || serviceKey.startsWith("TU-")) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY reales en .env.local");
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const DEMO_EMAIL = "covarrubiasmataemiliano@gmail.com";
const DEMO_PASSWORD = "clinicos123";
const DEMO_NAME = "Emiliano Covarrubias";

// --- helpers ---------------------------------------------------------
const log = (msg) => console.log(`  ✓ ${msg}`);

/** Próximo día hábil a la hora dada (hora local). offsetDays desplaza el punto de partida. */
function upcoming(hour, minute = 0, offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  if (offsetDays === 0 && (d.getHours() > hour || (d.getHours() === hour && d.getMinutes() >= minute))) {
    d.setDate(d.getDate() + 1); // hoy ya pasó esa hora → mañana
  }
  while (d.getDay() === 0) d.setDate(d.getDate() + 1); // nunca domingo
  d.setHours(hour, minute, 0, 0);
  return d;
}
const plusMinutes = (date, mins) => new Date(date.getTime() + mins * 60_000);

// --- 1. usuario + cuenta ----------------------------------------------
async function ensureUser() {
  const { data: list } = await db.auth.admin.listUsers({ perPage: 200 });
  let user = list?.users?.find((u) => u.email === DEMO_EMAIL);
  if (!user) {
    const { data, error } = await db.auth.admin.createUser({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: DEMO_NAME },
    });
    if (error) throw error;
    user = data.user;
    log(`Usuario creado: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  } else {
    log(`Usuario ya existe: ${DEMO_EMAIL}`);
  }

  // El trigger handle_new_user crea profile + account (rol owner).
  const { data: profile, error: pErr } = await db
    .from("profiles")
    .select("id, account_id")
    .eq("id", user.id)
    .single();
  if (pErr) throw pErr;

  await db
    .from("accounts")
    .update({ name: "Clínica Demo clinicOS" })
    .eq("id", profile.account_id);

  return { userId: user.id, accountId: profile.account_id };
}

// --- 2. catálogo -------------------------------------------------------
const PROCEDURES = [
  {
    name: "Valoración presencial",
    category: "valoracion",
    price_min: 500, price_max: 500,
    deposit_amount: 300,
    duration_minutes: 40,
    sales_notes:
      "Primera consulta con el doctor. El anticipo de $300 confirma la cita y se descuenta del costo. Reagendable con 24 h de anticipación.",
  },
  {
    name: "Valoración virtual",
    category: "valoracion",
    price_min: 800, price_max: 800,
    deposit_amount: 800,
    duration_minutes: 30,
    sales_notes:
      "Videollamada con el doctor para pacientes foráneos. Se paga completa por adelantado. Incluye plan tentativo de tratamiento.",
  },
  {
    name: "Rinoplastia",
    category: "procedimiento",
    price_min: 65000, price_max: 95000,
    deposit_amount: 8000,
    duration_minutes: 180,
    sales_notes:
      "Rango según complejidad; el precio exacto lo da el doctor en valoración. Manejo de objeción de precio: resaltar certificación, seguimiento post-operatorio de 12 meses incluido y MSI 3/6/12. El apartado de quirófano es de $8,000.",
  },
  {
    name: "Limpieza dental profunda",
    category: "dental",
    price_min: 1200, price_max: 1800,
    deposit_amount: null,
    duration_minutes: 60,
    sales_notes: "Sin anticipo. Gancho de entrada: ofrecer valoración sin costo junto con la limpieza.",
  },
];

async function seedCatalog(accountId) {
  for (const proc of PROCEDURES) {
    const { data: existing } = await db
      .from("procedures")
      .select("id")
      .eq("account_id", accountId)
      .eq("name", proc.name)
      .maybeSingle();
    if (existing) continue;
    const { error } = await db.from("procedures").insert({ ...proc, account_id: accountId });
    if (error) throw error;
  }
  log(`Catálogo: ${PROCEDURES.length} procedimientos`);

  // Horario: L-V 9:00–14:00 y 15:30–19:00, sábado 9:00–14:00.
  await db.from("clinic_hours").delete().eq("account_id", accountId);
  const hours = [];
  for (let wd = 1; wd <= 5; wd++) {
    hours.push({ account_id: accountId, weekday: wd, opens_at: "09:00", closes_at: "14:00", slot_minutes: 30 });
    hours.push({ account_id: accountId, weekday: wd, opens_at: "15:30", closes_at: "19:00", slot_minutes: 30 });
  }
  hours.push({ account_id: accountId, weekday: 6, opens_at: "09:00", closes_at: "14:00", slot_minutes: 30 });
  const { error: hErr } = await db.from("clinic_hours").insert(hours);
  if (hErr) throw hErr;
  log("Horario semanal configurado");
}

// --- 3. contactos + conversaciones --------------------------------------
const CONTACTS = [
  {
    phone: "+525512345678",
    name: "María López",
    kind: "lead",
    thread: [
      ["customer", "Hola, vi su anuncio en Facebook sobre rinoplastia. ¿Me pueden dar información?"],
      ["bot", "¡Hola María! Claro que sí, con gusto. La rinoplastia con el doctor va de $65,000 a $95,000 según el caso. ¿Te gustaría agendar una valoración presencial para que el doctor revise tu caso? Tiene un costo de $500 y el anticipo de $300 aparta tu lugar."],
      ["customer", "¿Y tienen algo este sábado?"],
    ],
  },
  {
    phone: "+525587654321",
    name: "Juan Pérez",
    kind: "paciente",
    thread: [
      ["customer", "Buenas tardes, ya hice la transferencia del anticipo, le mando el comprobante"],
      ["bot", "¡Perfecto Juan! Recibí tu comprobante y lo dejé en revisión con el equipo. En cuanto lo validen te confirmo tu cita por aquí mismo. ¿Te ayudo con algo más?"],
    ],
  },
  {
    phone: "+525599887766",
    name: "Ana Ramírez",
    kind: "lead",
    thread: [
      ["customer", "¿Cuánto cuesta la limpieza dental?"],
    ],
  },
];

async function seedContacts(accountId, userId) {
  const byPhone = {};
  for (const c of CONTACTS) {
    let { data: contact } = await db
      .from("contacts")
      .select("id")
      .eq("account_id", accountId)
      .eq("phone", c.phone)
      .maybeSingle();
    if (!contact) {
      const { data, error } = await db
        .from("contacts")
        .insert({ account_id: accountId, user_id: userId, phone: c.phone, name: c.name })
        .select("id")
        .single();
      if (error) throw error;
      contact = data;

      const lastText = c.thread[c.thread.length - 1][1];
      const { data: conv, error: cErr } = await db
        .from("conversations")
        .insert({
          account_id: accountId,
          user_id: userId,
          contact_id: contact.id,
          status: "open",
          last_message_text: lastText,
          last_message_at: new Date().toISOString(),
          unread_count: c.thread[c.thread.length - 1][0] === "customer" ? 1 : 0,
        })
        .select("id")
        .single();
      if (cErr) throw cErr;

      let t = Date.now() - c.thread.length * 8 * 60_000;
      for (const [sender, text] of c.thread) {
        const { error: mErr } = await db.from("messages").insert({
          conversation_id: conv.id,
          sender_type: sender,
          content_type: "text",
          content_text: text,
          status: sender === "customer" ? "read" : "delivered",
          created_at: new Date((t += 8 * 60_000)).toISOString(),
        });
        if (mErr) throw mErr;
      }
    }
    byPhone[c.phone] = contact.id;
  }
  log(`Contactos y conversaciones: ${CONTACTS.length}`);
  return byPhone;
}

// --- 4. citas + pagos ----------------------------------------------------
async function seedAppointments(accountId, contactsByPhone) {
  const { count } = await db
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if ((count ?? 0) > 0) {
    log("Citas ya existen — no se duplican");
    return;
  }

  const { data: valoracion } = await db
    .from("procedures")
    .select("id, deposit_amount, duration_minutes")
    .eq("account_id", accountId)
    .eq("name", "Valoración presencial")
    .single();

  // Juan: cita confirmada mañana (anticipo pagado).
  const juanStart = upcoming(16, 0, 1);
  const { data: apptJuan, error: e1 } = await db
    .from("appointments")
    .insert({
      account_id: accountId,
      contact_id: contactsByPhone["+525587654321"],
      procedure_id: valoracion.id,
      appointment_type: "valoracion",
      status: "confirmada",
      deposit_status: "pagado",
      deposit_amount: valoracion.deposit_amount,
      starts_at: juanStart.toISOString(),
      ends_at: plusMinutes(juanStart, valoracion.duration_minutes).toISOString(),
      notes: "Interesado en rinoplastia. Llega referido de campaña de Facebook.",
    })
    .select("id")
    .single();
  if (e1) throw e1;

  await db.from("payments").insert({
    account_id: accountId,
    contact_id: contactsByPhone["+525587654321"],
    appointment_id: apptJuan.id,
    amount: valoracion.deposit_amount,
    method: "transferencia",
    status: "confirmado",
    concept: "Anticipo valoración",
    confirmed_at: new Date().toISOString(),
  });

  // María: cita pendiente de anticipo el sábado.
  const mariaStart = upcoming(11, 0, 2);
  const { data: apptMaria, error: e2 } = await db
    .from("appointments")
    .insert({
      account_id: accountId,
      contact_id: contactsByPhone["+525512345678"],
      procedure_id: valoracion.id,
      appointment_type: "valoracion",
      status: "pendiente",
      deposit_status: "pendiente",
      deposit_amount: valoracion.deposit_amount,
      starts_at: mariaStart.toISOString(),
      ends_at: plusMinutes(mariaStart, valoracion.duration_minutes).toISOString(),
      notes: "Lead de Facebook. Espera confirmar con anticipo.",
    })
    .select("id")
    .single();
  if (e2) throw e2;

  await db.from("payments").insert({
    account_id: accountId,
    contact_id: contactsByPhone["+525512345678"],
    appointment_id: apptMaria.id,
    amount: valoracion.deposit_amount,
    method: "transferencia",
    status: "pendiente",
    concept: "Anticipo valoración (comprobante en revisión)",
  });

  log("Citas de la semana + pagos (1 confirmado, 1 pendiente)");
}

// --- main ---------------------------------------------------------------
console.log("Sembrando datos demo de clinicOS…");
const { userId, accountId } = await ensureUser();
await seedCatalog(accountId);
const contacts = await seedContacts(accountId, userId);
await seedAppointments(accountId, contacts);
console.log(`\nListo. Entra con ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
