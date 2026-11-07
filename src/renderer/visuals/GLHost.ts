// One offscreen WebGL2 canvas shared by every shader layer. A shader layer
// renders a full-screen fragment shader into it, and the stack then draws that
// canvas into the 2D canvas like any image, so shader layers blend, fade and
// stack exactly as the 2D ones do. It renders at a fraction of the canvas's
// resolution: these effects are soft, and fill rate is what they cost.
//
// The audio goes up once per frame as two small textures: a log-frequency
// spectrum and a stretch of the (mid) waveform.
import { normaliseDb, type AudioFeatures } from './AudioFeatures';

/** Fraction of the canvas's device pixels the shaders render at. */
export const RENDER_SCALE = 0.5;
const SPEC_SIZE = 256;
const WAVE_SIZE = 512;
const LOW_HZ = 30;
const HIGH_HZ = 16000;

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Declarations and helpers every layer's fragment shader gets ahead of its own code. */
const PRELUDE = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uCentre;
uniform float uTime;
uniform vec4 uBands;
uniform float uLevel;
uniform float uOnset;
uniform float uIntensity;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec4 uParams;
uniform sampler2D uSpec;
uniform sampler2D uWave;
out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
float spec(float x) { return texture(uSpec, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }
float wave(float x) { return texture(uWave, vec2(clamp(x, 0.0, 1.0), 0.5)).r * 2.0 - 1.0; }
/** Premultiplied output, which is what the canvas composites. */
void emit(vec3 color, float alpha) { alpha = clamp(alpha, 0.0, 1.0); outColor = vec4(color * alpha, alpha); }
`;

export type GLUniforms = {
  time: number;
  intensity: number;
  /** 0..1 RGB. */
  colA: readonly [number, number, number];
  colB: readonly [number, number, number];
  colC: readonly [number, number, number];
  params: readonly [number, number, number, number];
  /** Canvas-space centre, 0..1 from the bottom left as GL counts. */
  centre: readonly [number, number];
};

type Program = {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
};

const UNIFORM_NAMES = [
  'uRes', 'uCentre', 'uTime', 'uBands', 'uLevel', 'uOnset', 'uIntensity',
  'uColA', 'uColB', 'uColC', 'uParams', 'uSpec', 'uWave',
];

let shared: GLHost | null | undefined;

export class GLHost {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly vao: WebGLVertexArrayObject | null;
  private readonly programs = new Map<string, Program | null>();
  private readonly specTex: WebGLTexture | null;
  private readonly waveTex: WebGLTexture | null;
  private readonly specData = new Uint8Array(SPEC_SIZE);
  private readonly waveData = new Uint8Array(WAVE_SIZE);
  private specKey = '';
  private specFrom = new Int32Array(SPEC_SIZE);
  private specTo = new Int32Array(SPEC_SIZE);
  private audioStamp = -1;
  private bands = new Float32Array(4);
  private level = 0;
  private onset = 0;

  /** The shared host, created on first use; null where WebGL2 is unavailable. */
  static get(): GLHost | null {
    if (shared === undefined) {
      try {
        shared = new GLHost();
      } catch {
        shared = null;
      }
    }
    return shared;
  }

  /** Whether WebGL2 works here, without keeping a context around if it is never used. */
  static get supported(): boolean {
    return GLHost.get() !== null;
  }

  private constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 2;
    this.canvas.height = 2;
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is unavailable.');
    this.gl = gl;
    this.vao = gl.createVertexArray();
    const texture = (width: number) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    this.specTex = texture(SPEC_SIZE);
    this.waveTex = texture(WAVE_SIZE);
  }

  /** Sizes the render target for a canvas of `width` x `height` CSS px. */
  setSize(width: number, height: number, dpr: number): void {
    const w = Math.max(2, Math.round(width * dpr * RENDER_SCALE));
    const h = Math.max(2, Math.round(height * dpr * RENDER_SCALE));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /** Uploads the frame's audio; repeat calls with the same stamp are free. */
  uploadAudio(features: AudioFeatures, stamp: number): void {
    if (stamp === this.audioStamp) return;
    this.audioStamp = stamp;
    const { gl } = this;
    this.bands.set(features.bands);
    this.level = features.level;
    this.onset = features.onset;

    if (features.valid) {
      const bins = features.left.length;
      const key = `${bins}|${features.sampleRate}`;
      if (key !== this.specKey) {
        this.specKey = key;
        const hzPerBin = features.sampleRate / 2 / bins;
        const span = Math.log(HIGH_HZ / LOW_HZ);
        for (let i = 0; i < SPEC_SIZE; i += 1) {
          const from = Math.min(bins - 1, Math.floor((LOW_HZ * Math.exp((span * i) / SPEC_SIZE)) / hzPerBin));
          this.specFrom[i] = from;
          this.specTo[i] = Math.min(bins - 1, Math.max(from, Math.ceil((LOW_HZ * Math.exp((span * (i + 1)) / SPEC_SIZE)) / hzPerBin)));
        }
      }
      for (let i = 0; i < SPEC_SIZE; i += 1) {
        let peak = -Infinity;
        for (let b = this.specFrom[i]!; b <= this.specTo[i]!; b += 1) {
          const db = Math.max(features.left[b]!, features.right[b]!);
          if (db > peak) peak = db;
        }
        this.specData[i] = normaliseDb(peak) * 255;
      }
    } else {
      // Falls away rather than snapping off when the music stops.
      for (let i = 0; i < SPEC_SIZE; i += 1) this.specData[i] = this.specData[i]! * 0.85;
    }

    if (features.hasWave) {
      const left = features.waveLeft;
      const right = features.waveRight;
      const step = Math.max(1, Math.floor(left.length / WAVE_SIZE));
      for (let i = 0; i < WAVE_SIZE; i += 1) {
        const s = ((left[i * step] ?? 0) + (right[i * step] ?? 0)) * 0.5;
        this.waveData[i] = Math.max(0, Math.min(255, (0.5 + s * 0.5) * 255));
      }
    } else {
      this.waveData.fill(128);
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPEC_SIZE, 1, gl.RED, gl.UNSIGNED_BYTE, this.specData);
    gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WAVE_SIZE, 1, gl.RED, gl.UNSIGNED_BYTE, this.waveData);
  }

  private program(id: string, fragment: string): Program | null {
    if (this.programs.has(id)) return this.programs.get(id)!;
    const { gl } = this;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn(`[visuals] ${id} shader failed to compile:`, gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, PRELUDE + fragment);
    let result: Program | null = null;
    if (vs && fs) {
      const program = gl.createProgram();
      if (program) {
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
          const uniforms: Program['uniforms'] = {};
          for (const name of UNIFORM_NAMES) uniforms[name] = gl.getUniformLocation(program, name);
          result = { program, uniforms };
        } else {
          console.warn(`[visuals] ${id} shader failed to link:`, gl.getProgramInfoLog(program));
        }
      }
    }
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    // A failure is remembered, so a broken shader is not recompiled every frame.
    this.programs.set(id, result);
    return result;
  }

  /** Renders layer `id`'s shader and returns the canvas holding it, or null on failure. */
  render(id: string, fragment: string, values: GLUniforms): HTMLCanvasElement | null {
    const { gl } = this;
    if (gl.isContextLost()) return null;
    const prog = this.program(id, fragment);
    if (!prog) return null;
    const { uniforms: u } = prog;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog.program);
    gl.uniform2f(u.uRes!, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uCentre!, values.centre[0], values.centre[1]);
    gl.uniform1f(u.uTime!, values.time);
    gl.uniform4f(u.uBands!, this.bands[0]!, this.bands[1]!, this.bands[2]!, this.bands[3]!);
    gl.uniform1f(u.uLevel!, this.level);
    gl.uniform1f(u.uOnset!, this.onset);
    gl.uniform1f(u.uIntensity!, values.intensity);
    gl.uniform3f(u.uColA!, ...values.colA);
    gl.uniform3f(u.uColB!, ...values.colB);
    gl.uniform3f(u.uColC!, ...values.colC);
    gl.uniform4f(u.uParams!, ...values.params);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.uniform1i(u.uSpec!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
    gl.uniform1i(u.uWave!, 1);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    return this.canvas;
  }
}
