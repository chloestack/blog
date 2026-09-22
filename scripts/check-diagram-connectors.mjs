// 도식 SVG의 연결선 점검기.
//   node scripts/check-diagram-connectors.mjs content/diagrams/2026-09-23-*.html
// 잡아내는 것: 박스에서 떨어져 허공에 뜬 화살표, 박스 안에 파묻혀
// 화살촉이 가려진 연결선, viewBox 밖으로 잘려나간 범례.
// 4~8px 정도 떨어진 것은 화살표 마커 여유라 정상이다.
import fs from 'fs';

const TOL = 8.0;      // 화살표 마커 여유(하우스 스타일)
const BURY = 10.0;    // 이보다 깊이 박스 안으로 들어가면 화살촉이 가려진다

function attrs(tag) {
  const o = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2];
  return o;
}

// 노드를 폴리곤(점 배열)으로 모은다
function nodesOf(src) {
  const vb = src.match(/viewBox="([^"]+)"/);
  const [, , VW, VH] = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : [0, 0, 960, 400];
  const out = [];
  const rectPoly = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  for (const m of src.matchAll(/<rect\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const x = +a.x || 0, y = +a.y || 0, w = +a.width || 0, h = +a.height || 0;
    if (!w || !h) continue;
    if (w >= VW - 1 && h >= VH - 1) continue;   // 배경
    if (h < 20 || w < 30) continue;             // 라벨 칩 / 태그
    out.push(rectPoly(x, y, w, h));
  }
  for (const m of src.matchAll(/<(circle|ellipse)\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const cx = +a.cx || 0, cy = +a.cy || 0;
    const rx = +(a.r ?? a.rx) || 0, ry = +(a.r ?? a.ry) || 0;
    if (rx < 15) continue;
    const pts = [];
    for (let i = 0; i < 32; i++) {
      const t = (i / 32) * Math.PI * 2;
      pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
    }
    out.push(pts);
  }
  for (const m of src.matchAll(/<polygon\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!a.points) continue;
    const n = a.points.trim().split(/[\s,]+/).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    if (Math.max(...xs) - Math.min(...xs) < 30 || Math.max(...ys) - Math.min(...ys) < 20) continue;
    out.push(pts);
  }
  return out;
}

function pathPoints(d) {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?[\d.]+(?:e-?\d+)?/g);
  if (!toks) return null;
  let i = 0, cx = 0, cy = 0, cmd = null, start = null;
  const pts = [];
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    if (i >= toks.length && !/[Zz]/.test(cmd)) break;
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': { const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; if (!start) start = [cx, cy]; cmd = rel ? 'l' : 'L'; break; }
      case 'L': { const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; break; }
      case 'H': { const x = num(); cx = rel ? cx + x : x; break; }
      case 'V': { const y = num(); cy = rel ? cy + y : y; break; }
      case 'C': { num(); num(); num(); num(); const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; break; }
      case 'S': case 'Q': { num(); num(); const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; break; }
      case 'T': { const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; break; }
      case 'A': { num(); num(); num(); num(); num(); const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; break; }
      case 'Z': { if (start) { cx = start[0]; cy = start[1]; } break; }
      default: return null;
    }
    pts.push([cx, cy]);
  }
  return pts.length ? { first: pts[0], last: pts[pts.length - 1] } : null;
}

function segDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// 경계까지의 거리. 안쪽이면 음수.
function signedDist(p, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDist(p, poly[j], poly[i]));
  return inside(p, poly) ? -d : d;
}

const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const nodes = nodesOf(src);
  if (!nodes.length) continue;
  const issues = [];

  // 다른 노드를 2개 이상 품고 있으면 그룹 패널로 보고 '묻힘' 판정에서 제외한다
  const bbox = (poly) => {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const isContainer = nodes.map((n, i) => {
    const [ax, ay, bx, by] = bbox(n);
    let c = 0;
    nodes.forEach((m, j) => {
      if (i === j) return;
      const [cx, cy, dx, dy] = bbox(m);
      if (cx >= ax - 1 && cy >= ay - 1 && dx <= bx + 1 && dy <= by + 1) c++;
    });
    return c >= 2;
  });

  const verdict = (pt) => {
    const ds = nodes.map((n) => signedDist(pt, n));
    const near = Math.min(...ds.map(Math.abs));
    const deepest = Math.min(...ds.filter((_, i) => !isContainer[i]));
    return { near, deepest };
  };
  const check = (which, pt, d) => {
    const { near, deepest } = verdict(pt);
    if (near <= TOL) return;
    if (deepest < -BURY) issues.push([`${which} 화살촉이 박스 안 ${(-deepest).toFixed(0)}px에 묻힘 @ (${pt.map((v) => v.toFixed(0)).join(',')})`, d]);
    else issues.push([`${which} 박스와 ${near.toFixed(0)}px 떨어짐 @ (${pt.map((v) => v.toFixed(0)).join(',')})`, d]);
  };
  // 양 끝이 모두 노드에서 먼 선은 범례 샘플이므로 건너뛴다
  const isLegendSample = (a, b) => verdict(a).near > 40 && verdict(b).near > 40;

  for (const m of src.matchAll(/<path\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!a.d || !a.stroke || a.stroke === 'none') continue;
    if (!a['marker-end'] && !a['marker-start']) continue;
    const pp = pathPoints(a.d);
    if (!pp) { issues.push(['parse-fail', a.d]); continue; }
    if (isLegendSample(pp.first, pp.last)) continue;
    check('시작', pp.first, a.d.slice(0, 70));
    check('끝', pp.last, a.d.slice(0, 70));
  }
  for (const m of src.matchAll(/<line\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!a['marker-end'] && !a['marker-start']) continue;
    const d = `${a.x1},${a.y1} → ${a.x2},${a.y2}`;
    if (isLegendSample([+a.x1, +a.y1], [+a.x2, +a.y2])) continue;
    check('시작', [+a.x1, +a.y1], d);
    check('끝', [+a.x2, +a.y2], d);
  }

  const vb = src.match(/viewBox="([^"]+)"/);
  if (vb) {
    const [, , VW, VH] = vb[1].trim().split(/[\s,]+/).map(Number);
    for (const m of src.matchAll(/<(rect|text|line|circle)\b[^>]*>/g)) {
      const a = attrs(m[0]);
      const ys = [a.y, a.y1, a.y2, a.cy].filter((v) => v !== undefined).map(Number);
      const hh = Number(a.height || 0);
      if (!ys.length) continue;
      const bottom = Math.max(...ys) + hh;
      if (bottom > VH + 0.5) issues.push([`캔버스 밖 (bottom ${bottom} > ${VH})`, m[0].slice(0, 56)]);
    }
  }

  if (issues.length) {
    bad++;
    console.log(`\n== ${f}  (노드 ${nodes.length})`);
    for (const [msg, d] of issues) console.log(`   ${msg}   ${d}`);
  }
}
console.log(`\n${bad}/${files.length} 파일에 문제`);
