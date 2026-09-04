export type SyntheticSvrFixtureOptions = {
  imageSize?: number;
  slicesPerOrientation?: number;
  orientations?: 1 | 2 | 3;
  studyUid?: string;
  studyDate?: string;
  seriesNumberOffset?: number;
  transferSyntax?: 'explicit-vr-le' | 'rle';
  /** Null makes zero-valued background acquired data instead of DICOM padding. */
  pixelPaddingValue?: number | null;
};

type SyntheticOrientation = {
  label: string;
  orientation: string;
  position: (slice: number) => [number, number, number];
  point: (row: number, column: number, slice: number) => [number, number, number];
};

const SYNTHETIC_ORIENTATIONS: SyntheticOrientation[] = [
  {
    label: 'Axial',
    orientation: '1\\0\\0\\0\\1\\0',
    position: (slice) => [0, 0, slice],
    point: (row, column, slice) => [column, row, slice],
  },
  {
    label: 'Coronal',
    orientation: '1\\0\\0\\0\\0\\1',
    position: (slice) => [0, slice, 0],
    point: (row, column, slice) => [column, slice, row],
  },
  {
    label: 'Sagittal',
    orientation: '0\\1\\0\\0\\0\\1',
    position: (slice) => [slice, 0, 0],
    point: (row, column, slice) => [slice, column, row],
  },
];

const LONG_VALUE_REPRESENTATIONS = new Set(['OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT']);

/**
 * Genuine explicit-VR DICOM fixtures, optionally RLE-encapsulated, for real-browser SVR.
 *
 * Every value and image pixel is synthetic; these files contain no patient data.
 */
