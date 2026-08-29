export type GoldenPoint = readonly [number, number];
export type GoldenPolygon = readonly GoldenPoint[];
type Segment = readonly [GoldenPoint, GoldenPoint];

/** Human-reviewed source coordinates, not a threshold mask or a solver-produced target. */
export type GoldenSection = {
  columns: number;
  rows: number;
  origin: GoldenPoint;
  spacingMm: GoldenPoint;
  polygons: readonly GoldenPolygon[];
  holes?: readonly GoldenPolygon[];
  uncertainPolygons?: readonly GoldenPolygon[];
  boundaryUncertaintyMm: number;
  auditMarginMm: number;
  auditBounds?: { min: GoldenPoint; max: GoldenPoint };
  valid?: Uint8Array;
};

const cross = (a: GoldenPoint, b: GoldenPoint) => a[0] * b[1] - a[1] * b[0];
const subtract = (a: GoldenPoint, b: GoldenPoint): GoldenPoint => [a[0] - b[0], a[1] - b[1]];
const along = ([a, b]: Segment, t: number): GoldenPoint => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const ringSegments = (ring: GoldenPolygon): Segment[] =>
  ring.map((point, index) => [point, ring[(index + 1) % ring.length]!]);

function distanceToSegment(point: GoldenPoint, [first, last]: Segment): number {
  const delta = subtract(last, first),
    offset = subtract(point, first);
  const squaredLength = delta[0] ** 2 + delta[1] ** 2;
  const t = squaredLength ? Math.max(0, Math.min(1, (offset[0] * delta[0] + offset[1] * delta[1]) / squaredLength)) : 0;
  return Math.hypot(offset[0] - delta[0] * t, offset[1] - delta[1] * t);
}

function insideRing(point: GoldenPoint, ring: GoldenPolygon): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index]!,
      b = ring[previous]!;
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}

/** Split intersecting rings before measuring the union boundary: overlapping labels do not create false seams. */
function unionBoundary(rings: readonly GoldenPolygon[], holes: readonly GoldenPolygon[]): Segment[] {
  const segments = [...rings, ...holes].flatMap(ringSegments);
  const contains = (point: GoldenPoint) =>
    rings.some((ring) => insideRing(point, ring)) && !holes.some((ring) => insideRing(point, ring));
  const unique = new Map<string, Segment>();
  for (const segment of segments) {
    const [a, b] = segment,
      r = subtract(b, a),
      squaredLength = r[0] ** 2 + r[1] ** 2;
    if (!squaredLength) continue;
    const cuts = [0, 1];
    for (const [c, d] of segments) {
      const s = subtract(d, c),
        q = subtract(c, a),
        divisor = cross(r, s);
      if (Math.abs(divisor) > 1e-10) {
        const t = cross(q, s) / divisor,
          u = cross(q, r) / divisor;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
      } else if (Math.abs(cross(q, r)) < 1e-10) {
        for (const point of [c, d]) {
          const offset = subtract(point, a),
            t = (offset[0] * r[0] + offset[1] * r[1]) / squaredLength;
          if (t > 0 && t < 1) cuts.push(t);
        }
      }
    }
    cuts.sort((first, last) => first - last);
    for (let index = 1; index < cuts.length; index++) {
      const lower = cuts[index - 1]!,
        upper = cuts[index]!;
      if (upper - lower < 1e-10) continue;
      const midpoint = along(segment, (lower + upper) / 2);
      const epsilon = 1e-7 / Math.sqrt(squaredLength);
      if (
        contains([midpoint[0] - r[1] * epsilon, midpoint[1] + r[0] * epsilon]) ===
        contains([midpoint[0] + r[1] * epsilon, midpoint[1] - r[0] * epsilon])
      )
        continue;
      const edge: Segment = [along(segment, lower), along(segment, upper)];
      const key = edge
        .map((point) => point.map((value) => value.toFixed(8)).join(','))
        .sort()
        .join('|');
      unique.set(key, edge);
    }
  }
  return [...unique.values()];
}

