// Patterns: a hit flash, and the shader layers (kaleidoscope, flow field,
// aurora, hex grid). Shader layers keep their GLSL here; GLHost supplies the
// uniforms and helpers declared in its prelude.
import { paletteFor } from '../palette';
import { RENDER_SCALE } from '../GLHost';
import type { LayerContext, LayerInstance, VisualFrame } from '../types';
import { num, str } from './util';

// ---- hit flash ---------------------------------------------------------------

export function flashLayer(): LayerInstance {
  let key = '';
  let vignette: CanvasGradient | null = null;
  let barLeft: CanvasGradient | null = null;
  let barRight: CanvasGradient | null = null;
  let glow = 0;
  let lastKicks = -1;
  return {
    reset() { glow = 0; },
    get animating() { return glow > 0.01; },
    draw(ctx, frame, layer) {
      const { features } = frame;
      if (lastKicks < 0) lastKicks = features.kicks;
      if (features.kicks !== lastKicks) {
        lastKicks = features.kicks;
        glow = Math.max(glow, features.onset);
      }
      glow *= Math.exp(-frame.dt * 6);
      if (glow < 0.01) return;
      const palette = paletteFor(frame.theme);
      const { width, height } = frame;
      const k = `${width}|${height}|${palette.accent}|${palette.left}|${palette.right}`;
      if (k !== key) {
        key = k;
        vignette = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.25, width / 2, height / 2, Math.hypot(width, height) / 2);
        vignette.addColorStop(0, `rgba(${palette.accent},0)`);
        vignette.addColorStop(0.7, `rgba(${palette.accent},0.35)`);
        vignette.addColorStop(1, `rgba(${palette.accent},0.9)`);
        const side = width * 0.14;
        barLeft = ctx.createLinearGradient(0, 0, side, 0);
        barLeft.addColorStop(0, `rgba(${palette.left},0.95)`);
        barLeft.addColorStop(1, `rgba(${palette.left},0)`);
        barRight = ctx.createLinearGradient(width, 0, width - side, 0);
        barRight.addColorStop(0, `rgba(${palette.right},0.95)`);
        barRight.addColorStop(1, `rgba(${palette.right},0)`);
      }
      ctx.globalCompositeOperation = frame.theme.blend;
      const strength = Math.min(1, glow * layer.intensity);
      const style = str(layer, 'style', 'vignette');
      if (style === 'full') {
        ctx.globalAlpha = layer.opacity * strength * 0.35;
        ctx.fillStyle = `rgb(${palette.accent})`;
        ctx.fillRect(0, 0, width, height);
      } else if (style === 'bars') {
        ctx.globalAlpha = layer.opacity * strength;
        ctx.fillStyle = barLeft!;
        ctx.fillRect(0, 0, width * 0.14, height);
        ctx.fillStyle = barRight!;
        ctx.fillRect(width * 0.86, 0, width * 0.14, height);
      } else {
        ctx.globalAlpha = layer.opacity * strength;
        ctx.fillStyle = vignette!;
        ctx.fillRect(0, 0, width, height);
      }
    },
  };
}

// ---- shader layers -----------------------------------------------------------

type ParamFn = (frame: VisualFrame, layer: LayerContext) => [number, number, number, number];

/**
 * A layer that draws `fragment` through the shared GL host. Its clock runs
 * faster with loudness, so motion follows the music and stops when it does.
 */
function shaderLayer(id: string, fragment: string, params: ParamFn, pace = 1): () => LayerInstance {
  return () => {
    let time = Math.random() * 100;
    return {
      draw(ctx, frame, layer) {
        const host = frame.gl;
        if (!host) return;
        const { features } = frame;
        time += frame.dt * pace * (0.25 + features.level * 1.6 + features.onset * 0.8);
        host.setSize(frame.width, frame.height, frame.dpr);
        host.uploadAudio(features, frame.now);
        const palette = paletteFor(frame.theme);
        const canvas = host.render(id, fragment, {
          time,
          intensity: layer.intensity,
          colA: palette.leftGl,
          colB: palette.rightGl,
          colC: palette.accentGl,
          params: params(frame, layer),
          centre: [frame.centreX / frame.width, 1 - frame.centreY / frame.height],
        });
        if (!canvas) return;
        ctx.globalCompositeOperation = frame.theme.blend;
        ctx.globalAlpha = layer.opacity;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(canvas, 0, 0, frame.width, frame.height);
      },
    };
  };
}

