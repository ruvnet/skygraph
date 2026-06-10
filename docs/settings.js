// ⚙ drawer: persisted layer/setting state (localStorage) + control wiring.
// New v2 keys: conflicts (CPA layer), webgpuSats (experimental satellite
// renderer), tleGroup (CelesTrak group — starlink gated on WebGPU).

export const SETTINGS_KEY = "skygraph-settings-v1";
const DEFAULTS = {
  aircraft: true, satellites: true, sunmoon: true, trails: true, labels: true,
  conflicts: true, trailLen: 150, webgpuSats: false, tleGroup: "visual",
};

export const CFG = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch (_e) { return { ...DEFAULTS }; }
})();

export const saveSettings = () => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(CFG)); } catch (_e) { /* quota */ }
};

// Wire all drawer controls. handlers:
//   onWebgpu(enabled) -> Promise<boolean>  (false = init failed, fall back)
//   onTleGroup(group)                      (reload the satellite layer)
//   onPassAlerts() -> Promise<boolean>     (Notification permission result)
export function initDrawer(handlers) {
  const drawer = document.getElementById("drawer");
  document.getElementById("gear")
    .addEventListener("click", () => drawer.classList.toggle("open"));

  for (const key of ["aircraft", "satellites", "sunmoon", "trails", "labels", "conflicts"]) {
    const box = document.getElementById(`opt-${key}`);
    box.checked = CFG[key];
    box.addEventListener("change", () => { CFG[key] = box.checked; saveSettings(); });
  }

  const trailLen = document.getElementById("opt-trail-len");
  const trailOut = document.getElementById("opt-trail-out");
  trailLen.value = String(CFG.trailLen);
  trailOut.textContent = String(CFG.trailLen);
  trailLen.addEventListener("input", () => {
    CFG.trailLen = Number(trailLen.value);
    trailOut.textContent = trailLen.value;
    saveSettings();
  });

  // TLE group select — starlink is only offered while WebGPU is active
  // ("active" is bigger still and deliberately not offered at all).
  const sel = document.getElementById("opt-tle-group");
  const syncTleOptions = () => {
    const starlink = sel.querySelector('option[value="starlink"]');
    starlink.disabled = !CFG.webgpuSats;
    if (starlink.disabled && CFG.tleGroup === "starlink") {
      CFG.tleGroup = "visual";
      sel.value = "visual";
      saveSettings();
      handlers.onTleGroup("visual");
    }
  };
  sel.value = CFG.tleGroup;
  sel.addEventListener("change", () => {
    CFG.tleGroup = sel.value;
    saveSettings();
    handlers.onTleGroup(sel.value);
  });

  // WebGPU toggle with automatic Canvas2D fallback on init failure.
  const gpuBox = document.getElementById("opt-webgpu");
  gpuBox.checked = CFG.webgpuSats;
  gpuBox.addEventListener("change", async () => {
    if (gpuBox.checked && !(await handlers.onWebgpu(true))) {
      gpuBox.checked = false; // no WebGPU here — stay on Canvas2D
    } else if (!gpuBox.checked) {
      await handlers.onWebgpu(false);
    }
    CFG.webgpuSats = gpuBox.checked;
    saveSettings();
    syncTleOptions();
  });

  // Pass alerts (Notification permission is user-gesture gated).
  const alertBtn = document.getElementById("opt-pass-alerts");
  alertBtn.addEventListener("click", async () => {
    const on = await handlers.onPassAlerts();
    alertBtn.textContent = on ? "Pass alerts: ON" : "Pass alerts: unavailable";
  });

  syncTleOptions();
  return { syncTleOptions };
}