export function rasterizeGoldenSection(section: GoldenSection) {
  const { columns, rows, origin, spacingMm } = section;
  if (
    ![columns, rows].every((value) => Number.isSafeInteger(value) && value > 0) ||
    !origin.every(Number.isFinite) ||
    !spacingMm.every((value) => Number.isFinite(value) && value > 0) ||
    ![section.boundaryUncertaintyMm, section.auditMarginMm].every((value) => Number.isFinite(value) && value >= 0) ||
    (section.valid && section.valid.length !== columns * rows)
  )
    throw new Error('Invalid golden source grid.');
  const rings = [...section.polygons, ...(section.holes ?? []), ...(section.uncertainPolygons ?? [])];
  for (const ring of rings) {
    if (
      ring.length < 3 ||
      !ring.every((point) => point.length === 2 && point.every(Number.isFinite)) ||
      Math.abs(ringSegments(ring).reduce((sum, [a, b]) => sum + cross(a, b), 0)) < 1e-9
    )
      throw new Error('Golden polygons need finite, nondegenerate closed boundaries.');
  }
  const mm = (point: GoldenPoint): GoldenPoint => [point[0] * spacingMm[0], point[1] * spacingMm[1]];
  const polygons = section.polygons.map((ring) => ring.map(mm));
  const holes = (section.holes ?? []).map((ring) => ring.map(mm));
  const uncertain = (section.uncertainPolygons ?? []).map((ring) => ring.map(mm));
  const contains = (point: GoldenPoint) =>
    polygons.some((ring) => insideRing(point, ring)) && !holes.some((ring) => insideRing(point, ring));
  const boundary = unionBoundary(polygons, holes);
  const vertices = section.polygons.flat();
  if (!vertices.length && !section.auditBounds)
    throw new Error('An empty target needs an explicitly reviewed audit region.');
  const bounds = section.auditBounds ?? {
    min: [0, 1].map(
      (axis) => Math.min(...vertices.map((point) => point[axis]!)) - section.auditMarginMm / spacingMm[axis]!,
    ) as unknown as GoldenPoint,
    max: [0, 1].map(
      (axis) => Math.max(...vertices.map((point) => point[axis]!)) + section.auditMarginMm / spacingMm[axis]!,
    ) as unknown as GoldenPoint,
  };
  if (
    !bounds.min.every(Number.isFinite) ||
    !bounds.max.every(Number.isFinite) ||
    bounds.min.some((value, axis) => value >= bounds.max[axis]!)
  )
    throw new Error('Invalid golden audit bounds.');
  const target = new Uint8Array(columns * rows),
    confidence = new Uint8Array(target.length),
    audit = new Uint8Array(target.length),
    explicitUnknown = new Uint8Array(target.length);
  let unsupported = 0,
    explicitUncertainty = 0,
    boundaryUncertainty = 0;
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      const grid: GoldenPoint = [origin[0] + column, origin[1] + row],
        point = mm(grid);
      audit[index] = Number(grid.every((value, axis) => value >= bounds.min[axis]! && value <= bounds.max[axis]!));
      target[index] = Number(contains(point));
      if (section.valid && !section.valid[index]) {
        unsupported++;
        continue;
      }
      if (
        uncertain.some(
          (ring) => insideRing(point, ring) || ringSegments(ring).some((edge) => distanceToSegment(point, edge) < 1e-8),
        )
      ) {
        explicitUnknown[index] = 1;
        explicitUncertainty++;
        continue;
      }
      const distance = boundary.reduce((minimum, edge) => Math.min(minimum, distanceToSegment(point, edge)), Infinity);
      if (distance <= section.boundaryUncertaintyMm + 1e-8) {
        boundaryUncertainty++;
        continue;
      }
      confidence[index] = target[index] ? 1 : 2;
    }
  const unscorable = section.polygons.length
    ? confidence.some((value) => value === 1)
      ? null
      : 'unscorable positive reference: no confident acquired interior'
    : confidence.some((value, index) => value === 2 && audit[index])
      ? null
      : 'unscorable negative reference: no confident acquired audited exterior';
  return {
    section,
    target,
    confidence,
    audit,
    explicitUnknown,
    boundary,
    uncertain,
    unscorable,
    auditBounds: bounds,
    excluded: { unsupported, explicitUncertainty, boundaryUncertainty },
  };
}

