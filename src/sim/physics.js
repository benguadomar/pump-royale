/**
 * Newtonian motion for ground troops, in tiles, seconds and "mass units" (1 per 100 base hp).
 *
 *   F = m·a      a troop's legs push with a bounded force, so its acceleration is
 *                DRIVE · m^-MASS_EXP: light units are nimble, heavy ones build up speed slowly.
 *   p = m·v      collisions exchange momentum through impulses (inverse-mass weighted), so a
 *                Giant shoves a Skeleton aside but a Skeleton barely moves a Giant.
 *   friction     μ·g decelerates anything that is not actively driving.
 *   impulse      every hit transfers J = damage · KNOCK_PER_DAMAGE along the blow; Δv = J / m.
 *                The troop is staggered for a moment proportional to Δv: its legs stop
 *                driving and only friction slows the slide.
 *
 * Integration is semi-implicit Euler on the fixed SIM_DT step, so it is deterministic.
 */
export const DRIVE = 12;
export const MASS_EXP = 0.45;
export const FRICTION = 6;
export const RESTITUTION = 0.2;
export const KNOCK_PER_DAMAGE = 0.02;
export const MAX_KNOCK_SPEED = 5;
/** Seconds of stagger per tile/s of knockback. */
export const STAGGER_PER_SPEED = 0.15;
/** Close enough to the goal to start braking: v_desired = min(top, distance / ARRIVE_TIME). */
const ARRIVE_TIME = 0.12;

/** Inertial mass from a card's base hitpoints (sturdier troops are heavier). */
export const massOf = (card) => Math.max(0.6, card.hp / 100);
/** Towers, buildings and troops still landing are immovable (infinite mass). */
export const invMass = (e) => (e.kind === 'troop' && !(e.deploy > 0) ? 1 / e.mass : 0);

/**
 * Applies the drive force toward a desired velocity (dvx, dvy), limited by |a| ≤ a_max.
 * With no goal the troop brakes with its legs plus ground friction.
 */
export function drive(e, dvx, dvy, dt) {
  if (e.stagger > 0) {
    e.stagger -= dt;
    dvx = 0;
    dvy = 0;
  }
  const idle = dvx === 0 && dvy === 0;
  const amax = e.stagger > 0 ? FRICTION : DRIVE * e.mass ** -MASS_EXP + (idle ? FRICTION : 0);
  let ax = (dvx - e.vx) / dt;
  let ay = (dvy - e.vy) / dt;
  const a = Math.hypot(ax, ay);
  if (a > amax) {
    ax *= amax / a;
    ay *= amax / a;
  }
  e.vx += ax * dt;
  e.vy += ay * dt;
}

/** Desired velocity toward (gx, gy) at `top` speed, easing in to arrive without overshoot. */
export function seek(e, gx, gy, top) {
  const dx = gx - e.x;
  const dy = gy - e.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return [0, 0];
  const s = Math.min(top, len / ARRIVE_TIME);
  return [(dx / len) * s, (dy / len) * s];
}

export function integrate(e, dt) {
  e.x += e.vx * dt;
  e.y += e.vy * dt;
}

/** Knockback: impulse J along (nx, ny); the change in velocity is J / m, capped. */
export function impulse(e, nx, ny, J) {
  const im = invMass(e);
  if (!im || e.air) return;
  const len = Math.hypot(nx, ny) || 1;
  let dv = J * im;
  if (dv > MAX_KNOCK_SPEED) dv = MAX_KNOCK_SPEED;
  e.vx += (nx / len) * dv;
  e.vy += (ny / len) * dv;
  e.stagger = Math.max(e.stagger ?? 0, dv * STAGGER_PER_SPEED);
}

/**
 * Resolves an overlap between two bodies: positional correction split by inverse mass,
 * then a restitution impulse along the contact normal if they are approaching.
 */
export function collide(a, b, min) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1e-3;
  if (d >= min) return;
  const ia = invMass(a);
  const ib = invMass(b);
  const sum = ia + ib;
  if (!sum) return;
  const nx = dx / d;
  const ny = dy / d;
  const push = min - d;
  a.x -= nx * push * (ia / sum);
  a.y -= ny * push * (ia / sum);
  b.x += nx * push * (ib / sum);
  b.y += ny * push * (ib / sum);
  const vrel = ((b.vx ?? 0) - (a.vx ?? 0)) * nx + ((b.vy ?? 0) - (a.vy ?? 0)) * ny;
  if (vrel >= 0) return;
  const j = (-(1 + RESTITUTION) * vrel) / sum;
  if (ia) {
    a.vx -= j * ia * nx;
    a.vy -= j * ia * ny;
  }
  if (ib) {
    b.vx += j * ib * nx;
    b.vy += j * ib * ny;
  }
}

/** Removes the velocity component pushing into a wall with outward normal (nx, ny). */
export function blockVelocity(e, nx, ny) {
  const vn = e.vx * nx + e.vy * ny;
  if (vn < 0) {
    e.vx -= vn * nx * (1 + RESTITUTION);
    e.vy -= vn * ny * (1 + RESTITUTION);
  }
}
