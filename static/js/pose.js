/* ============================================================
   GeniSport — pose.js
   On-device exercise tracking with MediaPipe Pose.
   100% client-side: video frames never leave the browser.

   Exposes a global `PushUpTracker`.
   ============================================================ */
"use strict";

const PushUpTracker = (() => {
  // ---------- Public tunables ----------
  const CONFIG = {
    UP_ANGLE: 145,        // Qo'l 145° yozilishi bilan UP deb oladi
    DOWN_ANGLE: 100,      // Qo'l 100° bukilishi bilan DOWN deb hisoblaydi
    MIN_VISIBILITY: 0.35, // Tana ko'rinishi
    MIN_REP_MS: 150,      // Reps oralig'i (tezkor)
  };
  // ---------- State machine ----------
  const Phase = Object.freeze({
    IDLE: "IDLE",
    UP: "UP",
    GOING_DOWN: "GOING_DOWN",
    DOWN: "DOWN",
    GOING_UP: "GOING_UP",
  });

  let pose = null;           // MediaPipe Pose instance
  let frameId = null;
  let generation = 0;
  let exercise = "push_ups";
  let aspect = 1;
  let pendingFrame = Promise.resolve();
  let overlayCanvas = null;  // canvas for the skeleton overlay
  let running = false;
  let countingEnabled = true; // false during the 3-2-1 countdown (reps frozen)

  let phase = Phase.IDLE;
  let reps = 0;
  let lastRepAt = 0;
  let lastAngle = null;      // previous frame elbow angle (trend detection)

  let latest = {
    reps: 0,
    phase: Phase.IDLE,
    angle: null,
    confidence: 0,
    poseOk: false,
    oriState: "NO_PERSON",
    counting: true,
  };

  let onFrameCb = null;      // callback(results, derived) per processed frame
  let onRepCb = null;        // callback(reps) when a rep completes

  // ---------- Geometry helpers ----------
  function angleDeg(a, b, c) {
    // Angle at point b, formed by segments b->a and b->c.
    const v1x = (a.x - b.x) * aspect, v1y = a.y - b.y;
    const v2x = (c.x - b.x) * aspect, v2y = c.y - b.y;
    const dot = v1x * v2x + v1y * v2y;
    const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (mag === 0) return null;
    const cos = Math.min(1, Math.max(-1, dot / mag));
    return (Math.acos(cos) * 180) / Math.PI;
  }

  function visibilityOf(lm) {
    return typeof lm.visibility === "number" ? lm.visibility : 1;
  }

  function orientationState(points) {
    const torso = [11, 12, 23, 24].map(i => points[i]);
    if (torso.some(p => !p)) return "NO_PERSON";
    const sides = [[11, 23], [12, 24]].filter(pair =>
      pair.every(i => visibilityOf(points[i]) >= CONFIG.MIN_VISIBILITY));
    if (!sides.length) return "LOW_VISIBILITY";
    const horizontal = sides.some(([s, h]) =>
      Math.abs(points[s].x - points[h].x) * aspect >
      Math.abs(points[s].y - points[h].y) * 1.1);
    return horizontal ? "PLANK" : "STANDING";
  }

  function isPushUpPose(points) {
    return orientationState(points) === "PLANK";
  }

  function measure(points) {
    const knees = exercise === "squats";
    const ids = knees ? [23, 25, 27] : [11, 13, 15];
    const orientation = orientationState(points);
    const expected = exercise === "push_ups" ? "PLANK" : "STANDING";
    let oriState = orientation;
    const angles = {};
    let confidence = 0, angle = null;
    for (const [side, offset] of [["left", 0], ["right", 1]]) {
      const joints = ids.map(i => points[i + offset]);
      if (joints.some(p => !p)) continue;
      const visibility = Math.min(...joints.map(visibilityOf));
      if (visibility < CONFIG.MIN_VISIBILITY) continue;
      if (exercise === "pull_ups" && joints[2].y >= joints[0].y) continue;
      const value = angleDeg(...joints);
      angles[side] = value;
      if (value !== null && visibility > confidence) {
        confidence = visibility;
        angle = value;
      }
    }
    if (orientation === expected && angle === null)
      oriState = exercise === "pull_ups" ? "OVERHEAD" : "LOW_VISIBILITY";
    return { angle, angles, confidence, oriState, poseOk: orientation === expected && angle !== null };
  }

  // ---------- State machine step ----------
  function stepMachine(angle, now) {
    let repCompleted = false;

    switch (phase) {
      case Phase.IDLE:
        if (angle >= CONFIG.UP_ANGLE) {
          phase = Phase.UP;
        }
        break;

      case Phase.UP:
        // Qo'l bukilishni boshlashi bilan DOWN tomonga o'tadi
        if (angle < CONFIG.UP_ANGLE - 5) {
          phase = angle <= CONFIG.DOWN_ANGLE ? Phase.DOWN : Phase.GOING_DOWN;
        }
        break;

      case Phase.GOING_DOWN:
        // Pastki nuqtaga yetti
        if (angle <= CONFIG.DOWN_ANGLE) {
          phase = Phase.DOWN;
        } else if (angle >= CONFIG.UP_ANGLE) {
          phase = Phase.UP; // harakat oxiriga yetmay qaytdi
        }
        break;

      case Phase.DOWN:
        if (angle <= CONFIG.DOWN_ANGLE + 5) break;
        phase = Phase.GOING_UP;
        // A low frame rate may skip intermediate angles on the return.
      case Phase.GOING_UP:
        // Qo'l yozildi -> REP SANALADI!
        if (angle >= CONFIG.UP_ANGLE) {
          if (now - lastRepAt >= CONFIG.MIN_REP_MS) {
            reps += 1;
            repCompleted = true;
            lastRepAt = now;
          }
          phase = Phase.UP;
        } else if (angle <= CONFIG.DOWN_ANGLE) {
          phase = Phase.DOWN; // qayta pastga tushib ketdi
        }
        break;
    }

    return repCompleted;
  }

  // ---------- Skeleton overlay rendering ----------
  // Minimal full-body connection set (MediaPipe landmark indices).
  const CONNECTIONS = [
    [11, 12], [11, 23], [12, 24], [23, 24],       // torso
    [11, 13], [13, 15], [12, 14], [14, 16],       // arms
    [23, 25], [25, 27], [27, 31],                 // left leg
    [24, 26], [26, 28], [28, 32],                 // right leg
  ];
  const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

  function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawAngleLabel(ctx, px, py, deg, color) {
    const text = `${Math.round(deg)}°`;
    ctx.font = "bold 15px 'Segoe UI', system-ui, sans-serif";
    const pad = 6;
    const w = ctx.measureText(text).width + pad * 2;
    const h = 24;
    const x = px + 14, y = py - 30;

    // Pill stays legible over both light and dark clothing.
    ctx.shadowColor = "rgba(0, 0, 0, .65)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = "rgba(10, 14, 20, .85)";
    roundedRect(ctx, x, y, w, h, 8);
    ctx.fill();

    // Outline stroke for extra separation on busy backgrounds.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 3;
    roundedRect(ctx, x, y, w, h, 8);
    ctx.stroke();

    // Drop-shadow around the glyphs themselves.
    ctx.shadowColor = "rgba(0, 0, 0, .8)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + pad, y + h / 2 + 0.5);

    // Reset shadows so nothing else picks them up.
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  function renderOverlay(results, info) {
    if (!overlayCanvas) return;
    const ctx = overlayCanvas.getContext("2d");
    const w = overlayCanvas.width, h = overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const lms = results && results.poseLandmarks;
    if (!lms) return;

    // Green while plank/counting, amber while the filter blocks.
    const color = info.poseOk ? "#22d3a5" : "#ffb454";

    // Bones
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.lineCap = "round";
    for (const [a, b] of CONNECTIONS) {
      const p = lms[a], q = lms[b];
      if (!p || !q) continue;
      if (visibilityOf(p) < 0.3 || visibilityOf(q) < 0.3) continue;
      ctx.beginPath();
      ctx.moveTo(p.x * w, p.y * h);
      ctx.lineTo(q.x * w, q.y * h);
      ctx.stroke();
    }

    // Joints
    ctx.shadowBlur = 4;
    ctx.fillStyle = color;
    for (const i of JOINTS) {
      const p = lms[i];
      if (!p || visibilityOf(p) < 0.3) continue;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Live elbow-angle labels (both sides when visible)
    ctx.shadowBlur = 0;
    const marks = [
      { elbow: lms[exercise === "squats" ? 25 : 13], deg: info.angles && info.angles.left },
      { elbow: lms[exercise === "squats" ? 26 : 14], deg: info.angles && info.angles.right },
    ];
    for (const m of marks) {
      if (m.elbow && typeof m.deg === "number" && visibilityOf(m.elbow) >= 0.3) {
        drawAngleLabel(ctx, m.elbow.x * w, m.elbow.y * h, m.deg, color);
      }
    }
  }

  // ---------- MediaPipe plumbing ----------
  function ensurePose() {
    if (pose) return;

    pose = new Pose({
      locateFile: (file) =>
        `/static/vendor/pose/${file}`,
    });

    pose.setOptions({
      modelComplexity: 0,        // lightweight model → best FPS in browser
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    pose.onResults((results) => {
      if (!running) return;
      const now = performance.now();
      let repCompleted = false;
      let derived;

      if (results.poseLandmarks && results.poseLandmarks.length >= 17) {
        const lms = results.poseLandmarks;
        const { angle, angles, confidence, oriState, poseOk } = measure(lms);

        if (countingEnabled && !poseOk) {
          // User turgan / yolg'iz qo'l silkitayapti — state machinani bloklaymiz.
          // Reps saqlanadi, lekin sanoq faqat gorizontal vaziyatda davom etadi.
          phase = Phase.IDLE;
        } else if (countingEnabled && angle !== null) {
          repCompleted = stepMachine(angle, now);
          lastAngle = angle;
        }
        // countingEnabled === false (countdown) → machine paused, phase unchanged.

        latest = { reps, phase, angle, confidence, poseOk, oriState, counting: countingEnabled };

        if (repCompleted && typeof onRepCb === "function") onRepCb(reps);
        derived = { angle, angles, confidence, phase, reps, lastAngle, poseOk, oriState, counting: countingEnabled };
        renderOverlay(results, derived);
      } else {
        phase = Phase.IDLE;
        // Nobody in frame — keep counters, report NO_PERSON so the UI can hint.
        latest = {
          ...latest,
          phase,
          angle: null,
          confidence: 0,
          poseOk: false,
          oriState: "NO_PERSON",
          counting: countingEnabled,
        };
        derived = { angle: null, angles: {}, confidence: 0, phase, reps, lastAngle: null, poseOk: false, oriState: "NO_PERSON", counting: countingEnabled };
        renderOverlay(results, derived);
      }

      if (typeof onFrameCb === "function") onFrameCb(results, derived);
    });
  }

  async function start(videoEl, canvas, deviceId, code = "push_ups") {
    if (running) return;
    const id = ++generation;
    exercise = code;
    ensurePose();
    try {
      await CameraManager.start(videoEl, deviceId);
      if (id !== generation) throw new Error("Session closed");
      aspect = videoEl.videoWidth && videoEl.videoHeight ? videoEl.videoWidth / videoEl.videoHeight : 1;
      overlayCanvas = canvas;
      if (canvas) {
        canvas.width = videoEl.videoWidth || 960;
        canvas.height = videoEl.videoHeight || 720;
      }
      resetSession();
      running = true;
      async function frame() {
        await pendingFrame;
        if (id !== generation) return;
        pendingFrame = pose.send({ image: videoEl });
        await pendingFrame;
        if (id === generation) frameId = requestAnimationFrame(() => frame().catch(err => {
          if (id !== generation) return;
          stop();
          window.dispatchEvent(new CustomEvent("tracking-error", { detail: err.message }));
        }));
      }
      await frame();
    } catch (err) {
      if (id === generation) stop();
      throw err;
    }
  }

  function stop() {
    generation++;
    running = false;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    pendingFrame = Promise.resolve(pendingFrame).catch(() => {});
    CameraManager.stop();
  }

  function resetSession() {
    phase = Phase.IDLE;
    reps = 0;
    lastRepAt = 0;
    lastAngle = null;
    latest = { reps: 0, phase: Phase.IDLE, angle: null, confidence: 0, poseOk: false, oriState: "NO_PERSON", counting: countingEnabled };
  }

  function getSession() {
    return {
      reps: latest.reps,
      phase: latest.phase,
      angle: latest.angle === null ? null : Math.round(latest.angle),
      confidence: Math.round(latest.confidence * 100),
      poseOk: latest.poseOk,
      oriState: latest.oriState,
      counting: latest.counting,
    };
  }

  return {
    CONFIG,
    Phase,
    isPushUpPose,      // exposed for tests / UI helpers
    orientationState,  // "NO_PERSON" | "LOW_VISIBILITY" | "STANDING" | "PLANK"
    setCountingEnabled: (v) => { countingEnabled = !!v; },
    isCountingEnabled: () => countingEnabled,
    start,
    stop,
    resetSession,
    getSession,
    isRunning: () => running,
    onFrame: (cb) => { onFrameCb = cb; },
    onRep: (cb) => { onRepCb = cb; },
  };
})();