const ratio = (numerator: number, denominator: number) => (denominator ? numerator / denominator : null);
const metrics = (truePositive: number, falsePositive: number, falseNegative: number, trueNegative: number) => ({
  truePositive,
  falsePositive,
  falseNegative,
  trueNegative,
  precision: ratio(truePositive, truePositive + falsePositive),
  recall: ratio(truePositive, truePositive + falseNegative),
  specificity: ratio(trueNegative, trueNegative + falsePositive),
  dice: ratio(2 * truePositive, 2 * truePositive + falsePositive + falseNegative),
  iou: ratio(truePositive, truePositive + falsePositive + falseNegative),
});

/** Keep existing contour pieces only; missing data and semantic unknowns cannot create closing anatomy edges. */
function knownBoundary(edges: readonly Segment[], golden: ReturnType<typeof rasterizeGoldenSection>): Segment[] {
  const { columns, rows, origin, spacingMm, valid } = golden.section;
  const dimensions = [columns, rows];
  const unknownEdges = golden.uncertain.flatMap(ringSegments);
  const known = (point: GoldenPoint) => {
    const x = Math.floor(point[0] / spacingMm[0] - origin[0] + 0.5);
    const y = Math.floor(point[1] / spacingMm[1] - origin[1] + 0.5);
    return (
      x >= 0 &&
      y >= 0 &&
      x < columns &&
      y < rows &&
      (!valid || Boolean(valid[y * columns + x])) &&
      !golden.uncertain.some((ring) => insideRing(point, ring))
    );
  };
  const visible: Segment[] = [];
  for (const edge of edges) {
    const [a, b] = edge,
      delta = subtract(b, a);
    const squaredLength = delta[0] ** 2 + delta[1] ** 2;
    if (!squaredLength) continue;
    const cuts = [0, 1];
    const add = (t: number) => {
      if (t > 0 && t < 1) cuts.push(t);
    };
    for (const axis of [0, 1] as const) {
      if (!delta[axis]) continue;
      // Cell-face intersections make support classification constant within each piece.
      const first = Math.max(0, Math.ceil(Math.min(a[axis], b[axis]) / spacingMm[axis] - origin[axis] + 0.5));
      const last = Math.min(
        dimensions[axis]!,
        Math.floor(Math.max(a[axis], b[axis]) / spacingMm[axis] - origin[axis] + 0.5),
      );
      for (let face = first; face <= last; face++)
        add(((origin[axis] + face - 0.5) * spacingMm[axis] - a[axis]) / delta[axis]);
    }
    for (const [c, d] of unknownEdges) {
      const other = subtract(d, c),
        offset = subtract(c, a),
        divisor = cross(delta, other);
      if (Math.abs(divisor) > 1e-10) {
        const t = cross(offset, other) / divisor,
          u = cross(offset, delta) / divisor;
        if (u >= 0 && u <= 1) add(t);
      } else if (Math.abs(cross(offset, delta)) < 1e-10) {
        for (const point of [c, d]) {
          const projected = subtract(point, a);
          add((projected[0] * delta[0] + projected[1] * delta[1]) / squaredLength);
        }
      }
    }
    cuts.sort((first, last) => first - last);
    const intervals: Array<[number, number]> = [];
    const epsilon = (Math.min(...spacingMm) * 1e-7) / Math.sqrt(squaredLength);
    for (let index = 1; index < cuts.length; index++) {
      const lower = cuts[index - 1]!,
        upper = cuts[index]!;
      if (upper - lower < 1e-10) continue;
      const midpoint = along(edge, (lower + upper) / 2);
      if (
        !known([midpoint[0] - delta[1] * epsilon, midpoint[1] + delta[0] * epsilon]) ||
        !known([midpoint[0] + delta[1] * epsilon, midpoint[1] - delta[0] * epsilon])
      )
        continue;
      const last = intervals.at(-1);
      // Preserve the original sampling of an uninterrupted, fully acquired contour.
      if (last && Math.abs(last[1] - lower) < 1e-10) last[1] = upper;
      else intervals.push([lower, upper]);
    }
    for (const [first, last] of intervals) visible.push([along(edge, first), along(edge, last)]);
  }
  return visible;
}

