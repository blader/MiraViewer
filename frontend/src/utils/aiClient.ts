export type AiSeriesContext = {
  plane?: string | null;
  weight?: string | null;
  sequence?: string | null;
  label?: string | null;
};

type GenerateContentPart =
  | { text: string }
  | {
      inlineData: {
        mimeType: string;
        data: string; // base64 (no data: prefix)
      };
    };

type GenerateContentRequest = {
  contents: Array<{
    parts: GenerateContentPart[];
  }>;
  generationConfig?: Record<string, unknown>;
};

type GenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
      }>;
    };
  }>;
};

export type AiClientAnnotateResult = {
  blob: Blob;
  mimeType: string;
  analysisText: string;
  nanoBananaPrompt: string;
};

function getGoogleApiKey(): string | null {
  const key =
    import.meta.env.VITE_GOOGLE_API_KEY ||
    import.meta.env.VITE_GEMINI_API_KEY ||
    import.meta.env.GOOGLE_API_KEY ||
    import.meta.env.GEMINI_API_KEY;
  return key && typeof key === 'string' && key.trim() ? key.trim() : null;
}

function normalizeModelName(model: string): string {
  const m = (model || '').trim();
  return m.startsWith('models/') ? m.slice('models/'.length) : m;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function extractTextResponse(raw: GenerateContentResponse): string {
  const candidates = raw.candidates || [];
  const texts: string[] = [];
  for (const cand of candidates) {
    const parts = cand.content?.parts || [];
    for (const part of parts) {
      if (part.text) {
        texts.push(part.text);
      }
    }
  }
  return texts.join('\n').trim();
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Best-effort extraction if the model wraps JSON in extra prose.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractInlineDataImage(raw: GenerateContentResponse): { mimeType: string; data: string } | null {
  const candidates = raw.candidates || [];
  for (const cand of candidates) {
    const parts = cand.content?.parts || [];
    for (const part of parts) {
      const inline = part.inlineData;
      if (inline?.data) {
        return {
          mimeType: inline.mimeType || 'image/png',
          data: inline.data,
        };
      }
    }
  }
  return null;
}

function buildAcpAnalysisPrompt(opts: {
  seriesContext: AiSeriesContext;
}): string {
  const { seriesContext } = opts;

  const contextLines: string[] = [];
  if (seriesContext.plane) contextLines.push(`- Plane: ${seriesContext.plane}`);
  if (seriesContext.weight) contextLines.push(`- Weighting: ${seriesContext.weight}`);
  if (seriesContext.sequence) contextLines.push(`- Sequence: ${seriesContext.sequence}`);
  if (seriesContext.label) contextLines.push(`- Label: ${seriesContext.label}`);

  const contextBlock = contextLines.length ? contextLines.join('\n') : '(none)';

  return (
    'You are analyzing a single MRI brain slice image.\n'
    + 'The provided image is a capture of the viewer viewport (it may already include zoom/rotation/pan, brightness/contrast adjustments, and cropping to what is visible in the cell). The capture is capped at ~512 px on its longest side for speed; keep output around this resolution (≈512 px max dimension).\n\n'
    + 'Series context (use as a hint; if metadata conflicts with image appearance, trust the image):\n'
    + contextBlock
    + '\n\n'
    + 'Your goal is to help an image-editing model (Nano Banana Pro) create a subtle, clinically legible overlay annotation focused on ACP (Adamantinomatous Craniopharyngioma) / craniopharyngioma-related findings in the sellar/suprasellar region.\n\n'
    + 'Prioritize assessment of tumor impact on critical/eloquent structures when visible: pituitary gland, pituitary stalk, hypothalamus, optic chiasm, optic nerves/tracts, third ventricle floor, cavernous sinus and adjacent internal carotid arteries. Describe mass effect, displacement, compression, encasement, or effacement, and explicitly state uncertainty when needed.\n\n'
    + 'Return ONLY valid JSON (no markdown, no code fences) with these keys:\n'
    + '- detailed_description: a detailed description of what is visible in the slice (sequence/orientation if inferable, key anatomy, and the series context if relevant)\n'
    + '- suspected_findings: any possible findings suggestive of craniopharyngioma/ACP (e.g., cystic components, solid nodules, calcification/hemorrhage cues), but be explicit about uncertainty\n'
    + '- segmentation_guide: step-by-step segmentation and annotation guidance. Make it EXTREMELY SPECIFIC, VISUAL, AND LAYPERSON-FRIENDLY so a non-clinical image editor can place overlays correctly: describe concrete 2D locations on the visible slice using relative screen positions (top/bottom/left/right/center, anterior/posterior if inferable), shapes (round/ovoid/lobulated), sizes (small/moderate/large relative to the visible brain), and colors to use. Name landmarks on the screen in plain visual terms (e.g., "bright round spot near the lower center", "darker curved band above the bright spot") and tell exactly where to draw outlines and labels. Include how to distinguish cystic vs solid components and how to mark calcification/hemorrhage cues when visible. Also include guidance for assessing/marking involvement of critical structures with explicit on-screen placement instructions (describe their visible appearance/brightness/position instead of medical jargon).\\n'
    + '- nano_banana_prompt: a single prompt string to send to Nano Banana Pro. It MUST: '
    + '(1) explicitly mention \'Adamantinomatous Craniopharyngioma (ACP)\' and must NOT refer to the anterior clinoid process; '
    + '(2) assume the image editor has minimal MRI/medical knowledge: include highly visual, layperson localizing instructions (where on the visible image to look: top/bottom/left/right/center, anterior/posterior if inferable, relative to bright/dark landmarks); '
    + '(3) include explicit segmentation instructions (what boundaries/components to outline) with on-screen placement cues (e.g., "draw a thin cyan outline around the bright cystic area just above the lower-center bright spot; place its label just above and to the right, outside the outline"); '
    + '(4) ALWAYS include labeling instructions: add small text labels (at least 2 labels) with arrows/leader lines, even if findings are subtle or absent; '
    + '(5) for every label, include a concise clinical-impact annotation in a smaller font beneath the label (e.g., mass effect direction/degree, compression/encasement, obstruction risk, cystic vs solid, uncertainty); '
    + '(6) if visible/relevant, label critical structures (pituitary stalk, optic chiasm, hypothalamus, third ventricle) and indicate any displacement/compression; '
    + '(7) use separate outlines/contours for each element/component (do not merge into one outline) and use DISTINCT COLORS per element (e.g., tumor boundary vs cystic component vs solid nodule vs calcification markers vs critical structures); '
    + '(8) keep the output image around 512 px on its longest side (match input aspect as best you can); '
    + '(9) request ONLY the edited/annotated image as output.\n\n'
    + 'Constraints:\n'
    + '- Do not hallucinate anatomy: only label structures you can reasonably localize on the slice; if uncertain, say so.\n'
    + '- Keep annotations subtle: thin outlines, small labels, avoid obscuring anatomy.\n'
  );
}

function enforceNanoBananaPrompt(prompt: string): string {
  let p = (prompt || '').trim();
  if (!p) {
    return p;
  }

  let lc = p.toLowerCase();

  // Ensure ACP is unambiguous.
  if (!lc.includes('craniopharyngioma') && !lc.includes('adamantinomatous')) {
    p = `Focus on ACP (adamantinomatous craniopharyngioma) / craniopharyngioma findings. ${p}`;
    lc = p.toLowerCase();
  }

  // Always require labels.
  if (!lc.includes('label')) {
    p =
      "Always add small text labels (at least 2) with arrows/leader lines (e.g., 'Cystic component', 'Solid nodule', 'Calcification' if visible). " +
      p;
    lc = p.toLowerCase();
  }

  // Require concise clinical-impact annotation under each label (small font).
  if (!lc.includes('annotation') && !lc.includes('clinical')) {
    p =
      'Add a concise clinical-impact annotation in a smaller font beneath each label (e.g., direction/degree of displacement/compression/encasement, obstruction risk, cystic vs solid, or uncertainty). ' +
      p;
    lc = p.toLowerCase();
  }

  // Encourage localizing guidance.
  if (!lc.includes('sella') && !lc.includes('suprasellar') && !lc.includes('optic')) {
    p =
      'Localize using landmarks: midline sellar/suprasellar region (sella turcica/pituitary fossa), pituitary stalk, optic chiasm. ' +
      p;
    lc = p.toLowerCase();
  }

  // Encourage explicit mention of critical structures.
  if (!lc.includes('pituitary') && !lc.includes('stalk') && !lc.includes('optic') && !lc.includes('chiasm') && !lc.includes('hypothalam')) {
    p =
      'If visible/relevant, label critical structures (pituitary stalk, optic chiasm, hypothalamus) and indicate any displacement/compression. ' +
      p;
    lc = p.toLowerCase();
  }

  // Encourage separate, color-coded outlines.
  const colorOk = lc.includes('color') || lc.includes('colour');
  const separateOk = lc.includes('separate') || lc.includes('distinct') || lc.includes('different');
  const outlineOk = lc.includes('outline') || lc.includes('contour') || lc.includes('boundary');
  if (!(colorOk && separateOk && outlineOk)) {
    p =
      'Use separate outlines/contours for each element/component and use DISTINCT COLORS per element (do not merge into one outline). '
      + 'For example: tumor boundary = cyan, cystic component = magenta, solid component = orange, calcification markers = yellow, critical structures = green. '
      + 'Add matching labels with leader lines for each element. '
      + p;
  }

  return p;
}

async function callGenerateContent(params: {
  apiKey: string;
  model: string;
  request: GenerateContentRequest;
  timeoutMs?: number;
}): Promise<GenerateContentResponse> {
  const model = normalizeModelName(params.model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(params.apiKey)}`;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), params.timeoutMs ?? 120_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params.request),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const details = text ? `: ${text}` : '';
      throw new Error(`AI request failed (${res.status})${details}`);
    }

    return (await res.json()) as GenerateContentResponse;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function runAcpAnnotateClient(params: {
  imageBase64: string;
  imageMimeType: string;
  seriesContext: AiSeriesContext;
  analysisModel?: string;
  nanoBananaModel?: string;
  onProgress?: (text: string) => void;
}): Promise<AiClientAnnotateResult> {
  const apiKey = getGoogleApiKey();
  if (!apiKey) {
    throw new Error(
      'AI API key not configured for the frontend. Set GOOGLE_API_KEY (from your shell) or VITE_GOOGLE_API_KEY (from a Vite .env file) in the frontend dev server environment.'
    );
  }

  const analysisModel = params.analysisModel || import.meta.env.VITE_GEMINI_ANALYSIS_MODEL || 'gemini-3-pro-preview';
  const nanoBananaModel = params.nanoBananaModel || import.meta.env.VITE_NANO_BANANA_PRO_MODEL || 'nano-banana-pro-preview';

  const analysisPrompt = buildAcpAnalysisPrompt({ seriesContext: params.seriesContext });

  params.onProgress?.('Gemini analyzing…');
  const analysisRaw = await callGenerateContent({
    apiKey,
    model: analysisModel,
    request: {
      contents: [
        {
          parts: [
            { text: analysisPrompt },
            {
              inlineData: {
                mimeType: params.imageMimeType,
                data: params.imageBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
      },
    },
  });

  params.onProgress?.('Parsing analysis…');
  const analysisText = extractTextResponse(analysisRaw);
  if (!analysisText) {
    throw new Error('Gemini analysis returned no text');
  }

  const analysisObj = tryParseJsonObject(analysisText);

  let nanoBananaPrompt: string;
  const extracted = analysisObj?.nano_banana_prompt;
  if (typeof extracted === 'string' && extracted.trim()) {
    nanoBananaPrompt = extracted.trim();
  } else {
    nanoBananaPrompt =
      'Analyze this MRI slice for ACP (adamantinomatous craniopharyngioma) / craniopharyngioma-related findings. '
      + 'If a lesion is suspected, segment the tumor boundary and visible components (cystic vs solid, calcification foci if visible). '
      + 'Outline each element separately with distinct colors (do not merge into one outline): e.g., tumor boundary vs cystic component vs solid nodule vs calcification markers vs critical structures. Provide explicit visual placement cues for each outline and label (e.g., "draw a thin cyan outline around the bright cystic area just above the lower-center bright spot; place its label just above and to the right, outside the outline"). '
      + 'Add subtle outlines and small text labels with arrows/leader lines for each element, and include a concise clinical-impact annotation in a smaller font beneath each label (e.g., direction/degree of mass effect, compression/encasement, cystic vs solid, obstruction risk, or uncertainty). '
      + 'If visible or relevant, label critical structures (pituitary stalk, optic chiasm, hypothalamus, third ventricle) and indicate displacement/compression. '
      + 'If no lesion is evident, add a small note indicating no clear ACP lesion on this slice, and still label at least two relevant anatomical landmarks if visible (each with distinct color/outline). '
      + 'Keep the output image around 512 px on its longest side (match input aspect as best you can). '
      + 'Return only the edited/annotated image.';
  }

  nanoBananaPrompt = enforceNanoBananaPrompt(nanoBananaPrompt);

  params.onProgress?.('Nano Banana generating…');
  const imgRaw = await callGenerateContent({
    apiKey,
    model: nanoBananaModel,
    request: {
      contents: [
        {
          parts: [
            { text: nanoBananaPrompt },
            {
              inlineData: {
                mimeType: params.imageMimeType,
                data: params.imageBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    },
  });

  const inline = extractInlineDataImage(imgRaw);
  if (!inline) {
    throw new Error('Nano Banana Pro did not return an image');
  }

  const blob = base64ToBlob(inline.data, inline.mimeType);

  return {
    blob,
    mimeType: inline.mimeType,
    analysisText,
    nanoBananaPrompt,
  };
}
