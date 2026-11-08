/*
 * Unit tests for static/js/pose.js — orientation filter + push-up state machine.
 * Run: node tests/test_pose.cjs
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- Minimal browser stubs --------------------------------------------------
class FakePose {
  constructor() { FakePose.last = this; }
  setOptions() {}
  onResults(cb) { this._cb = cb; }
  send() {}
  close() {}
}
class FakeCamera {
  constructor() {}
  start() {}
  stop() {}
}
FakePose.last = null;

const sandbox = {
  console,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  performance: { now: () => Date.now() },
  Pose: FakePose,
  Camera: FakeCamera,
  CameraManager: {
    start: async () => {},
    stop: () => {},
    isRunning: () => false,
    listDevices: async () => [],
  },
  window: {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/js/pose.js"), "utf8"), sandbox);
// top-level `const PushUpTracker` lives in the context's lexical scope —
// surface it on the sandbox from a follow-up script in the same context.
vm.runInContext("globalThis.__PushUpTracker = PushUpTracker;", sandbox);

const Tracker = sandbox.__PushUpTracker;
if (!Tracker) throw new Error("PushUpTracker not defined — pose.js failed to load");

// ---- Landmark factory -------------------------------------------------------
// normalized coords (0..1). Plank: shoulders & hips at the same height.
function lm(x, y, vis = 0.9) { return { x, y, visibility: vis }; }

// Real MediaPipe results.poseLandmarks is a 33-element array — mimic that.
function makeLandmarks(map) {
  const arr = new Array(33).fill(null);
  for (const [idx, point] of Object.entries(map)) arr[Number(idx)] = point;
  return arr;
}

function plankLandmarks(elbowAngleDeg) {
  // Side view, user facing right. Shoulder & hip on one horizontal line.
  const shoulder = lm(0.4, 0.5);
  const hip = lm(0.6, 0.5); // same Y -> horizontal body
  // Place wrist so that shoulder-elbow-wrist angle == elbowAngleDeg.
  const rad = (elbowAngleDeg * Math.PI) / 180;
  const upper = 0.12, fore = 0.12; // arm segment lengths (normalized)
  const dx = upper - fore * Math.cos(rad);
  const dy = fore * Math.sin(rad);
  const wrist = lm(shoulder.x + dx, shoulder.y + dy);
  return makeLandmarks({
    11: shoulder, 12: shoulder,
    13: lm(shoulder.x + upper, shoulder.y + 0.02), 14: lm(shoulder.x + upper, shoulder.y + 0.02),
    15: wrist, 16: wrist,
    23: hip, 24: hip,
  });
}

function standingLandmarks() {
  const shoulder = lm(0.5, 0.3);
  const hip = lm(0.5, 0.68); // 0.38 vertical diff -> standing upright
  const elbow = lm(0.5, 0.42);
  const wrist = lm(0.5, 0.55); // arm waving below shoulder
  return makeLandmarks({
    11: shoulder, 12: shoulder,
    13: elbow, 14: elbow,
    15: wrist, 16: wrist,
    23: hip, 24: hip,
  });
}

// Results frame -> run through the onResults pipeline via Tracker.
function feedFrame(landmarks) {
  return new Promise((resolve) => {
    Tracker.onFrame((_res, derived) => resolve(derived));
    FakePose.last._cb({ poseLandmarks: landmarks });
  });
}

// ---- Tests ------------------------------------------------------------------
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok - ${name}`);
  else { failures++; console.error(`  FAIL - ${name}`, extra ?? ""); }
}

async function main() {
  // ensurePose() runs inside start(); stub video element satisfies the readiness check.
  const fakeVideo = { readyState: 2, addEventListener: () => {} };
  await Tracker.start(fakeVideo, null, "");

  console.log("== isPushUpPose orientation filter ==");
  check("plank landmarks pass the filter", Tracker.isPushUpPose(plankLandmarks(160)) === true);
  check("standing landmarks fail the filter", Tracker.isPushUpPose(standingLandmarks()) === false);

  console.log("== orientationState granularity ==");
  check("plank → PLANK", Tracker.orientationState(plankLandmarks(160)) === "PLANK");
  check("standing → STANDING", Tracker.orientationState(standingLandmarks()) === "STANDING");
  {
    const dim = makeLandmarks({ 11: lm(0.4, 0.5, 0.1), 12: lm(0.4, 0.5, 0.1), 23: lm(0.6, 0.5, 0.1), 24: lm(0.6, 0.5, 0.1) });
    check("dim landmarks → LOW_VISIBILITY", Tracker.orientationState(dim) === "LOW_VISIBILITY");
  }
  check("empty array → NO_PERSON", Tracker.orientationState(new Array(33).fill(null)) === "NO_PERSON");

  console.log("== no counting while standing ==");
  Tracker.resetSession();
  let derived = null;
  for (let i = 0; i < 30; i++) derived = await feedFrame(standingLandmarks());
  check("phase forced to IDLE while standing", derived.phase === "IDLE", derived.phase);
  check("reps == 0 while standing/waving arms", derived.reps === 0, derived.reps);
  check("poseOk === false while standing (hint signal)", derived.poseOk === false, derived.poseOk);

  console.log("== reps count in plank position ==");
  Tracker.resetSession();
  // One full rep: UP (170) -> DOWN (80) -> UP (170)
  await feedFrame(plankLandmarks(170));
  await feedFrame(plankLandmarks(120));
  derived = await feedFrame(plankLandmarks(80));
  check("reaches DOWN phase", derived.phase === "DOWN", derived.phase);
  check("poseOk === true in plank (hint hidden)", derived.poseOk === true, derived.poseOk);
  derived = await feedFrame(plankLandmarks(120));
  derived = await feedFrame(plankLandmarks(170));
  check("rep counted on return to UP", derived.reps === 1, derived.reps);

  console.log("== standing in the middle of a rep resets machine (no rep) ==");
  Tracker.resetSession();
  await feedFrame(plankLandmarks(170));
  await feedFrame(plankLandmarks(100)); // descend
  await feedFrame(standingLandmarks()); // user stands up mid-rep
  derived = await feedFrame(plankLandmarks(170)); // extends arm while standing-ish transition
  check("no rep counted after orientation break", derived.reps === 0, derived.reps);

  console.log("== counting gate (3-2-1 countdown) ==");
  Tracker.resetSession();
  Tracker.setCountingEnabled(false);
  // Full push-up motion while counting is disabled — nothing may be counted.
  await feedFrame(plankLandmarks(170));
  await feedFrame(plankLandmarks(120));
  await feedFrame(plankLandmarks(80));
  derived = await feedFrame(plankLandmarks(120));
  derived = await feedFrame(plankLandmarks(170));
  check("no reps while counting disabled", derived.reps === 0, derived.reps);
  check("gate flag exposed as counting=false", derived.counting === false, derived.counting);

  Tracker.setCountingEnabled(true);
  await feedFrame(plankLandmarks(170));
  await feedFrame(plankLandmarks(120));
  await feedFrame(plankLandmarks(80));
  await feedFrame(plankLandmarks(120));
  derived = await feedFrame(plankLandmarks(170));
  check("reps count after gate re-opens", derived.reps === 1, derived.reps);
  check("gate flag exposed as counting=true", derived.counting === true, derived.counting);

  for (const exercise of ["squats", "pull_ups"]) {
    Tracker.stop();
    await Tracker.start(fakeVideo, null, "", exercise);
    const make = deg => {
      const points = standingLandmarks();
      for (const side of [0, 1]) {
        const indices = exercise === "squats" ? [23,25,27] : [11,13,15];
        const knee = exercise === "squats";
        const y = knee ? 0.7 : 0.22;
        const direction = knee ? 1 : -1;
        points[indices[0]+side] = lm(.5,y-direction*.12);
        points[indices[1]+side] = lm(.5,y);
        points[indices[2]+side] = lm(.5+.12*Math.sin(deg*Math.PI/180),y-direction*.12*Math.cos(deg*Math.PI/180));
      }
      return points;
    };
    for (const deg of [170,120,85,120,170]) derived = await feedFrame(make(deg));
    check(exercise + " counts one complete cycle", derived.reps === 1);
    for (const deg of [170,125,118,125,170]) derived = await feedFrame(make(deg));
    check(exercise + " rejects partial cycle", derived.reps === 1);
  }
  if (failures > 0) { console.error(`\n${failures} test(s) FAILED`); process.exit(1); }
  console.log("\nALL POSE TESTS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