export function evaluateGoldenSection(golden: ReturnType<typeof rasterizeGoldenSection>, mask: Uint8Array) {
  if (mask.length !== golden.target.length || mask.some((value) => value !== 0 && value !== 1))
    throw new Error('Candidate mask must be binary and match the golden source grid.');
  const { section } = golden,
    { columns, rows, origin, spacingMm } = section;
  const full = [0, 0, 0, 0],
    tight = [0, 0, 0, 0];
  let outsideAuditSelected = 0,
    outsideAuditDefiniteSelected = 0,
    unsupportedSelected = 0,
    selectedUncertain = 0,
    selectedExplicitUncertainty = 0;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] && section.valid && !section.valid[index]) unsupportedSelected++;
    if (mask[index] && !golden.audit[index]) outsideAuditSelected++;
    const confidence = golden.confidence[index];
    if (mask[index] && !golden.audit[index] && confidence === 2) outsideAuditDefiniteSelected++;
    if (mask[index] && golden.explicitUnknown[index]) selectedExplicitUncertainty++;
    if (!confidence) {
      selectedUncertain += Number(Boolean(mask[index]));
      continue;
    }
    const position = confidence === 1 ? (mask[index] ? 0 : 2) : mask[index] ? 1 : 3;
    full[position]!++;
    if (golden.audit[index]) tight[position]!++;
  }
  const candidateBoundary: Segment[] = [];
  const mm = (x: number, y: number): GoldenPoint => [(origin[0] + x) * spacingMm[0], (origin[1] + y) * spacingMm[1]];
  const selected = (x: number, y: number) => x >= 0 && y >= 0 && x < columns && y < rows && mask[y * columns + x] === 1;
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < columns; col++)
      if (selected(col, row)) {
        if (!selected(col - 1, row)) candidateBoundary.push([mm(col - 0.5, row - 0.5), mm(col - 0.5, row + 0.5)]);
        if (!selected(col + 1, row)) candidateBoundary.push([mm(col + 0.5, row - 0.5), mm(col + 0.5, row + 0.5)]);
        if (!selected(col, row - 1)) candidateBoundary.push([mm(col - 0.5, row - 0.5), mm(col + 0.5, row - 0.5)]);
        if (!selected(col, row + 1)) candidateBoundary.push([mm(col - 0.5, row + 0.5), mm(col + 0.5, row + 0.5)]);
      }
  const distances: number[] = [];
  const sampleBoundary = (from: readonly Segment[], to: readonly Segment[]) => {
    if (!to.length) return;
    for (const edge of from) {
      const length = Math.hypot(edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]);
      const count = Math.max(1, Math.ceil(length / (Math.min(...spacingMm) / 2)));
      for (let index = 0; index < count; index++) {
        const point = along(edge, (index + 0.5) / count);
        distances.push(to.reduce((minimum, other) => Math.min(minimum, distanceToSegment(point, other)), Infinity));
      }
    }
  };
  // The positional uncertainty band does not erase the contour being measured.
  // Only semantic unknowns and unavailable source coverage are excluded, in both directions.
  const knownCandidate = knownBoundary(candidateBoundary, golden);
  const knownReference = knownBoundary(golden.boundary, golden);
  sampleBoundary(knownCandidate, knownReference);
  sampleBoundary(knownReference, knownCandidate);
  distances.sort((first, last) => first - last);
  const values = (counts: number[]) => metrics(counts[0]!, counts[1]!, counts[2]!, counts[3]!);
  return {
    full: values(full),
    tight: values(tight),
    selected: mask.reduce((sum, value) => sum + value, 0),
    outsideAuditSelected,
    outsideAuditDefiniteSelected,
    unsupportedSelected,
    selectedUncertain,
    selectedExplicitUncertainty,
    excluded: { ...golden.excluded },
    unscorable: golden.unscorable,
    areaMm2PerPixel: spacingMm[0] * spacingMm[1],
    boundaryMm: {
      samples: distances.length,
      mean: ratio(
        distances.reduce((sum, value) => sum + value, 0),
        distances.length,
      ),
      p95: distances[Math.floor((distances.length - 1) * 0.95)] ?? null,
      maximum: distances.at(-1) ?? null,
    },
  };
}