export function createSyntheticSvrDicomFiles(options: SyntheticSvrFixtureOptions = {}): File[] {
  const size = options.imageSize ?? 36;
  const sliceCount = options.slicesPerOrientation ?? 24;
  const orientationCount = options.orientations ?? 3;
  const studyUid = options.studyUid ?? '1.2.826.0.1.3680043.10.543.20350701.1';
  const frameUid = studyUid + '.999';
  const encoder = new TextEncoder();
  const files: File[] = [];

  const uint16 = (value: number): number[] => [value & 255, (value >>> 8) & 255];
  const uint32 = (value: number): number[] => [
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255,
  ];
  const text = (value: string, vr: string): number[] => {
    const bytes = Array.from(encoder.encode(value));
    if (bytes.length % 2) bytes.push(vr === 'UI' ? 0 : 32);
    return bytes;
  };
  const element = (
    group: number,
    tag: number,
    vr: string,
    value: number[] | Uint8Array,
    undefinedLength = false,
  ): number[] => {
    const bytes = Array.from(value);
    return [
      ...uint16(group),
      ...uint16(tag),
      ...encoder.encode(vr),
      ...(LONG_VALUE_REPRESENTATIONS.has(vr)
        ? [0, 0, ...uint32(undefinedLength ? 0xffffffff : bytes.length)]
        : uint16(bytes.length)),
      ...bytes,
    ];
  };
  const encodeRle = (pixels: Uint8Array): number[] => {
    // DICOM RLE stores most-significant byte planes first; packets never cross a row.
    const segments = [1, 0].map((byte) => {
      const encoded: number[] = [];
      for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; ) {
          const value = pixels[(row * size + column) * 2 + byte]!;
          let run = 1;
          while (run < 128 && column + run < size && pixels[(row * size + column + run) * 2 + byte] === value) run++;
          encoded.push(run === 1 ? 0 : 257 - run, value);
          column += run;
        }
      }
      if (encoded.length % 2) encoded.push(128);
      return encoded;
    });
    const frame = [
      ...uint32(2),
      ...uint32(64),
      ...uint32(64 + segments[0]!.length),
      ...new Uint8Array(52),
      ...segments[0]!,
      ...segments[1]!,
    ];
    return [
      ...uint16(0xfffe),
      ...uint16(0xe000),
      ...uint32(0),
      ...uint16(0xfffe),
      ...uint16(0xe000),
      ...uint32(frame.length),
      ...frame,
      ...uint16(0xfffe),
      ...uint16(0xe0dd),
      ...uint32(0),
    ];
  };

  for (let orientationIndex = 0; orientationIndex < orientationCount; orientationIndex++) {
    const orientation = SYNTHETIC_ORIENTATIONS[orientationIndex]!;
    const seriesNumber = (options.seriesNumberOffset ?? 0) + orientationIndex + 1;
    const seriesUid = studyUid + '.' + seriesNumber;

    for (let slice = 0; slice < sliceCount; slice++) {
      const sopUid = seriesUid + '.' + (slice + 1);
      const pixels = new Uint8Array(size * size * Uint16Array.BYTES_PER_ELEMENT);
      const view = new DataView(pixels.buffer);

      for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
          const [x, y, z] = orientation.point(row, column, slice);
          const center = size * 0.47;
          const rx = (x - center) / (size * 0.38);
          const ry = (y - center) / (size * 0.34);
          const rz = (z - center) / (Math.max(size, sliceCount) * 0.34);
          const radius = rx * rx + ry * ry + rz * rz;
          let intensity = radius < 1 ? Math.round(260 + (1 - radius) * 400) : 0;
          if ((x - center + 4) ** 2 + (y - center - 3) ** 2 + (z - center) ** 2 < 9) {
            intensity = 1100;
          }
          view.setUint16((row * size + column) * 2, intensity, true);
        }
      }

      const media = [
        ...element(0x0002, 0x0001, 'OB', [0, 1]),
        ...element(0x0002, 0x0002, 'UI', text('1.2.840.10008.5.1.4.1.1.4', 'UI')),
        ...element(0x0002, 0x0003, 'UI', text(sopUid, 'UI')),
        ...element(
          0x0002,
          0x0010,
          'UI',
          text(options.transferSyntax === 'rle' ? '1.2.840.10008.1.2.5' : '1.2.840.10008.1.2.1', 'UI'),
        ),
      ];
      const dataset = [
        ...element(0x0008, 0x0008, 'CS', text('ORIGINAL\\PRIMARY', 'CS')),
        ...element(0x0008, 0x0016, 'UI', text('1.2.840.10008.5.1.4.1.1.4', 'UI')),
        ...element(0x0008, 0x0018, 'UI', text(sopUid, 'UI')),
        ...element(0x0008, 0x0020, 'DA', text(options.studyDate ?? '20350701', 'DA')),
        ...element(0x0008, 0x0030, 'TM', text('120000', 'TM')),
        ...element(0x0008, 0x0060, 'CS', text('MR', 'CS')),
        ...element(0x0008, 0x1030, 'LO', text('SYNTHETIC SVR VALIDATION ONLY', 'LO')),
        ...element(0x0008, 0x103e, 'LO', text(orientation.label + ' T2 FLAIR', 'LO')),
        ...element(0x0010, 0x0010, 'PN', text('SYNTHETIC^SVR^NO^PATIENT^DATA', 'PN')),
        ...element(0x0010, 0x0020, 'LO', text('SVR-SYNTHETIC-ONLY', 'LO')),
        ...element(0x0018, 0x0050, 'DS', text('1', 'DS')),
        ...element(0x0018, 0x0088, 'DS', text('1', 'DS')),
        ...element(0x0020, 0x000d, 'UI', text(studyUid, 'UI')),
        ...element(0x0020, 0x000e, 'UI', text(seriesUid, 'UI')),
        ...element(0x0020, 0x0011, 'IS', text(String(seriesNumber), 'IS')),
        ...element(0x0020, 0x0013, 'IS', text(String(slice + 1), 'IS')),
        ...element(0x0020, 0x0032, 'DS', text(orientation.position(slice).join('\\'), 'DS')),
        ...element(0x0020, 0x0037, 'DS', text(orientation.orientation, 'DS')),
        ...element(0x0020, 0x0052, 'UI', text(frameUid, 'UI')),
        ...element(0x0020, 0x1041, 'DS', text(String(slice), 'DS')),
        ...element(0x0028, 0x0002, 'US', uint16(1)),
        ...element(0x0028, 0x0004, 'CS', text('MONOCHROME2', 'CS')),
        ...element(0x0028, 0x0010, 'US', uint16(size)),
        ...element(0x0028, 0x0011, 'US', uint16(size)),
        ...element(0x0028, 0x0030, 'DS', text('1\\1', 'DS')),
        ...element(0x0028, 0x0100, 'US', uint16(16)),
        ...element(0x0028, 0x0101, 'US', uint16(16)),
        ...element(0x0028, 0x0102, 'US', uint16(15)),
        ...element(0x0028, 0x0103, 'US', uint16(0)),
        ...(options.pixelPaddingValue === null
          ? []
          : element(0x0028, 0x0120, 'US', uint16(options.pixelPaddingValue ?? 0))),
        ...element(0x0028, 0x1050, 'DS', text('500', 'DS')),
        ...element(0x0028, 0x1051, 'DS', text('1000', 'DS')),
        ...element(0x0028, 0x1052, 'DS', text('0', 'DS')),
        ...element(0x0028, 0x1053, 'DS', text('1', 'DS')),
        ...(options.transferSyntax === 'rle'
          ? element(0x7fe0, 0x0010, 'OB', encodeRle(pixels), true)
          : element(0x7fe0, 0x0010, 'OW', pixels)),
      ];
      const bytes = new Uint8Array([...new Uint8Array(128), 68, 73, 67, 77, ...media, ...dataset]);
      files.push(
        new File([bytes], 'synthetic-svr-' + orientationIndex + '-' + slice + '.dcm', { type: 'application/dicom' }),
      );
    }
  }

  return files;
}
