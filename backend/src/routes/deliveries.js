// NEXORA TRANSIT: parcel creation, atomic courier claim, server-validated
// state transitions, one-time handover codes, QR order references, disputes,
// and status history. Every transition is checked against the state machine
// and recorded; a modified client cannot skip steps.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { schemas, validate } from '../validation/schemas.js';
import {
  ok, created, asyncHandler, badRequest, forbidden, notFound, conflict,
  parsePagination, pageMeta, newPublicRef, newCode, encryptCode, decryptCode, codesEqual,
} from '../utils/helpers.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { deliveryLimiter } from '../middleware/rateLimit.js';
import {
  getDeliveryOr404, requireDeliveryAccess, audit,
} from '../services/authz.js';
import { canTransition, transitionNeedsCode, isTerminal } from '../services/deliveryMachine.js';

export const deliveriesRouter = Router();
deliveriesRouter.use(requireAuth);

function publicDelivery(d, viewerRole) {
  // Queue viewers (couriers browsing open orders) never see instructions.
  const out = { ...d };
  if (viewerRole === 'courier-viewer') { delete out.instructions; }
  return out;
}

async function recordTransition(client, delivery, to, actorId) {
  const q = (t, p) => client.query(t, p);
  await q(
    'UPDATE deliveries SET status = $1, updated_at = now() WHERE id = $2',
    [to, delivery.id],
  );
  await q(
    'INSERT INTO delivery_status_history (id, delivery_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, $4, $5)',
    [randomUUID(), delivery.id, delivery.status, to, actorId],
  );
  await audit(q, actorId, 'delivery.transition', 'delivery', delivery.id, { from: delivery.status, to });
}

