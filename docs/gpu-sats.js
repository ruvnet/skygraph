// Experimental WebGPU renderer for the SATELLITE layer only (the layer that
// actually scales — starlink is ~7 000 dots). Instanced point sprites on a
// transparent overlay canvas above the Canvas2D dome; aircraft, trails,
// sun/moon and the dome itself stay on Canvas2D, which remains the default
// and the automatic fallback whenever navigator.gpu is absent or init
// fails (headless browsers, older GPUs, lost devices).
//
// Instance layout (Float32Array, 4 per sat): [x_px, y_px, half_size_px,
// visibility] where visibility 1 tints the sprite the "sunlit against dark
// sky" gold of the Canvas2D path.

const SHADER = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
  @location(1) uv: vec2f,
};

@group(0) @binding(0) var<uniform> viewport: vec2f;

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) inst: vec4f) -> VSOut {
  var corners = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let px = inst.xy + c * inst.z;
  let ndc = vec2f(px.x / viewport.x * 2.0 - 1.0, 1.0 - px.y / viewport.y * 2.0);
  var out: VSOut;
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.uv = c;
  // SAT_COLOR #cfd8ea vs SAT_VISIBLE_COLOR #ffe08a (see draw.js).
  out.color = mix(vec4f(0.81, 0.85, 0.92, 0.85), vec4f(1.0, 0.88, 0.54, 1.0), inst.w);
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let d = length(in.uv);
  if (d > 1.0) { discard; }
  let a = in.color.a * (1.0 - d * d);
  return vec4f(in.color.rgb * a, a); // premultiplied
}
`;

export class GpuSats {
  static supported() {
    return typeof navigator !== "undefined" && !!navigator.gpu;
  }

  constructor() {
    this.device = null;
    this.ctx = null;
    this.canvas = null;
    this.capacity = 0;
  }

  // True on success; false (never throws) when WebGPU is unavailable —
  // the caller falls back to Canvas2D.
  async init(canvas) {
    try {
      if (!GpuSats.supported()) return false;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      this.device = await adapter.requestDevice();
      this.ctx = canvas.getContext("webgpu");
      if (!this.ctx) return false;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.ctx.configure({
        device: this.device, format: this.format, alphaMode: "premultiplied",
      });
      const module = this.device.createShaderModule({ code: SHADER });
      this.pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module, entryPoint: "vs",
          buffers: [{
            arrayStride: 16, stepMode: "instance",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }],
          }],
        },
        fragment: {
          module, entryPoint: "fs",
          targets: [{
            format: this.format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          }],
        },
        primitive: { topology: "triangle-strip" },
      });
      this.uniform = this.device.createBuffer({
        size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.uniform } }],
      });
      this.canvas = canvas;
      return true;
    } catch (_e) {
      this.dispose();
      return false;
    }
  }

  _instanceBuffer(byteLen) {
    if (!this.instBuf || this.capacity < byteLen) {
      this.instBuf?.destroy?.();
      this.capacity = Math.max(byteLen, 4096);
      this.instBuf = this.device.createBuffer({
        size: this.capacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    return this.instBuf;
  }

  // Draw `n` instances from a Float32Array of [x, y, half, vis] tuples
  // (already in CSS pixels for a w×h canvas). Never throws.
  draw(instances, n, w, h, dpr) {
    if (!this.device || !this.ctx) return;
    try {
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (this.canvas.width !== pw || this.canvas.height !== ph) {
        this.canvas.width = pw;
        this.canvas.height = ph;
      }
      this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([w, h]));
      const byteLen = n * 16;
      const buf = this._instanceBuffer(byteLen);
      if (n) this.device.queue.writeBuffer(buf, 0, instances, 0, n * 4);
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this.ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear", storeOp: "store",
        }],
      });
      if (n) {
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.setVertexBuffer(0, buf, 0, byteLen);
        pass.draw(4, n);
      }
      pass.end();
      this.device.queue.submit([enc.finish()]);
    } catch (_e) { /* lost device etc. — caller may dispose */ }
  }

  dispose() {
    try { this.instBuf?.destroy?.(); this.uniform?.destroy?.(); this.device?.destroy?.(); }
    catch (_e) { /* already gone */ }
    this.device = null;
    this.ctx = null;
    if (this.canvas) {
      this.canvas.width = 1; // clear the overlay
      this.canvas.height = 1;
    }
  }
}
