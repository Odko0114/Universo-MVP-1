// Realistic 3D Earth for the Universo cinematic hero. Bundled (esbuild) into a
// single self-hosted file that exposes window.UniversoEarth. Three.js is ESM.
import * as THREE from "three";

export function initEarth(canvas, opts = {}) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08; // filmic, restrained — no blown highlights

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  camera.position.set(0, 0, 4.2); // far enough that the whole sphere floats in view

  // ---- Earth ----
  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const map = loader.load(opts.map || "/img/earth.jpg");
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAniso;
  // Night-side city lights — glow warmly, the "cities lit up" look, and lift the
  // whole planet out of dullness.
  const nightMap = loader.load("/img/earth-lights.png");
  nightMap.colorSpace = THREE.SRGBColorSpace;
  nightMap.anisotropy = maxAniso;

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 128, 128),
    new THREE.MeshStandardMaterial({
      map,
      emissive: 0xffca7a,
      emissiveMap: nightMap,
      emissiveIntensity: 0.72, // warm city lights, subtle — not a tech demo
      metalness: 0.0,
      roughness: 0.92, // matte land/ocean, no plastic ocean shine
    }),
  );
  // Rotate so Europe/Africa faces the viewer, and tilt like the real Earth.
  earth.rotation.y = opts.startRotation != null ? opts.startRotation : 0.35;
  earth.rotation.z = -0.22;
  scene.add(earth);

  // European university points — glowing dots on the surface, added as children
  // of the earth so they rotate WITH the map. Hidden until the flight nears
  // Europe (opacity driven by flyTo). Positions use the standard three.js
  // lat/lon→vector mapping that aligns with the earth_atmos texture.
  const CITIES = [
    [60.17, 24.94], [59.33, 18.07], [59.91, 10.75], [55.68, 12.57],
    [52.52, 13.4], [52.37, 4.9], [51.51, -0.13], [52.23, 21.01],
    [48.86, 2.35], [48.14, 11.58], [48.21, 16.37], [50.09, 14.42],
    [47.5, 19.04], [47.37, 8.54], [45.46, 9.19], [44.43, 26.1],
    [44.79, 20.45], [40.42, -3.7], [41.9, 12.5], [41.39, 2.16],
    [38.72, -9.14], [37.98, 23.73], [53.35, -6.26], [50.85, 4.35],
  ];
  const ptGeo = new THREE.BufferGeometry();
  const ppos = new Float32Array(CITIES.length * 3);
  CITIES.forEach(([lat, lon], i) => {
    const phi = ((90 - lat) * Math.PI) / 180;
    const theta = ((lon + 180) * Math.PI) / 180;
    const R = 1.013;
    ppos[i * 3] = -R * Math.sin(phi) * Math.cos(theta);
    ppos[i * 3 + 1] = R * Math.cos(phi);
    ppos[i * 3 + 2] = R * Math.sin(phi) * Math.sin(theta);
  });
  ptGeo.setAttribute("position", new THREE.BufferAttribute(ppos, 3));
  // Premium marker sprite — a crisp bright core with a soft teal halo, so each
  // reads as a clean point of light (a university), not a fuzzy square.
  const dot = document.createElement("canvas");
  dot.width = dot.height = 128;
  const dctx = dot.getContext("2d");
  const grad = dctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.12, "rgba(214,255,247,0.98)");
  grad.addColorStop(0.32, "rgba(45,212,191,0.6)");
  grad.addColorStop(0.62, "rgba(20,184,166,0.18)");
  grad.addColorStop(1, "rgba(20,184,166,0)");
  dctx.fillStyle = grad;
  dctx.fillRect(0, 0, 128, 128);
  const dotTex = new THREE.CanvasTexture(dot);
  const ptMat = new THREE.PointsMaterial({
    map: dotTex,
    size: 0.14,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const uniPoints = new THREE.Points(ptGeo, ptMat);
  earth.add(uniPoints);

  // ---- Atmosphere (fresnel rim glow) ----
  // A thin, physical limb of atmosphere hugging the sunlit edge — NOT a halo.
  // Tight falloff (high power) + low intensity + desaturated sky color so it
  // reads as real air on the horizon, never neon.
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.14, 128, 128),
    new THREE.ShaderMaterial({
      uniforms: { glowColor: { value: new THREE.Color(0x9fb4cf) } },
      vertexShader:
        "varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader:
        "uniform vec3 glowColor; varying vec3 vN; void main(){ float i = pow(max(0.0, 0.62 - dot(vN, vec3(0.0,0.0,1.0))), 5.5); gl_FragColor = vec4(glowColor, 1.0) * i * 0.85; }",
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  scene.add(atmosphere);

  // ---- Lighting (a warm sun + cool fill) ----
  const sun = new THREE.DirectionalLight(0xffe9c9, 2.9); // warm low sun, cinematic
  sun.position.set(-1.1, 0.5, 2.6);
  scene.add(sun);
  // Deep, near-neutral fill so the shadow side stays genuinely dark — deep
  // blacks, not a blue-lit planet.
  scene.add(new THREE.AmbientLight(0x1c1e26, 0.5));
  const rim = new THREE.DirectionalLight(0x8a95a8, 0.45); // faint cool edge separation only
  rim.position.set(2.6, -0.4, -1.2);
  scene.add(rim);

  // ---- Starfield ----
  const N = 1400;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 30 + Math.random() * 40;
    const t = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(t);
    pos[i * 3 + 1] = r * Math.cos(ph);
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(t);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(
    starGeo,
    new THREE.PointsMaterial({
      color: 0xdfe3ec,
      size: 0.09,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
    }),
  );
  scene.add(stars);

  function resize() {
    const w = canvas.clientWidth || canvas.offsetWidth;
    const h = canvas.clientHeight || canvas.offsetHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // Scroll flight state. While the user is scrolling the opening, flyTo() owns
  // the earth rotation; at the very top it gently auto-rotates.
  let scrollActive = false;
  let baseRot = earth.rotation.y;
  const EUROPE_ROT = 4.55; // target rotation.y at flight end — Europe faces us (calibrated)

  let raf;
  function frame() {
    if (!reduce && !scrollActive) {
      earth.rotation.y += 0.0008;
      stars.rotation.y += 0.00008;
    }
    // University points gently pulse when visible — reads as live markers.
    if (ptMat.opacity > 0.01) {
      ptMat.size = 0.13 + Math.sin(performance.now() * 0.0022) * 0.022;
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  // Paint one frame immediately (shows even if rAF is later throttled).
  renderer.render(scene, camera);
  frame();

  return {
    THREE,
    scene,
    camera,
    earth,
    renderer,
    // The scroll flight: progress 0 (whole world, far) → 1 (flown in to Europe,
    // university points glowing). Driven by GSAP ScrollTrigger scrub.
    flyTo: (p) => {
      p = Math.max(0, Math.min(1, p));
      if (p > 0.001 && !scrollActive) {
        scrollActive = true;
        baseRot = earth.rotation.y; // capture so rotation doesn't snap
      } else if (p <= 0.001) {
        scrollActive = false;
      }
      const e = p * p * (3 - 2 * p); // smoothstep
      // Descend from the whole world to a full, Europe-centered globe. End frame
      // calibrated numerically (all 24 uni dots centered, full limb visible).
      camera.position.z = 4.2 - e * 0.4; // 4.2 → 3.8 — globe fills the frame
      camera.position.y = e * 0.2;
      camera.lookAt(0, e * 0.65, 0); // aim up onto Europe so it sits centered
      earth.rotation.y = baseRot + (EUROPE_ROT - baseRot) * e; // turn to Europe
      ptMat.opacity = Math.min(1, Math.max(0, (p - 0.4) / 0.5)); // fade in, cap 1
    },
    setCameraZ: (z) => {
      camera.position.z = z;
    },
    setRotationY: (y) => {
      earth.rotation.y = y;
    },
    destroy: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
    },
  };
}
