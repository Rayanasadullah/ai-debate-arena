/* AI Debate Arena — cinematic reveal (GSAP) + holographic floor (Three.js). */
"use strict";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------- Entrance timeline ---------------- */

window.addEventListener("DOMContentLoaded", () => {
  if (reducedMotion || typeof gsap === "undefined") return;

  const REVEAL_TARGETS = [".title", ".subtitle", ".topic-bar", ".agent", ".stage-divider", ".transcript-wrap", ".mic-dock"];

  // Safety net: this whole intro hinges on the GSAP timeline below actually
  // finishing. If it stalls for any reason — a backgrounded/throttled tab
  // pausing requestAnimationFrame mid-animation, a CDN hiccup, any thrown
  // error — everything above was already set to opacity:0 and would stay
  // permanently invisible (and click-through-but-unseen) with no way to
  // recover. This forces full visibility after a fixed delay regardless of
  // what happened to the animation, so the page can never get stuck hidden.
  const forceReveal = () => gsap.set(REVEAL_TARGETS, { clearProps: "all" });
  const safetyTimer = setTimeout(forceReveal, 4000);

  try {
    gsap.set(REVEAL_TARGETS, { opacity: 0 });

    const tl = gsap.timeline({
      defaults: { ease: "power3.out" },
      onComplete: () => clearTimeout(safetyTimer),
    });

    tl.fromTo(".title", { y: -30, letterSpacing: "0.6em" }, { opacity: 1, y: 0, letterSpacing: "0.28em", duration: 1.1 })
      .to(".subtitle", { opacity: 1, duration: 0.6 }, "-=0.5")
      .fromTo(".agent-aria", { x: -60 }, { opacity: 1, x: 0, duration: 0.8 }, "-=0.3")
      .fromTo(".agent-rex", { x: 60 }, { opacity: 1, x: 0, duration: 0.8 }, "<")
      .fromTo(".stage-divider", { scale: 0 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(2)" }, "-=0.4")
      .fromTo(".topic-bar", { y: 16 }, { opacity: 1, y: 0, duration: 0.6 }, "-=0.3")
      .fromTo(".transcript-wrap", { y: 24 }, { opacity: 1, y: 0, duration: 0.6 }, "-=0.35")
      .to(".mic-dock", { opacity: 1, duration: 0.6 }, "-=0.3");
  } catch (err) {
    console.error("[animations] intro reveal threw, forcing visible instead:", err);
    forceReveal();
  }
});

/* Transcript lines slide in — called from app.js */
window.arenaFX = {
  lineIn(el) {
    if (reducedMotion || typeof gsap === "undefined") return;
    const fromLeft = el.classList.contains("line-aria");
    gsap.fromTo(
      el,
      { opacity: 0, x: el.classList.contains("line-rex") ? 30 : fromLeft ? -30 : 0, y: fromLeft ? 0 : 10 },
      { opacity: 1, x: 0, y: 0, duration: 0.5, ease: "power2.out" }
    );
  },
};

/* ---------------- Three.js holographic floor ---------------- */

(function initBackground() {
  if (reducedMotion || typeof THREE === "undefined") return;

  const canvas = document.getElementById("bg-canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // cap DPR — retina 4x fill kills fps

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x080c14, 0.045);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 2.2, 8);
  camera.lookAt(0, 0.5, 0);

  // Grid floor — the holographic arena ground
  const grid = new THREE.GridHelper(60, 60, 0x00a8ff, 0x0e2a44);
  grid.material.transparent = true;
  grid.material.opacity = 0.28;
  scene.add(grid);

  // Floating particles — blue on the left, red on the right
  const COUNT = 110;
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);
  const blue = new THREE.Color(0x00a8ff);
  const red = new THREE.Color(0xff2d55);

  for (let i = 0; i < COUNT; i++) {
    const x = (Math.random() - 0.5) * 30;
    positions[i * 3] = x;
    positions[i * 3 + 1] = Math.random() * 8;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 30;
    const c = x < 0 ? blue : red;
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const particles = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ size: 0.06, vertexColors: true, transparent: true, opacity: 0.65 })
  );
  scene.add(particles);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  const clock = new THREE.Clock();

  // Throttle to ~40fps and pause entirely when the tab is hidden — the
  // background never needs to burn the GPU when nobody is looking at it.
  let rafId = null;
  let running = true;
  const FRAME_MS = 25;
  let last = 0;

  function animate(now) {
    if (!running) return;
    rafId = requestAnimationFrame(animate);
    if (now - last < FRAME_MS) return;
    last = now;

    const t = clock.getElapsedTime();
    grid.position.z = (t * 0.6) % 1; // slow forward drift
    particles.rotation.y = t * 0.02;
    particles.position.y = Math.sin(t * 0.4) * 0.15;
    camera.position.x = Math.sin(t * 0.1) * 0.4;
    camera.lookAt(0, 0.6, 0);

    renderer.render(scene, camera);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
    } else if (!running) {
      running = true;
      last = 0;
      rafId = requestAnimationFrame(animate);
    }
  });

  rafId = requestAnimationFrame(animate);
})();