async function createChallenges(client, deliveryId) {
  const expiresAt = new Date(Date.now() + config.codeTtlHours * 3600_000);
  for (const stage of ['pickup', 'dropoff']) {
    await client.query(
      `INSERT INTO verification_challenges (id, delivery_id, stage, code_encrypted, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), deliveryId, stage, encryptCode(newCode()), expiresAt],
    );
  }
  return expiresAt;
}

// POST /api/deliveries — create. By default publish=true puts it straight in
// the courier queue (original UX); publish=false leaves it CREATED.
deliveriesRouter.post('/', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.createDelivery, req.body);
  const delivery = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    const id = randomUUID();
    const { rows } = await q(
      `INSERT INTO deliveries (id, public_ref, sender_id, name, category, size, weight_kg,
         pickup_area, dropoff_area, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
         instructions, fee_offer, fragile, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'CREATED')
       RETURNING *`,
      [id, newPublicRef(), req.user.id, body.name, body.category, body.size, body.weightKg,
       body.pickupArea, body.dropoffArea, body.pickupLat ?? null, body.pickupLng ?? null,
       body.dropoffLat ?? null, body.dropoffLng ?? null, body.instructions, body.feeOffer, body.fragile],
    );
    const d = rows[0];
    await q('INSERT INTO delivery_participants (delivery_id, user_id, role) VALUES ($1, $2, \'sender\')',
      [id, req.user.id]);
    await q(
      'INSERT INTO delivery_status_history (id, delivery_id, from_status, to_status, actor_id) VALUES ($1, $2, NULL, \'CREATED\', $3)',
      [randomUUID(), id, req.user.id],
    );
    await createChallenges(client, id);
    if (body.publish) {
      await recordTransition(client, d, 'SEARCHING_FOR_COURIER', req.user.id);
      d.status = 'SEARCHING_FOR_COURIER';
    }
    await audit(q, req.user.id, 'delivery.created', 'delivery', id, {});
    return d;
  });
  res.status(201).json({ ok: true, data: delivery });
}));

// GET /api/deliveries — ?view=mine|queue, ?status=, paginated.
deliveriesRouter.get('/', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req);
  const view = req.query.view || 'mine';
  const status = req.query.status;
  let rows;
  if (view === 'queue') {
    const c = await query('SELECT 1 FROM courier_profiles WHERE user_id = $1', [req.user.id]);
    if (!c.rows.length && req.user.role !== 'admin') throw forbidden('Only couriers can browse the queue');
    const params = ['SEARCHING_FOR_COURIER'];
    let statusClause = '';
    if (status) { params.push(status); statusClause = 'AND status = $2'; }
    const r = await query(
      `SELECT * FROM deliveries WHERE status = $1 ${statusClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    rows = r.rows.map((d) => publicDelivery(d, 'courier-viewer'));
  } else {
    const params = [req.user.id];
    let statusClause = '';
    if (status) { params.push(status); statusClause = 'AND d.status = $2'; }
    const r = await query(
      `SELECT d.* FROM deliveries d JOIN delivery_participants p ON p.delivery_id = d.id
        WHERE p.user_id = $1 ${statusClause} ORDER BY d.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    rows = r.rows;
  }
  res.json({ ok: true, data: rows, meta: pageMeta(page, limit, rows.length) });
}));

deliveriesRouter.get('/:id', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  const { role } = await requireDeliveryAccess(d, req.user, { courierQueueView: true });
  res.json({ ok: true, data: publicDelivery(d, role) });
}));

deliveriesRouter.get('/:id/history', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  await requireDeliveryAccess(d, req.user, { courierQueueView: true });
  const { rows } = await query(
    `SELECT h.*, u.nexora_id AS actor_nexora_id FROM delivery_status_history h
       JOIN users u ON u.id = h.actor_id WHERE h.delivery_id = $1 ORDER BY h.seq`,
    [d.id],
  );
  res.json({ ok: true, data: rows });
}));

// POST /api/deliveries/:id/claim — ATOMIC: exactly one courier wins, even
// under concurrent claims (the WHERE clause is the lock; no client lock needed).
deliveriesRouter.post('/:id/claim', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  const c = await query('SELECT 1 FROM courier_profiles WHERE user_id = $1', [req.user.id]);
  if (!c.rows.length && req.user.role !== 'admin') throw forbidden('Only registered couriers can claim orders');
  if (d.sender_id === req.user.id) throw forbidden('You cannot courier your own order');
  const result = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    const claimed = await q(
      `UPDATE deliveries SET status = 'ASSIGNED', courier_id = $2, updated_at = now()
        WHERE id = $1 AND status = 'SEARCHING_FOR_COURIER' AND courier_id IS NULL
        RETURNING *`,
      [d.id, req.user.id],
    );
    if (!claimed.rows.length) return null;
    await q('INSERT INTO courier_assignments (id, delivery_id, courier_id) VALUES ($1, $2, $3)',
      [randomUUID(), d.id, req.user.id]);
    await q('INSERT INTO delivery_participants (delivery_id, user_id, role) VALUES ($1, $2, \'courier\') ON CONFLICT DO NOTHING',
      [d.id, req.user.id]);
    await q(
      'INSERT INTO delivery_status_history (id, delivery_id, from_status, to_status, actor_id) VALUES ($1, $2, \'SEARCHING_FOR_COURIER\', \'ASSIGNED\', $3)',
      [randomUUID(), d.id, req.user.id],
    );
    await audit(q, req.user.id, 'delivery.claimed', 'delivery', d.id, {});
    return claimed.rows[0];
  });
  if (!result) throw conflict('Order is no longer available to claim');
  req.app.get('io')?.to(`user:${d.sender_id}`).emit('delivery:update', { deliveryId: d.id, status: 'ASSIGNED' });
  res.json({ ok: true, data: result });
}));

// POST /api/deliveries/:id/step — courier advances the state machine.
// { to } must be a legal transition from the current state; code stages are
// handled by /verify, not here (a code is never accepted as a "step").
deliveriesRouter.post('/:id/step', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.transition, req.body);
  const d = await getDeliveryOr404(req.params.id);
  const { role } = await requireDeliveryAccess(d, req.user);
  const actorRole = role === 'courier' ? 'courier' : (req.user.role === 'admin' ? 'admin' : 'sender');
  if (!canTransition(d.status, body.to, actorRole)) {
    throw badRequest(`Cannot move from ${d.status} to ${body.to}`);
  }
  if (transitionNeedsCode(d.status, body.to)) {
    throw badRequest(`This step requires a verified handover code — use /verify first`);
  }
  await withTransaction(async (client) => recordTransition(client, d, body.to, req.user.id));
  req.app.get('io')?.to(`user:${d.sender_id}`).emit('delivery:update', { deliveryId: d.id, status: body.to });
  res.json({ ok: true, data: { status: body.to } });
}));

// POST /api/deliveries/:id/verify — courier submits a one-time handover code.
// Rate-limited per challenge, attempt-counted, expiring, single-use, and the
// code is never logged. Success advances the state machine in the same
// transaction as marking the challenge used (no replay window).
deliveriesRouter.post('/:id/verify', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.verifyCode, req.body);
  const d = await getDeliveryOr404(req.params.id);
  const { role } = await requireDeliveryAccess(d, req.user);
  if (role !== 'courier' && req.user.role !== 'admin') throw forbidden('Only the assigned courier can verify');
  const expectedTo = body.stage === 'pickup' ? 'PICKUP_VERIFIED' : 'DROPOFF_VERIFIED';
  if (!canTransition(d.status, expectedTo, 'courier')) {
    throw badRequest(`Cannot verify ${body.stage} from state ${d.status}`);
  }
  const out = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    // No SELECT ... FOR UPDATE: the claim on the challenge is the atomic
    // conditional UPDATE below, which is safe under concurrency in real
    // PostgreSQL and portable to the pg-mem test emulator.
    const ch = await q(
      'SELECT * FROM verification_challenges WHERE delivery_id = $1 AND stage = $2',
      [d.id, body.stage],
    );
    if (!ch.rows.length) throw notFound('Verification challenge not found');
    const challenge = ch.rows[0];
    if (challenge.used_at) throw badRequest('This code was already used', 'CODE_REUSED');
    if (new Date(challenge.expires_at) < new Date()) throw badRequest('This code has expired', 'CODE_EXPIRED');
    if (challenge.attempts >= challenge.max_attempts) throw badRequest('Too many attempts — code locked', 'CODE_LOCKED');
    const real = decryptCode(challenge.code_encrypted);
    if (!codesEqual(body.code, real)) {
      await q('UPDATE verification_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
      throw badRequest('Wrong code', 'CODE_WRONG');
    }
    // Atomic claim: only one concurrent verifier can flip used_at from NULL.
    const claimed = await q(
      'UPDATE verification_challenges SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id',
      [challenge.id],
    );
    if (!claimed.rows.length) throw badRequest('This code was already used', 'CODE_REUSED');
    await recordTransition(client, d, expectedTo, req.user.id);
    return { status: expectedTo };
  });
  req.app.get('io')?.to(`user:${d.sender_id}`).emit('delivery:update', { deliveryId: d.id, status: out.status });
  res.json({ ok: true, data: out });
}));

// GET /api/deliveries/:id/codes — sender only. The plaintext codes are the
// sender's secret to hand to the courier/recipient; they are decrypted here
// from server-side encrypted storage and never logged.
deliveriesRouter.get('/:id/codes', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  if (d.sender_id !== req.user.id && req.user.role !== 'admin') throw forbidden('Only the sender can view handover codes');
  const { rows } = await query(
    'SELECT stage, code_encrypted, expires_at, used_at, attempts, max_attempts FROM verification_challenges WHERE delivery_id = $1',
    [d.id],
  );
  const codes = {};
  for (const r of rows) {
    codes[r.stage] = {
      code: r.used_at ? null : decryptCode(r.code_encrypted),
      expiresAt: r.expires_at, used: !!r.used_at, attemptsLeft: Math.max(0, r.max_attempts - r.attempts),
    };
  }
  res.json({ ok: true, data: codes });
}));

// GET /api/deliveries/:id/qr — PNG QR encoding ONLY the public order reference.
// The QR alone never authorizes anything; verification still needs the code.
deliveriesRouter.get('/:id/qr', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  await requireDeliveryAccess(d, req.user, { courierQueueView: true });
  const png = await QRCode.toBuffer(d.public_ref, { type: 'png', margin: 1, width: 240 });
  res.type('png').send(png);
}));

// POST /api/deliveries/:id/cancel — sender (or admin) before pickup is verified.
deliveriesRouter.post('/:id/cancel', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  const { role } = await requireDeliveryAccess(d, req.user);
  const actorRole = req.user.role === 'admin' ? 'admin' : (role === 'sender' ? 'sender' : 'courier');
  if (!canTransition(d.status, 'CANCELLED', actorRole)) {
    throw badRequest(`Cannot cancel from state ${d.status}`);
  }
  await withTransaction(async (client) => recordTransition(client, d, 'CANCELLED', req.user.id));
  res.json({ ok: true, data: { status: 'CANCELLED' } });
}));

// POST /api/deliveries/:id/dispute — any participant, non-terminal states.
deliveriesRouter.post('/:id/dispute', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.dispute, req.body);
  const d = await getDeliveryOr404(req.params.id);
  await requireDeliveryAccess(d, req.user);
  if (isTerminal(d.status)) throw badRequest('Cannot dispute a finished delivery');
  await query('UPDATE deliveries SET disputed = TRUE, dispute_reason = $2 WHERE id = $1', [d.id, body.reason]);
  await audit(query, req.user.id, 'delivery.disputed', 'delivery', d.id, { reason: body.reason });
  res.json({ ok: true, data: { disputed: true } });
}));

deliveriesRouter.post('/:id/dispute/resolve', requireCsrf, asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') throw forbidden('Admin only');
  const d = await getDeliveryOr404(req.params.id);
  await query('UPDATE deliveries SET disputed = FALSE, dispute_reason = NULL WHERE id = $1', [d.id]);
  await audit(query, req.user.id, 'delivery.dispute_resolved', 'delivery', d.id, {});
  res.json({ ok: true, data: { disputed: false } });
}));

// GET /api/deliveries/:id/route — honest 503: no maps provider is configured,
// so no route, distance, or ETA is ever fabricated.
deliveriesRouter.get('/:id/route', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  await requireDeliveryAccess(d, req.user, { courierQueueView: true });
  if (!config.mapsProvider) {
    return res.status(503).json({
      ok: false,
      error: { code: 'MAPS_NOT_CONFIGURED', message: 'No maps/geocoding provider is configured. Set MAPS_PROVIDER to enable routes.' },
    });
  }
  return res.status(503).json({
    ok: false,
    error: { code: 'MAPS_NOT_IMPLEMENTED', message: `Maps provider "${config.mapsProvider}" is not implemented yet.` },
  });
}));

export default deliveriesRouter;
