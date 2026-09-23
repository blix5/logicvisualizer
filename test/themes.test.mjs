import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, formatHsl, parseColor, toHex, toHsl } from '../.test-build/color.mjs';
import { THEMES, themeById, uiCssVariables } from '../.test-build/themes.mjs';
import { adaptForTheme, PALETTE_CHOICES, resolveTrackColors } from '../.test-build/palettes.mjs';

function track(index, overrides = {}) {
  return {
    id: `t${index}`, arrangeIndex: index, name: `Track ${index}`, kind: 'unknown',
    color: `hsl(${index * 40} 62% 58%)`, colorSource: 'fallback', trackRef: index,
    muted: false, mutedBy: null, volume: null, ownVolume: null, number: index + 1,
    depth: 0, parentId: null, stack: null, channel: null, ...overrides,
  };
}

test('parseColor reads every form the themes use', () => {
  assert.deepEqual(parseColor('#ff0000'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  const hsl = parseColor('hsl(120 100% 50% / 0.25)');
  assert.equal(Math.round(hsl.g), 255);
  assert.equal(hsl.a, 0.25);
  assert.equal(parseColor('not a colour'), null);
  assert.equal(toHex('hsl(0 100% 50%)'), '#ff0000');
});

test('every theme sets every token to a colour the canvas can parse', () => {
  const reference = THEMES[0];
  for (const theme of THEMES) {
    assert.deepEqual(Object.keys(theme.ui).sort(), Object.keys(reference.ui).sort(), theme.id);
    assert.deepEqual(Object.keys(theme.canvas).sort(), Object.keys(reference.canvas).sort(), theme.id);
    for (const [key, value] of Object.entries(theme.canvas)) {
      if (key === 'blend' || key === 'spectrum' || value === null) continue;
      for (const color of [value].flat()) assert.ok(parseColor(color), `${theme.id}.${key}: ${color}`);
    }
    // The alpha helpers append to hsl(); muted must be one.
    assert.ok(theme.canvas.muted.startsWith('hsl('), `${theme.id}.muted`);
    assert.ok(parseColor(theme.ui.bg), `${theme.id}.ui.bg`);
  }
  assert.equal(uiCssVariables(themeById('midnight').ui)['--control-hover'], 'rgba(255, 255, 255, 0.12)');
});

test('text is readable on every theme, and high contrast is AAA', () => {
  for (const theme of THEMES) {
    const minimum = theme.contrast === 'high' ? 7 : 4.5;
    for (const ground of [theme.ui.bg, theme.ui.panel]) {
      const ratio = contrastRatio(theme.ui.text, ground);
      assert.ok(ratio >= minimum, `${theme.id} text on ${ground}: ${ratio.toFixed(2)}`);
    }
    const muted = contrastRatio(theme.ui.muted, theme.ui.bg);
    assert.ok(muted >= (theme.contrast === 'high' ? 7 : 3), `${theme.id} muted: ${muted.toFixed(2)}`);
    const lanes = contrastRatio(theme.canvas.laneText, theme.canvas.laneBg);
    assert.ok(lanes >= minimum, `${theme.id} lane text: ${lanes.toFixed(2)}`);
  }
});

test('Midnight with theme colours leaves fallback track colours exactly as loaded', () => {
  const tracks = [track(0), track(1), track(2)];
  assert.deepEqual(resolveTrackColors(tracks, 'theme', themeById('midnight')), tracks.map((t) => t.color));
  assert.deepEqual(resolveTrackColors(tracks, 'vivid', themeById('midnight')), tracks.map((t) => t.color));
});

test('From Logic uses project colours, and falls back to the theme palette without them', () => {
  const midnight = themeById('midnight');
  const withColor = track(0, { color: '#ff0000', colorSource: 'project' });
  const [fromLogic] = resolveTrackColors([withColor], 'logic', midnight);
  assert.equal(fromLogic, 'hsl(0 100% 50%)');
  const plain = [track(0), track(1)];
  assert.deepEqual(resolveTrackColors(plain, 'logic', midnight), resolveTrackColors(plain, 'theme', midnight));
});

test('adaptForTheme keeps colours in range and deepens them on light themes', () => {
  const light = themeById('daylight');
  const contrast = themeById('contrast-dark');
  for (let hue = 0; hue < 360; hue += 30) {
    for (const l of [20, 58, 85]) {
      const source = formatHsl({ h: hue, s: 60, l });
      const onLight = toHsl(adaptForTheme(source, light));
      assert.ok(onLight.l >= 41 && onLight.l <= 61, `light ${source} -> ${onLight.l}`);
      const onContrast = toHsl(adaptForTheme(source, contrast));
      assert.ok(onContrast.l >= 54 && onContrast.l <= 69, `contrast ${source} -> ${onContrast.l}`);
    }
  }
});

test('every palette choice gives a colour per track, on every theme', () => {
  const tracks = Array.from({ length: 20 }, (_, i) => track(i));
  for (const theme of THEMES) {
    for (const choice of PALETTE_CHOICES) {
      const colors = resolveTrackColors(tracks, choice.id, theme);
      assert.equal(colors.length, tracks.length);
      for (const color of colors) assert.ok(parseColor(color) && color.startsWith('hsl('), `${theme.id}/${choice.id}: ${color}`);
    }
  }
});
