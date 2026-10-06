/**
 * Box policy binding (design §17).
 *
 * The box runs the SAME pure policy engine (src/daemon/autonomy/policy.ts) and actuator gate chain
 * as the Mac; this module wires the box's roster + manifest + introspection into those generic
 * layers. No election protocol — ownership is just disjoint partitioning (manifest allows AND live
 * in roster). Kept as a thin binding so the policy stays single-sourced.
 */

export {}; // TODO(step 9): wire box inputs into the shared policy/actuator.