const KALEIDOSCOPE = `
void main() {
  vec2 p = (gl_FragCoord.xy - uCentre * uRes) / uRes.y;
  float segments = uParams.x;
  float zoom = uParams.y;
  float r = length(p);
  float a = atan(p.y, p.x) + uTime * 0.05;
  float sector = 6.2831853 / segments;
  a = mod(a, sector);
  a = abs(a - sector * 0.5);
  vec2 q = vec2(cos(a), sin(a)) * r * zoom;
  float t = uTime * 0.18;
  q += vec2(t, -t * 0.7);
  float n = fbm(q * 2.0 + fbm(q * 1.4 - t));
  float band = spec(fract(r * 0.9 - t * 0.2));
  float petals = smoothstep(0.5, 0.95, n + band * 0.55 + uBands.x * 0.35);
  vec3 col = mix(uColA, uColB, smoothstep(0.25, 0.75, n));
  col = mix(col, uColC, petals * 0.65 + uOnset * 0.25);
  float fade = smoothstep(1.5, 0.05, r);
  float glow = (0.2 + 0.8 * petals) * (0.3 + uLevel * 1.3 + uOnset * 0.4) * uIntensity;
  emit(col, glow * fade);
}`;

const FLOW_FIELD = `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes.y;
  float t = uTime * 0.2 * uParams.y;
  vec2 p = uv * uParams.x;
  vec2 w = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
  float ang = fbm(p * 0.8 + w * 2.0 + t * 0.5) * 6.2831853;
  vec2 dir = vec2(cos(ang), sin(ang));
  float lane = dot(p + w * 1.4, vec2(-dir.y, dir.x));
  float lines = sin(lane * 26.0 + t * 6.0 + fbm(p * 3.0) * 4.0);
  float streak = smoothstep(0.7, 1.0, lines) * (0.4 + 0.6 * noise(p * 6.0 + t * 3.0));
  float energy = 0.3 + uLevel * 1.4 + uOnset * 0.6;
  vec3 col = mix(uColA, uColB, clamp(w.x * 1.4 - 0.2, 0.0, 1.0));
  col = mix(col, uColC, clamp(streak * (uBands.z + uOnset), 0.0, 1.0));
  float haze = fbm(p * 0.6 + w) * 0.22;
  emit(col, (streak * 0.85 + haze) * energy * 0.6 * uIntensity);
}`;

const AURORA = `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float h = uParams.x;
  float t = uTime * 0.12;
  vec3 col = vec3(0.0);
  float acc = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = uv.x * (1.4 + fi * 0.6) + t * (0.5 + fi * 0.3);
    float base = 1.0 - h * 0.9 + 0.1 * sin(x * 3.0 + fbm(vec2(x, fi * 3.1)) * 4.0) + fi * 0.06;
    base -= uBands[i] * 0.22 * uIntensity + uOnset * 0.04;
    float d = uv.y - base;
    float curtain = smoothstep(-0.01, 0.025, d) * exp(-max(d, 0.0) * (4.5 - uBands[i] * 2.0));
    float rays = 0.55 + 0.45 * fbm(vec2(x * 9.0, uv.y * 1.5 - t * 2.5));
    vec3 c = i == 0 ? uColA : (i == 1 ? uColC : uColB);
    col += c * curtain * rays;
    acc += curtain * rays;
  }
  float a = acc * (0.3 + uLevel * 1.2 + uOnset * 0.35) * 0.65 * uIntensity;
  emit(col / max(acc, 0.001), a);
}`;

const HEX_GRID = `
float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x);
}
void main() {
  float cell = uParams.x;
  vec2 uv = gl_FragCoord.xy / cell;
  vec2 r = vec2(1.0, 1.7320508);
  vec2 hr = r * 0.5;
  vec2 a = mod(uv, r) - hr;
  vec2 b = mod(uv - hr, r) - hr;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = uv - gv;
  float edge = hexDist(gv);
  vec2 pos = id * cell / uRes;
  float level = spec(pos.x);
  float fy = abs(pos.y - uCentre.y) * 2.0;
  float lit = smoothstep(level * 1.15, level * 1.15 - 0.08, fy);
  float rnd = hash21(id);
  lit = max(lit, uOnset * step(0.82, rnd));
  float fill = smoothstep(0.42, 0.3, edge);
  float border = smoothstep(0.5, 0.46, edge) - smoothstep(0.44, 0.40, edge);
  vec3 col = mix(uColA, uColB, pos.x);
  col = mix(col, uColC, clamp(uOnset * rnd + lit * 0.25, 0.0, 1.0));
  float alpha = border * (0.08 + uLevel * 0.35) + fill * lit * (0.35 + 0.5 * level);
  emit(col, alpha * uIntensity);
}`;

export const kaleidoscopeLayer = shaderLayer('kaleidoscope', KALEIDOSCOPE,
  (_frame, layer) => [num(layer, 'segments', 8), num(layer, 'zoom', 1.5), 0, 0]);

export const flowFieldLayer = shaderLayer('flow-field', FLOW_FIELD,
  (_frame, layer) => [num(layer, 'scale', 2.2), num(layer, 'speed', 1), 0, 0]);

export const auroraLayer = shaderLayer('aurora', AURORA,
  (_frame, layer) => [num(layer, 'height', 0.6), 0, 0, 0], 0.8);

export const hexGridLayer = shaderLayer('hex-grid', HEX_GRID,
  (frame, layer) => [Math.max(4, num(layer, 'size', 28) * frame.dpr * RENDER_SCALE), 0, 0, 0]);
