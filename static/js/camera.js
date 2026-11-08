/* ============================================================
   GeniSport — camera.js
   Camera device enumeration & stream handling (client-side only).
   Exposes a global `CameraManager`.
   ============================================================ */
"use strict";

const CameraManager = (() => {
  let generation = 0;
  let stream = null;
  let currentDeviceId = null;

  /**
   * List available video input devices.
   * Note: browsers only expose device labels after the user granted
   * camera permission at least once — so we request a throwaway stream
   * first when needed.
   */
  async function listDevices() {
    if (!navigator.mediaDevices) return [];

    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "videoinput")
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${i + 1}`,
      }));
  }

  /**
   * Start streaming from a device into the given <video> element.
   * Falls back to the default camera when deviceId is empty.
   */
  async function start(videoEl, deviceId = "") {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser does not support camera access (getUserMedia).");
    }

    stop(); // release any previous stream first

    const id = generation;
    const constraints = {
      audio: false,
      video: deviceId
        ? {
            deviceId: { exact: deviceId },
            width: { ideal: 960 },
            height: { ideal: 720 },
          }
        : {
            width: { ideal: 960 },
            height: { ideal: 720 },
            facingMode: "user",
          },
    };

    const acquired = await navigator.mediaDevices.getUserMedia(constraints);
    if (id !== generation) {
      acquired.getTracks().forEach(track => track.stop());
      throw new Error("Session closed");
    }
    stream = acquired;
    currentDeviceId = deviceId || (stream.getVideoTracks()[0]?.getSettings().deviceId ?? null);

    videoEl.srcObject = stream;
    await videoEl.play();

    return stream;
  }

  /** Stop the active stream and release the camera. */
  function stop() {
    generation++;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    currentDeviceId = null;
  }

  function isRunning() {
    return !!stream;
  }

  function activeDeviceId() {
    return currentDeviceId;
  }

  return { listDevices, start, stop, isRunning, activeDeviceId };
})();