/** Per-section absolute gate; macro/pooled averages never hide a failing section or an exterior island. */
export function goldenSectionFailures(result: ReturnType<typeof evaluateGoldenSection>, minimum = 0.97) {
  const failures: string[] = [];
  if (result.unscorable) failures.push(result.unscorable);
  if (result.full.truePositive + result.full.falseNegative > 0 && (result.full.recall ?? 0) < minimum)
    failures.push('definite-inside recall');
  if (
    (result.full.truePositive + result.full.falsePositive > 0 || result.full.falseNegative > 0) &&
    (result.full.precision ?? 0) < minimum
  )
    failures.push('full-section confident precision');
  if (result.tight.specificity !== null && result.tight.specificity < minimum)
    failures.push('audited definite-outside specificity');
  if (result.outsideAuditDefiniteSelected) failures.push('selection beyond the frozen audit region');
  if (result.unsupportedSelected) failures.push('selected unavailable source samples');
  return failures;
}

export type GoldenVolumeSection = {
  id: string;
  sourceGrid: string;
  fixedAxis: 0 | 1 | 2;
  fixedIndex: number;
  acrossAxis: 0 | 1 | 2;
  verticalAxis: 0 | 1 | 2;
  golden: ReturnType<typeof rasterizeGoldenSection>;
};

/** Contradictory confident labels invalidate the benchmark before any solver is evaluated. */
export function goldenCrossPlaneConflicts(sections: readonly GoldenVolumeSection[]) {
  const bounded = sections.map((section) => {
    const { fixedAxis, acrossAxis, verticalAxis, fixedIndex, golden } = section;
    if (
      !section.sourceGrid ||
      new Set([fixedAxis, acrossAxis, verticalAxis]).size !== 3 ||
      ![fixedIndex, ...golden.section.origin].every(Number.isSafeInteger)
    )
      throw new Error('Cross-plane labels need exact coordinates in one named source grid.');
    const min = [0, 0, 0],
      max = [0, 0, 0];
    min[fixedAxis] = max[fixedAxis] = fixedIndex;
    min[acrossAxis] = golden.section.origin[0];
    max[acrossAxis] = min[acrossAxis]! + golden.section.columns - 1;
    min[verticalAxis] = golden.section.origin[1];
    max[verticalAxis] = min[verticalAxis]! + golden.section.rows - 1;
    return { ...section, min, max };
  });
  const conflicts: {
    first: string;
    second: string;
    sourceGrid: string;
    voxel: [number, number, number];
    firstLabel: number;
    secondLabel: number;
  }[] = [];
  const confidence = (section: (typeof bounded)[number], voxel: readonly number[]) =>
    section.golden.confidence[
      (voxel[section.verticalAxis]! - section.min[section.verticalAxis]!) * section.golden.section.columns +
        voxel[section.acrossAxis]! -
        section.min[section.acrossAxis]!
    ];
  for (let first = 0; first < bounded.length; first++)
    for (let second = first + 1; second < bounded.length; second++) {
      const a = bounded[first]!,
        b = bounded[second]!;
      if (a.sourceGrid !== b.sourceGrid) continue;
      const lower = a.min.map((value, axis) => Math.max(value, b.min[axis]!));
      const upper = a.max.map((value, axis) => Math.min(value, b.max[axis]!));
      for (let z = lower[2]!; z <= upper[2]!; z++)
        for (let y = lower[1]!; y <= upper[1]!; y++)
          for (let x = lower[0]!; x <= upper[0]!; x++) {
            const voxel: [number, number, number] = [x, y, z];
            const firstLabel = confidence(a, voxel)!,
              secondLabel = confidence(b, voxel)!;
            if (firstLabel && secondLabel && firstLabel !== secondLabel)
              conflicts.push({ first: a.id, second: b.id, sourceGrid: a.sourceGrid, voxel, firstLabel, secondLabel });
          }
    }
  return conflicts;
}
